//! MDK's messages and its record of which group events it has processed.

use mdk_storage_traits::messages::error::MessageError;
use mdk_storage_traits::messages::types::{
    Message, MessageState, ProcessedMessage, ProcessedMessageState,
};
use mdk_storage_traits::messages::MessageStorage;
use mdk_storage_traits::GroupId;
use nostr::{EventId, JsonUtil};

use crate::index::MessageMeta;
use crate::keys::{self, from_json, to_json};
use crate::record::Family;
use crate::{Failed, MdkStore, Outcome, Session};

/// MDK's limits on a message, as both of its stores have them.
const MAX_CONTENT: usize = 1024 * 1024;
const MAX_TAGS_JSON: usize = 100 * 1024;
const MAX_EVENT_JSON: usize = 100 * 1024;

fn too_large(field: &str, max: usize, actual: usize) -> MessageError {
    MessageError::InvalidParameters(format!(
        "{field} exceeds maximum length of {max} bytes (got {actual} bytes)"
    ))
}

fn validate(message: &Message) -> Result<(), MessageError> {
    if message.content.len() > MAX_CONTENT {
        return Err(too_large(
            "Message content",
            MAX_CONTENT,
            message.content.len(),
        ));
    }
    let tags = serde_json::to_string(&message.tags).map_err(|error| {
        MessageError::DatabaseError(format!("Failed to serialize tags: {error}"))
    })?;
    if tags.len() > MAX_TAGS_JSON {
        return Err(too_large("Tags JSON", MAX_TAGS_JSON, tags.len()));
    }
    let event = message.event.as_json();
    if event.len() > MAX_EVENT_JSON {
        return Err(too_large("Event JSON", MAX_EVENT_JSON, event.len()));
    }
    Ok(())
}

/// A message record: its [`MessageMeta`] then the message as JSON.
fn message_payload(message: &Message) -> Result<zeroize::Zeroizing<Vec<u8>>, crate::Fault> {
    let meta = MessageMeta {
        created_at: message.created_at.as_secs(),
        processed_at: message.processed_at.as_secs(),
        epoch: message.epoch,
        invalidated: message.state == MessageState::EpochInvalidated,
    };
    let json = zeroize::Zeroizing::new(to_json(message)?);
    let mut payload =
        zeroize::Zeroizing::new(Vec::with_capacity(MessageMeta::ENCODED + json.len()));
    payload.extend_from_slice(&meta.encode());
    payload.extend_from_slice(&json);
    Ok(payload)
}

/// A message of a group, if it is stored.
pub(crate) fn read_message<E>(
    session: &mut Session<'_>,
    gid: &[u8],
    id: &[u8; 32],
) -> Outcome<Option<Message>, E> {
    Ok(
        match session.get(Family::Message, &keys::message_raw(gid, id))? {
            Some(payload) => Some(from_json(&payload[MessageMeta::ENCODED..])?),
            None => None,
        },
    )
}

fn write_message<E>(session: &mut Session<'_>, message: &Message) -> Outcome<(), E> {
    let gid = keys::gid(&message.mls_group_id)?;
    session.put(
        Family::Message,
        &keys::message(&gid, &message.id),
        &message_payload(message)?,
    )?;
    Ok(())
}

fn read_processed<E>(
    session: &mut Session<'_>,
    id: &[u8; 32],
) -> Outcome<Option<ProcessedMessage>, E> {
    Ok(match session.get(Family::ProcessedMessage, id)? {
        Some(payload) => Some(from_json(&payload)?),
        None => None,
    })
}

fn write_processed<E>(session: &mut Session<'_>, record: &ProcessedMessage) -> Outcome<(), E> {
    session.put(
        Family::ProcessedMessage,
        record.wrapper_event_id.as_bytes(),
        &to_json(record)?,
    )?;
    Ok(())
}

/// The processed-message records of a group that pass `keep`, by wrapper id.
fn processed_of(
    session: &Session<'_>,
    gid: &[u8],
    keep: impl Fn(Option<u64>, ProcessedMessageState) -> bool,
) -> Vec<[u8; 32]> {
    let mut ids: Vec<[u8; 32]> = session
        .index()
        .processed
        .iter()
        .filter(|(_, meta)| meta.group.as_deref() == Some(gid) && keep(meta.epoch, meta.state))
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    ids
}

/// The ids of a group's messages whose meta passes `keep`, in id order.
fn messages_of(
    session: &Session<'_>,
    gid: &[u8],
    keep: impl Fn(&MessageMeta) -> bool,
) -> Vec<[u8; 32]> {
    session
        .index()
        .messages
        .get(gid)
        .map(|messages| {
            messages
                .iter()
                .filter(|(_, meta)| keep(meta))
                .map(|(id, _)| *id)
                .collect()
        })
        .unwrap_or_default()
}

impl MessageStorage for MdkStore {
    fn save_message(&self, message: Message) -> Result<(), MessageError> {
        validate(&message)?;
        self.run(|session| {
            if !session
                .index()
                .groups
                .contains_key(&keys::gid(&message.mls_group_id)?)
            {
                return Err(Failed::Refused(MessageError::InvalidParameters(
                    "Group not found".into(),
                )));
            }
            write_message(session, &message)
        })
    }

    fn find_message_by_event_id(
        &self,
        mls_group_id: &GroupId,
        event_id: &EventId,
    ) -> Result<Option<Message>, MessageError> {
        self.run(|session| read_message(session, &keys::gid(mls_group_id)?, event_id.as_bytes()))
    }

    fn save_processed_message(
        &self,
        processed_message: ProcessedMessage,
    ) -> Result<(), MessageError> {
        self.run(|session| write_processed(session, &processed_message))
    }

    fn find_processed_message_by_event_id(
        &self,
        event_id: &EventId,
    ) -> Result<Option<ProcessedMessage>, MessageError> {
        self.run(|session| read_processed(session, event_id.as_bytes()))
    }

    fn invalidate_messages_after_epoch(
        &self,
        group_id: &GroupId,
        epoch: u64,
    ) -> Result<Vec<EventId>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let ids = messages_of(session, &gid, |meta| {
                meta.epoch.is_some_and(|at| at > epoch)
            });
            for id in &ids {
                if let Some(mut message) = read_message(session, &gid, id)? {
                    message.state = MessageState::EpochInvalidated;
                    write_message(session, &message)?;
                }
            }
            Ok(ids.into_iter().map(EventId::from_byte_array).collect())
        })
    }

    fn invalidate_processed_messages_after_epoch(
        &self,
        group_id: &GroupId,
        epoch: u64,
    ) -> Result<Vec<EventId>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let ids = processed_of(session, &gid, |at, _| at.is_some_and(|at| at > epoch));
            for id in &ids {
                if let Some(mut record) = read_processed(session, id)? {
                    record.state = ProcessedMessageState::EpochInvalidated;
                    write_processed(session, &record)?;
                }
            }
            Ok(ids.into_iter().map(EventId::from_byte_array).collect())
        })
    }

    fn find_failed_messages_for_retry(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<EventId>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let ids = processed_of(session, &gid, |at, state| {
                at.is_none() && state == ProcessedMessageState::Failed
            });
            Ok(ids.into_iter().map(EventId::from_byte_array).collect())
        })
    }

    fn find_invalidated_messages(&self, group_id: &GroupId) -> Result<Vec<Message>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let mut messages = Vec::new();
            for id in messages_of(session, &gid, |meta| meta.invalidated) {
                if let Some(message) = read_message(session, &gid, &id)? {
                    messages.push(message);
                }
            }
            Ok(messages)
        })
    }

    fn find_invalidated_processed_messages(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProcessedMessage>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let mut records = Vec::new();
            for id in processed_of(session, &gid, |_, state| {
                state == ProcessedMessageState::EpochInvalidated
            }) {
                if let Some(record) = read_processed(session, &id)? {
                    records.push(record);
                }
            }
            Ok(records)
        })
    }

    fn mark_processed_message_retryable(&self, event_id: &EventId) -> Result<(), MessageError> {
        self.run(
            |session| match read_processed(session, event_id.as_bytes())? {
                Some(mut record) if record.state == ProcessedMessageState::Failed => {
                    record.state = ProcessedMessageState::Retryable;
                    write_processed(session, &record)
                }
                _ => Err(Failed::Refused(MessageError::NotFound)),
            },
        )
    }

    fn find_message_epoch_by_tag_content(
        &self,
        group_id: &GroupId,
        content_substring: &str,
    ) -> Result<Option<u64>, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            for id in messages_of(session, &gid, |meta| meta.epoch.is_some()) {
                let Some(message) = read_message(session, &gid, &id)? else {
                    continue;
                };
                let tags = serde_json::to_string(&message.tags).map_err(|error| {
                    crate::Fault::new(format!("tags did not serialize: {error}"))
                })?;
                if tags.contains(content_substring) {
                    return Ok(message.epoch);
                }
            }
            Ok(None)
        })
    }

    fn delete_messages_for_group(&self, group_id: &GroupId) -> Result<usize, MessageError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            let ids = messages_of(session, &gid, |_| true);
            for id in &ids {
                session.delete(Family::Message, &keys::message_raw(&gid, id))?;
            }
            Ok(ids.len())
        })
    }
}
