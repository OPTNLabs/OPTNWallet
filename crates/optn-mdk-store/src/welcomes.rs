//! MDK's welcomes and its record of which ones it has processed.

use mdk_storage_traits::welcomes::error::WelcomeError;
use mdk_storage_traits::welcomes::types::{ProcessedWelcome, Welcome};
use mdk_storage_traits::welcomes::validation::validate_welcome_fields;
use mdk_storage_traits::welcomes::{validate_pending_welcomes_limit, Pagination, WelcomeStorage};
use nostr::{EventId, JsonUtil};

use crate::groups::{MAX_ADMINS, MAX_GROUP_DESCRIPTION, MAX_GROUP_NAME, MAX_RELAYS, MAX_RELAY_URL};
use crate::keys::{from_json, to_json};
use crate::record::Family;
use crate::MdkStore;

const MAX_EVENT_JSON: usize = 100 * 1024;

fn validate(welcome: &Welcome) -> Result<(), WelcomeError> {
    validate_welcome_fields(
        &welcome.group_relays,
        welcome.group_admin_pubkeys.len(),
        MAX_RELAYS,
        MAX_RELAY_URL,
        MAX_ADMINS,
    )?;
    let too_long = |field: &str, max: usize, actual: usize| {
        WelcomeError::InvalidParameters(format!(
            "{field} exceeds maximum length of {max} bytes (got {actual} bytes)"
        ))
    };
    if welcome.group_name.len() > MAX_GROUP_NAME {
        return Err(too_long(
            "Group name",
            MAX_GROUP_NAME,
            welcome.group_name.len(),
        ));
    }
    if welcome.group_description.len() > MAX_GROUP_DESCRIPTION {
        return Err(too_long(
            "Group description",
            MAX_GROUP_DESCRIPTION,
            welcome.group_description.len(),
        ));
    }
    let event = welcome.event.as_json();
    if event.len() > MAX_EVENT_JSON {
        return Err(too_long("Event JSON", MAX_EVENT_JSON, event.len()));
    }
    Ok(())
}

impl WelcomeStorage for MdkStore {
    fn save_welcome(&self, welcome: Welcome) -> Result<(), WelcomeError> {
        validate(&welcome)?;
        self.run(|session| {
            session.put(
                Family::Welcome,
                welcome.id.as_bytes(),
                &zeroize::Zeroizing::new(to_json(&welcome)?),
            )?;
            Ok(())
        })
    }

    fn find_welcome_by_event_id(
        &self,
        event_id: &EventId,
    ) -> Result<Option<Welcome>, WelcomeError> {
        self.run(|session| {
            Ok(match session.get(Family::Welcome, event_id.as_bytes())? {
                Some(payload) => Some(from_json(&payload)?),
                None => None,
            })
        })
    }

    fn pending_welcomes(
        &self,
        pagination: Option<Pagination>,
    ) -> Result<Vec<Welcome>, WelcomeError> {
        let pagination = pagination.unwrap_or_default();
        let (limit, offset) = (pagination.limit(), pagination.offset());
        validate_pending_welcomes_limit(limit)?;
        self.run(|session| {
            // Newest id first, as both of MDK's stores order them.
            let ids: Vec<[u8; 32]> = session
                .index()
                .welcomes
                .iter()
                .rev()
                .filter(|(_, meta)| meta.pending)
                .map(|(id, _)| *id)
                .skip(offset)
                .take(limit)
                .collect();
            let mut welcomes = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(payload) = session.get(Family::Welcome, &id)? {
                    welcomes.push(from_json(&payload)?);
                }
            }
            Ok(welcomes)
        })
    }

    fn save_processed_welcome(
        &self,
        processed_welcome: ProcessedWelcome,
    ) -> Result<(), WelcomeError> {
        self.run(|session| {
            session.put(
                Family::ProcessedWelcome,
                processed_welcome.wrapper_event_id.as_bytes(),
                &to_json(&processed_welcome)?,
            )?;
            Ok(())
        })
    }

    fn find_processed_welcome_by_event_id(
        &self,
        event_id: &EventId,
    ) -> Result<Option<ProcessedWelcome>, WelcomeError> {
        self.run(|session| {
            Ok(
                match session.get(Family::ProcessedWelcome, event_id.as_bytes())? {
                    Some(payload) => Some(from_json(&payload)?),
                    None => None,
                },
            )
        })
    }
}
