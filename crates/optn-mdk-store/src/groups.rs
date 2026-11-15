//! MDK's groups: the group record, its relays and its exporter secrets.

use std::collections::BTreeSet;

use mdk_storage_traits::groups::error::GroupError;
use mdk_storage_traits::groups::types::{Group, GroupExporterSecret, GroupRelay};
use mdk_storage_traits::groups::validation::{validate_group_fields, validate_relay_set};
use mdk_storage_traits::groups::{
    group_not_found, validate_message_limit, GroupStorage, MessageSortOrder, Pagination,
};
use mdk_storage_traits::messages::types::Message;
use mdk_storage_traits::{GroupId, Secret};
use nostr::{EventId, PublicKey, RelayUrl, Timestamp};

use crate::index::MessageMeta;
use crate::keys::{self, decode, encode, from_json, to_json};
use crate::messages::read_message;
use crate::record::Family;
use crate::{Failed, MdkStore, Outcome, Session};

/// MDK's limits, the stricter of its two stores' where they differ.
pub(crate) const MAX_GROUP_NAME: usize = 255;
pub(crate) const MAX_GROUP_DESCRIPTION: usize = 2000;
pub(crate) const MAX_ADMINS: usize = 100;
pub(crate) const MAX_RELAYS: usize = 100;
pub(crate) const MAX_RELAY_URL: usize = 512;

/// A group's exporter secrets: label, epoch, secret.
type ExporterSecrets = Vec<(u8, u64, Secret<[u8; 32]>)>;

/// The exporter secrets MDK keeps per epoch, by its label for them. The
/// numbers are on disk.
fn label_tag(label: &str) -> u8 {
    match label {
        "group-event" => 0,
        "legacy-group-event" => 1,
        "encrypted-media" => 2,
        other => unreachable!("MDK has no exporter secret labelled {other}"),
    }
}

/// The group, if it exists.
pub(crate) fn read_group(
    session: &mut Session<'_>,
    gid: &[u8],
) -> Outcome<Option<Group>, GroupError> {
    Ok(match session.get(Family::Group, gid)? {
        Some(payload) => Some(from_json(&payload)?),
        None => None,
    })
}

fn require_group(session: &mut Session<'_>, gid: &[u8]) -> Outcome<(), GroupError> {
    match session.index().groups.contains_key(gid) {
        true => Ok(()),
        false => Err(Failed::Refused(group_not_found())),
    }
}

fn read_secrets(session: &mut Session<'_>, gid: &[u8]) -> Outcome<ExporterSecrets, GroupError> {
    Ok(match session.get(Family::ExporterSecrets, gid)? {
        Some(payload) => decode(&payload)?,
        None => Vec::new(),
    })
}

fn write_secrets(
    session: &mut Session<'_>,
    gid: &[u8],
    secrets: &ExporterSecrets,
) -> Outcome<(), GroupError> {
    if secrets.is_empty() {
        session.delete(Family::ExporterSecrets, gid)?;
    } else {
        session.put(
            Family::ExporterSecrets,
            gid,
            &zeroize::Zeroizing::new(encode(secrets)?),
        )?;
    }
    Ok(())
}

/// A message as the index knows it: event id and meta.
type Indexed = ([u8; 32], MessageMeta);

/// The order MDK shows messages in, newest first: by the sender's time, or by
/// when this client received them, then by the other time, then by id.
fn order(sort: MessageSortOrder) -> impl Fn(&Indexed, &Indexed) -> std::cmp::Ordering {
    move |(a_id, a), (b_id, b)| {
        let a_id = EventId::from_byte_array(*a_id);
        let b_id = EventId::from_byte_array(*b_id);
        let (a_created, a_processed) = (
            Timestamp::from_secs(a.created_at),
            Timestamp::from_secs(a.processed_at),
        );
        let (b_created, b_processed) = (
            Timestamp::from_secs(b.created_at),
            Timestamp::from_secs(b.processed_at),
        );
        match sort {
            MessageSortOrder::CreatedAtFirst => Message::compare_display_keys(
                b_created,
                b_processed,
                b_id,
                a_created,
                a_processed,
                a_id,
            ),
            MessageSortOrder::ProcessedAtFirst => Message::compare_processed_at_keys(
                b_processed,
                b_created,
                b_id,
                a_processed,
                a_created,
                a_id,
            ),
        }
    }
}

impl MdkStore {
    fn exporter_secret(
        &self,
        group_id: &GroupId,
        epoch: u64,
        label: &str,
    ) -> Result<Option<GroupExporterSecret>, GroupError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            let tag = label_tag(label);
            Ok(read_secrets(session, &gid)?
                .into_iter()
                .find(|(at, at_epoch, _)| *at == tag && *at_epoch == epoch)
                .map(|(_, epoch, secret)| GroupExporterSecret {
                    mls_group_id: group_id.clone(),
                    epoch,
                    secret,
                }))
        })
    }

    fn save_exporter_secret(
        &self,
        secret: GroupExporterSecret,
        label: &str,
    ) -> Result<(), GroupError> {
        self.run(|session| {
            let gid = keys::gid(&secret.mls_group_id)?;
            require_group(session, &gid)?;
            let tag = label_tag(label);
            let mut secrets = read_secrets(session, &gid)?;
            match secrets
                .iter_mut()
                .find(|(at, epoch, _)| *at == tag && *epoch == secret.epoch)
            {
                Some(entry) => entry.2 = secret.secret,
                None => secrets.push((tag, secret.epoch, secret.secret)),
            }
            write_secrets(session, &gid, &secrets)
        })
    }
}

macro_rules! secret_get {
    ($self:ident, $group:ident, $epoch:ident, $label:literal, $unused:ident) => {
        $self.exporter_secret($group, $epoch, $label)
    };
}

macro_rules! secret_save {
    ($self:ident, $secret:ident, $label:literal, $unused:ident) => {
        $self.save_exporter_secret($secret, $label)
    };
}

impl GroupStorage for MdkStore {
    fn all_groups(&self) -> Result<Vec<Group>, GroupError> {
        self.run(|session| {
            let gids: Vec<Vec<u8>> = session.index().groups.keys().cloned().collect();
            let mut groups = Vec::with_capacity(gids.len());
            for gid in gids {
                if let Some(group) = read_group(session, &gid)? {
                    groups.push(group);
                }
            }
            Ok(groups)
        })
    }

    fn find_group_by_mls_group_id(&self, group_id: &GroupId) -> Result<Option<Group>, GroupError> {
        self.run(|session| read_group(session, &keys::gid(group_id)?))
    }

    fn find_group_by_nostr_group_id(
        &self,
        nostr_group_id: &[u8; 32],
    ) -> Result<Option<Group>, GroupError> {
        self.run(
            |session| match session.index().by_nostr_id.get(nostr_group_id).cloned() {
                Some(gid) => read_group(session, &gid),
                None => Ok(None),
            },
        )
    }

    fn save_group(&self, group: Group) -> Result<(), GroupError> {
        validate_group_fields(&group, MAX_GROUP_NAME, MAX_GROUP_DESCRIPTION, MAX_ADMINS)?;
        self.run(|session| {
            let gid = keys::gid(&group.mls_group_id)?;
            if let Some(owner) = session.index().by_nostr_id.get(&group.nostr_group_id) {
                if *owner != gid {
                    return Err(Failed::Refused(GroupError::InvalidParameters(
                        "nostr_group_id already exists for a different group".into(),
                    )));
                }
            }
            session.put(
                Family::Group,
                &gid,
                &zeroize::Zeroizing::new(to_json(&group)?),
            )?;
            Ok(())
        })
    }

    fn messages(
        &self,
        group_id: &GroupId,
        pagination: Option<Pagination>,
    ) -> Result<Vec<Message>, GroupError> {
        let pagination = pagination.unwrap_or_default();
        let (limit, offset) = (pagination.limit(), pagination.offset());
        validate_message_limit(limit)?;
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            let mut metas: Vec<([u8; 32], MessageMeta)> = session
                .index()
                .messages
                .get(&gid)
                .map(|messages| messages.iter().map(|(id, meta)| (*id, *meta)).collect())
                .unwrap_or_default();
            metas.sort_by(order(pagination.sort_order()));
            let mut messages = Vec::new();
            for (id, _) in metas.into_iter().skip(offset).take(limit) {
                if let Some(message) = read_message(session, &gid, &id)? {
                    messages.push(message);
                }
            }
            Ok(messages)
        })
    }

    fn last_message(
        &self,
        group_id: &GroupId,
        sort_order: MessageSortOrder,
    ) -> Result<Option<Message>, GroupError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            let newest = session.index().messages.get(&gid).and_then(|messages| {
                messages
                    .iter()
                    .map(|(id, meta)| (*id, *meta))
                    .min_by(order(sort_order))
            });
            match newest {
                Some((id, _)) => Ok(read_message(session, &gid, &id)?),
                None => Ok(None),
            }
        })
    }

    fn admins(&self, group_id: &GroupId) -> Result<BTreeSet<PublicKey>, GroupError> {
        match self.find_group_by_mls_group_id(group_id)? {
            Some(group) => Ok(group.admin_pubkeys),
            None => Err(group_not_found()),
        }
    }

    fn group_relays(&self, group_id: &GroupId) -> Result<BTreeSet<GroupRelay>, GroupError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            let urls: BTreeSet<RelayUrl> = match session.get(Family::GroupRelays, &gid)? {
                Some(payload) => from_json(&payload)?,
                None => BTreeSet::new(),
            };
            Ok(urls
                .into_iter()
                .map(|relay_url| GroupRelay {
                    relay_url,
                    mls_group_id: group_id.clone(),
                })
                .collect())
        })
    }

    fn replace_group_relays(
        &self,
        group_id: &GroupId,
        relays: BTreeSet<RelayUrl>,
    ) -> Result<(), GroupError> {
        validate_relay_set(&relays, MAX_RELAYS, MAX_RELAY_URL)?;
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            if relays.is_empty() {
                session.delete(Family::GroupRelays, &gid)?;
            } else {
                session.put(Family::GroupRelays, &gid, &to_json(&relays)?)?;
            }
            Ok(())
        })
    }

    mdk_storage_traits::impl_exporter_secret_methods!(secret_get, secret_save);

    fn prune_group_exporter_secrets_before_epoch(
        &self,
        group_id: &GroupId,
        min_epoch_to_keep: u64,
    ) -> Result<(), GroupError> {
        self.run(|session| {
            let gid = keys::gid(group_id)?;
            require_group(session, &gid)?;
            let mut secrets = read_secrets(session, &gid)?;
            let before = secrets.len();
            secrets.retain(|(_, epoch, _)| *epoch >= min_epoch_to_keep);
            if secrets.len() != before {
                write_secrets(session, &gid, &secrets)?;
            }
            Ok(())
        })
    }
}
