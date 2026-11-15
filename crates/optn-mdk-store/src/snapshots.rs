//! MDK's provider trait: snapshots of a group before a commit (MIP-03), and
//! deleting a group.
//!
//! A snapshot holds what both of MDK's stores put in one: the group's OpenMLS
//! state, proposals, own leaf nodes and epoch key pairs, and its MDK group
//! record, relays and exporter secrets. Not its messages.

use mdk_storage_traits::groups::types::Group;
use mdk_storage_traits::{Backend, GroupId, MdkStorageError, MdkStorageProvider};

use crate::keys::{self, Rows};
use crate::record::Family;
use crate::{Failed, MdkStore, Outcome, Session};

/// Every record that belongs to a group and nothing else, by family and key.
fn group_records(gid: &[u8]) -> Vec<(Family, Vec<u8>)> {
    let mut records: Vec<(Family, Vec<u8>)> = keys::GROUP_DATA
        .iter()
        .map(|kind| (Family::MlsGroupData, keys::group_data(gid, *kind)))
        .collect();
    for family in [
        Family::MlsOwnLeafNodes,
        Family::MlsProposals,
        Family::MlsEpochKeyPairs,
        Family::Group,
        Family::GroupRelays,
        Family::ExporterSecrets,
    ] {
        records.push((family, gid.to_vec()));
    }
    records
}

fn now() -> Outcome<u64, MdkStorageError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| crate::Fault::new(format!("the clock is before 1970: {error}")))?
        .as_secs())
}

fn delete_snapshot(
    session: &mut Session<'_>,
    gid: &[u8],
    name: &str,
) -> Outcome<(), MdkStorageError> {
    session.delete(Family::Snapshot, &keys::snapshot(gid, name))?;
    Ok(())
}

impl MdkStorageProvider for MdkStore {
    /// MDK treats a store as persistent, and reloads its snapshots after a
    /// restart, only if it says SQLite: MDK 0.8 knows no other persistent
    /// backend. This store is not SQLite, but it is persistent.
    fn backend(&self) -> Backend {
        Backend::SQLite
    }

    fn create_group_snapshot(&self, group_id: &GroupId, name: &str) -> Result<(), MdkStorageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let mut rows: Rows = Vec::new();
            for (family, key) in group_records(&gid) {
                if let Some(payload) = session.get(family, &key)? {
                    rows.push((family as u8, key, payload.to_vec()));
                }
            }
            let payload = keys::snapshot_payload(&gid, name, now()?, &rows);
            for (_, _, payload) in &mut rows {
                zeroize::Zeroize::zeroize(payload);
            }
            session.put(Family::Snapshot, &keys::snapshot(&gid, name), &payload?)?;
            Ok(())
        })
    }

    fn rollback_group_to_snapshot(
        &self,
        group_id: &GroupId,
        name: &str,
    ) -> Result<(), MdkStorageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let Some(payload) = session.get(Family::Snapshot, &keys::snapshot(&gid, name))? else {
                return Err(Failed::Refused(MdkStorageError::NotFound(
                    "Snapshot not found".into(),
                )));
            };
            let mut rows = keys::snapshot_rows(&payload)?;
            // A group's Nostr id is its own (MDK's SQLite store holds it
            // unique). Restoring one another group has taken since would give
            // two groups one id, so that is refused, as SQLite refuses it.
            for (family, _, payload) in &rows {
                if *family == Family::Group as u8 {
                    let group: Group = keys::from_json(payload)?;
                    if let Some(owner) = session.index().by_nostr_id.get(&group.nostr_group_id) {
                        if *owner != gid {
                            return Err(Failed::Refused(MdkStorageError::Database(
                                "nostr_group_id already exists for a different group".into(),
                            )));
                        }
                    }
                }
            }
            for (family, key) in group_records(&gid) {
                session.delete(family, &key)?;
            }
            for (family, key, payload) in &mut rows {
                let family = Family::from_u8(*family)
                    .ok_or_else(|| crate::Fault::new("a snapshot holds an unknown record"))?;
                session.put(family, key, payload)?;
                zeroize::Zeroize::zeroize(payload);
            }
            delete_snapshot(session, &gid, name)
        })
    }

    fn release_group_snapshot(
        &self,
        group_id: &GroupId,
        name: &str,
    ) -> Result<(), MdkStorageError> {
        self.run(|session| delete_snapshot(session, &keys::gid(group_id)?, name))
    }

    fn list_group_snapshots(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(String, u64)>, MdkStorageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let mut snapshots: Vec<(String, u64)> = session
                .index()
                .snapshots
                .iter()
                .filter(|((group, _), _)| *group == gid)
                .map(|((_, name), created_at)| (name.clone(), *created_at))
                .collect();
            snapshots.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            Ok(snapshots)
        })
    }

    fn prune_expired_snapshots(&self, min_timestamp: u64) -> Result<usize, MdkStorageError> {
        self.run(|session| {
            let expired: Vec<(Vec<u8>, String)> = session
                .index()
                .snapshots
                .iter()
                .filter(|(_, created_at)| **created_at < min_timestamp)
                .map(|(at, _)| at.clone())
                .collect();
            for (gid, name) in &expired {
                delete_snapshot(session, gid, name)?;
            }
            Ok(expired.len())
        })
    }

    fn delete_group(&self, group_id: &GroupId) -> Result<(), MdkStorageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            for (family, key) in group_records(&gid) {
                session.delete(family, &key)?;
            }
            let index = session.index();
            let messages: Vec<[u8; 32]> = index
                .messages
                .get(&gid)
                .map(|messages| messages.keys().copied().collect())
                .unwrap_or_default();
            let processed: Vec<[u8; 32]> = index
                .processed
                .iter()
                .filter(|(_, meta)| meta.group.as_deref() == Some(gid.as_slice()))
                .map(|(id, _)| *id)
                .collect();
            let welcomes: Vec<[u8; 32]> = index
                .welcomes
                .iter()
                .filter(|(_, meta)| meta.group == gid)
                .map(|(id, _)| *id)
                .collect();
            let snapshots: Vec<String> = index
                .snapshots
                .keys()
                .filter(|(group, _)| *group == gid)
                .map(|(_, name)| name.clone())
                .collect();
            for id in &messages {
                session.delete(Family::Message, &keys::message_raw(&gid, id))?;
            }
            for id in &processed {
                session.delete(Family::ProcessedMessage, id)?;
            }
            for id in &welcomes {
                session.delete(Family::Welcome, id)?;
            }
            for name in &snapshots {
                delete_snapshot(session, &gid, name)?;
            }
            Ok(())
        })
    }
}
