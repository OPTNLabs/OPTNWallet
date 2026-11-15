//! What the store remembers in memory about the records on disk.
//!
//! Disk keys are keyed hashes, so the database cannot be asked for "every
//! message of this group" or "every group". These indexes answer that. They
//! are derived data: rebuilt from the records at every open and after every
//! abandoned unit of work, and never written to disk, so they cannot go stale
//! across a restart. Each holds only what a query filters or sorts by.

use std::collections::{BTreeMap, HashMap};

use mdk_storage_traits::groups::types::Group;
use mdk_storage_traits::messages::types::{ProcessedMessage, ProcessedMessageState};
use mdk_storage_traits::welcomes::types::{Welcome, WelcomeState};

use crate::keys;
use crate::record::Family;
use crate::Fault;

/// What queries need of a message without opening it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MessageMeta {
    pub(crate) created_at: u64,
    pub(crate) processed_at: u64,
    pub(crate) epoch: Option<u64>,
    /// The message's state is `EpochInvalidated`.
    pub(crate) invalidated: bool,
}

impl MessageMeta {
    /// The meta is the fixed head of a message record, so an open reads it
    /// without parsing the message.
    pub(crate) const ENCODED: usize = 26;

    pub(crate) fn encode(&self) -> [u8; Self::ENCODED] {
        let mut out = [0u8; Self::ENCODED];
        out[..8].copy_from_slice(&self.created_at.to_le_bytes());
        out[8..16].copy_from_slice(&self.processed_at.to_le_bytes());
        out[16] = u8::from(self.epoch.is_some());
        out[17..25].copy_from_slice(&self.epoch.unwrap_or(0).to_le_bytes());
        out[25] = u8::from(self.invalidated);
        out
    }

    pub(crate) fn decode(payload: &[u8]) -> Result<Self, Fault> {
        let head = payload
            .get(..Self::ENCODED)
            .ok_or_else(|| Fault::new("a message record is too short"))?;
        let number = |at: usize| {
            u64::from_le_bytes(
                head[at..at + 8]
                    .try_into()
                    .expect("eight bytes were sliced"),
            )
        };
        Ok(Self {
            created_at: number(0),
            processed_at: number(8),
            epoch: (head[16] != 0).then(|| number(17)),
            invalidated: head[25] != 0,
        })
    }
}

/// What queries need of a processed-message record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessedMeta {
    /// The group, as [`keys::gid`] writes it.
    pub(crate) group: Option<Vec<u8>>,
    pub(crate) epoch: Option<u64>,
    pub(crate) state: ProcessedMessageState,
}

/// What queries need of a welcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WelcomeMeta {
    pub(crate) group: Vec<u8>,
    pub(crate) pending: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Index {
    /// Every group, with the Nostr group id its events are tagged with.
    pub(crate) groups: BTreeMap<Vec<u8>, [u8; 32]>,
    /// Nostr group id to group.
    pub(crate) by_nostr_id: HashMap<[u8; 32], Vec<u8>>,
    /// Each group's messages, by event id.
    pub(crate) messages: HashMap<Vec<u8>, BTreeMap<[u8; 32], MessageMeta>>,
    /// Processed-message records, by wrapper event id.
    pub(crate) processed: HashMap<[u8; 32], ProcessedMeta>,
    /// Welcomes, by event id.
    pub(crate) welcomes: BTreeMap<[u8; 32], WelcomeMeta>,
    /// Snapshots, by group and name, with when each was made.
    pub(crate) snapshots: BTreeMap<(Vec<u8>, String), u64>,
}

impl Index {
    /// A record was written.
    pub(crate) fn wrote(
        &mut self,
        family: Family,
        key: &[u8],
        payload: &[u8],
    ) -> Result<(), Fault> {
        match family {
            Family::Group => {
                let group: Group = keys::from_json(payload)?;
                if let Some(old) = self.groups.insert(key.to_vec(), group.nostr_group_id) {
                    if old != group.nostr_group_id {
                        self.by_nostr_id.remove(&old);
                    }
                }
                self.by_nostr_id.insert(group.nostr_group_id, key.to_vec());
            }
            Family::Message => {
                let (group, id) = keys::split_message(key)?;
                self.messages
                    .entry(group.to_vec())
                    .or_default()
                    .insert(id, MessageMeta::decode(payload)?);
            }
            Family::ProcessedMessage => {
                let record: ProcessedMessage = keys::from_json(payload)?;
                let group = match &record.mls_group_id {
                    Some(group) => Some(keys::gid(group)?),
                    None => None,
                };
                self.processed.insert(
                    keys::event_id(key)?,
                    ProcessedMeta {
                        group,
                        epoch: record.epoch,
                        state: record.state,
                    },
                );
            }
            Family::Welcome => {
                let welcome: Welcome = keys::from_json(payload)?;
                self.welcomes.insert(
                    keys::event_id(key)?,
                    WelcomeMeta {
                        group: keys::gid(&welcome.mls_group_id)?,
                        pending: welcome.state == WelcomeState::Pending,
                    },
                );
            }
            Family::Snapshot => {
                let (group, name, created_at) = keys::snapshot_head(payload)?;
                self.snapshots.insert((group, name), created_at);
            }
            _ => {}
        }
        Ok(())
    }

    /// A record was deleted.
    pub(crate) fn deleted(&mut self, family: Family, key: &[u8]) -> Result<(), Fault> {
        match family {
            Family::Group => {
                if let Some(nostr_id) = self.groups.remove(key) {
                    self.by_nostr_id.remove(&nostr_id);
                }
            }
            Family::Message => {
                let (group, id) = keys::split_message(key)?;
                if let Some(messages) = self.messages.get_mut(group) {
                    messages.remove(&id);
                    if messages.is_empty() {
                        self.messages.remove(group);
                    }
                }
            }
            Family::ProcessedMessage => {
                self.processed.remove(&keys::event_id(key)?);
            }
            Family::Welcome => {
                self.welcomes.remove(&keys::event_id(key)?);
            }
            Family::Snapshot => {
                let (group, name) = keys::split_snapshot(key)?;
                self.snapshots.remove(&(group, name));
            }
            _ => {}
        }
        Ok(())
    }
}
