//! Record keys, before they are hashed, and the two encodings records use.
//!
//! OpenMLS's own keys and values are written with MDK's `MlsCodec` (postcard),
//! byte for byte as both of MDK's stores write them. MDK's records (groups,
//! messages, welcomes) are written as JSON, the form their types are made for.

use mdk_storage_traits::mls_codec::{GroupDataType, MlsCodec};
use mdk_storage_traits::GroupId;
use nostr::EventId;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::Fault;

/// A group, as every group-scoped key starts: the OpenMLS group id as
/// `MlsCodec` writes it, which is also what OpenMLS's own calls arrive with.
pub(crate) fn gid(group: &GroupId) -> Result<Vec<u8>, Fault> {
    encode(group.inner())
}

/// Every kind of OpenMLS group state.
pub(crate) const GROUP_DATA: [GroupDataType; 10] = [
    GroupDataType::JoinGroupConfig,
    GroupDataType::Tree,
    GroupDataType::InterimTranscriptHash,
    GroupDataType::Context,
    GroupDataType::ConfirmationTag,
    GroupDataType::GroupState,
    GroupDataType::MessageSecrets,
    GroupDataType::ResumptionPskStore,
    GroupDataType::OwnLeafIndex,
    GroupDataType::GroupEpochSecrets,
];

/// The key of one kind of a group's OpenMLS state. The numbers are on disk.
pub(crate) fn group_data(gid: &[u8], kind: GroupDataType) -> Vec<u8> {
    let tag = match kind {
        GroupDataType::JoinGroupConfig => 0u8,
        GroupDataType::Tree => 1,
        GroupDataType::InterimTranscriptHash => 2,
        GroupDataType::Context => 3,
        GroupDataType::ConfirmationTag => 4,
        GroupDataType::GroupState => 5,
        GroupDataType::MessageSecrets => 6,
        GroupDataType::ResumptionPskStore => 7,
        GroupDataType::OwnLeafIndex => 8,
        GroupDataType::GroupEpochSecrets => 9,
    };
    let mut key = gid.to_vec();
    key.push(tag);
    key
}

/// A message's key: its group, then its event id.
pub(crate) fn message(gid: &[u8], id: &EventId) -> Vec<u8> {
    message_raw(gid, id.as_bytes())
}

pub(crate) fn message_raw(gid: &[u8], id: &[u8; 32]) -> Vec<u8> {
    let mut key = gid.to_vec();
    key.extend_from_slice(id);
    key
}

/// The group and event id of a message key.
pub(crate) fn split_message(key: &[u8]) -> Result<(&[u8], [u8; 32]), Fault> {
    let at = key
        .len()
        .checked_sub(32)
        .ok_or_else(|| Fault::new("a message key is too short"))?;
    Ok((&key[..at], event_id(&key[at..])?))
}

/// A key that is exactly an event id.
pub(crate) fn event_id(key: &[u8]) -> Result<[u8; 32], Fault> {
    key.try_into()
        .map_err(|_| Fault::new("a key is not an event id"))
}

/// A snapshot's key: its group, length first, then its name.
pub(crate) fn snapshot(gid: &[u8], name: &str) -> Vec<u8> {
    let mut key = (gid.len() as u32).to_le_bytes().to_vec();
    key.extend_from_slice(gid);
    key.extend_from_slice(name.as_bytes());
    key
}

/// The group and name of a snapshot key.
pub(crate) fn split_snapshot(key: &[u8]) -> Result<(Vec<u8>, String), Fault> {
    let malformed = || Fault::new("a snapshot key is malformed");
    let length: [u8; 4] = key
        .get(..4)
        .and_then(|four| four.try_into().ok())
        .ok_or_else(malformed)?;
    let end = 4 + u32::from_le_bytes(length) as usize;
    let group = key.get(4..end).ok_or_else(malformed)?;
    let name = std::str::from_utf8(&key[end..]).map_err(|_| malformed())?;
    Ok((group.to_vec(), name.to_owned()))
}

/// Whose snapshot a record is, and from when. It heads the record, so an open
/// reads it without decoding the rows.
#[derive(Serialize, Deserialize)]
struct SnapshotHead {
    group: Vec<u8>,
    name: String,
    /// Unix seconds.
    created_at: u64,
}

/// A group's records as a snapshot took them: family, key, payload.
pub(crate) type Rows = Vec<(u8, Vec<u8>, Vec<u8>)>;

/// A snapshot record: `head length (4, LE) || head || rows`.
pub(crate) fn snapshot_payload(
    group: &[u8],
    name: &str,
    created_at: u64,
    rows: &Rows,
) -> Result<zeroize::Zeroizing<Vec<u8>>, Fault> {
    let head = encode(&SnapshotHead {
        group: group.to_vec(),
        name: name.to_owned(),
        created_at,
    })?;
    let rows = zeroize::Zeroizing::new(encode(rows)?);
    let mut payload = zeroize::Zeroizing::new(Vec::with_capacity(4 + head.len() + rows.len()));
    payload.extend_from_slice(&(head.len() as u32).to_le_bytes());
    payload.extend_from_slice(&head);
    payload.extend_from_slice(&rows);
    Ok(payload)
}

fn snapshot_parts(payload: &[u8]) -> Result<(&[u8], &[u8]), Fault> {
    let malformed = || Fault::new("a snapshot record is malformed");
    let length: [u8; 4] = payload
        .get(..4)
        .and_then(|four| four.try_into().ok())
        .ok_or_else(malformed)?;
    let end = 4 + u32::from_le_bytes(length) as usize;
    Ok((payload.get(4..end).ok_or_else(malformed)?, &payload[end..]))
}

/// Whose snapshot a record is, and from when.
pub(crate) fn snapshot_head(payload: &[u8]) -> Result<(Vec<u8>, String, u64), Fault> {
    let head: SnapshotHead = decode(snapshot_parts(payload)?.0)?;
    Ok((head.group, head.name, head.created_at))
}

/// The records a snapshot holds.
pub(crate) fn snapshot_rows(payload: &[u8]) -> Result<Rows, Fault> {
    decode(snapshot_parts(payload)?.1)
}

/// `MlsCodec` (postcard), for OpenMLS's types and this crate's own lists.
pub(crate) fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, Fault> {
    MlsCodec::serialize(&value).map_err(|error| Fault::new(error.to_string()))
}

pub(crate) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Fault> {
    MlsCodec::deserialize(bytes).map_err(|error| Fault::new(error.to_string()))
}

/// JSON, for MDK's records.
pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, Fault> {
    serde_json::to_vec(value)
        .map_err(|error| Fault::new(format!("a record did not serialize: {error}")))
}

pub(crate) fn from_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Fault> {
    serde_json::from_slice(bytes)
        .map_err(|error| Fault::new(format!("a record did not parse: {error}")))
}
