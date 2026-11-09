//! The engine: MDK, the identity, the relays, and the order things happen in.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{Stream, StreamExt};
use mdk_core::prelude::{
    group_types, message_types, welcome_types, GroupId, MdkStorageProvider,
    MessageProcessingResult, NostrGroupConfigData, NostrGroupDataUpdate, UpdateGroupResult, MDK,
};
use mdk_nostr as mn;
use mdk_storage_traits::groups::Pagination;
use mdk_storage_traits::messages::types::ProcessedMessageState;
use openmls_traits::OpenMlsProvider;
use optn_nostr::nostr::prelude as on;
use optn_nostr::nostr::prelude::FinalizeEvent;
use optn_nostr::{nip59, Published, Relays};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

use crate::bridge::cross;
use crate::state::EngineState;
use crate::{
    ChatError, ChatEvent, ChatMessage, GroupView, KIND_GROUP_EVENT, KIND_KEY_PACKAGE,
    KIND_KEY_PACKAGE_LEGACY, KIND_KEY_PACKAGE_RELAYS, KIND_WELCOME,
};

/// NIP-59 scrambles a gift wrap's timestamp up to two days into the past, so
/// the inbox is always read from at least that far back.
const GIFT_WRAP_SKEW: u64 = 2 * 24 * 60 * 60;
/// Relays' clocks and ours disagree a little; group events are re-read across
/// this margin. MDK drops what it has already processed.
const CLOCK_MARGIN: u64 = 10 * 60;
/// How far back a store that has never read anything looks: MDK refuses group
/// events older than its 45-day window anyway.
const FIRST_READ: u64 = 45 * 24 * 60 * 60;
/// The longest a new group event waits for the clock to pass the newest
/// commit: enough for a tie within one second, not for a peer whose clock
/// runs well ahead.
const PACING_LIMIT: Duration = Duration::from_secs(3);
/// A key package is rotated after this long.
const KEY_PACKAGE_LIFETIME: u64 = 7 * 24 * 60 * 60;
/// This identity's leaf keys in a group are rotated after this long (MIP-00).
const SELF_UPDATE_INTERVAL: u64 = 30 * 24 * 60 * 60;
/// Key packages looked at per member, newest first.
const KEY_PACKAGE_CANDIDATES: usize = 20;
/// Relays taken from a member's kind-10051 list.
const KEY_PACKAGE_RELAYS_PER_MEMBER: usize = 8;

/// Where this identity's chat lives on Nostr.
#[derive(Debug, Clone)]
pub struct ChatConfig {
    /// Relays this identity publishes its key packages and their relay list
    /// to, looks peers' key packages up on, and receives welcomes on. New
    /// groups use them unless given their own.
    pub relays: Vec<String>,
    /// How long one relay operation waits.
    pub timeout: Duration,
}

/// Marmot chat for one identity. Cheap to clone; clones share the engine.
pub struct ChatEngine<S: MdkStorageProvider> {
    inner: Arc<Inner<S>>,
}

impl<S: MdkStorageProvider> Clone for ChatEngine<S> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

struct Inner<S: MdkStorageProvider> {
    mdk: Mutex<MDK<S>>,
    keys: on::Keys,
    me: mn::PublicKey,
    relays: Relays,
    config: ChatConfig,
    state: AsyncMutex<EngineState>,
    state_path: Option<PathBuf>,
    /// Groups whose events the live subscription follows, by MLS group id.
    followed: AsyncMutex<BTreeMap<String, on::SubscriptionId>>,
    /// When the newest commit this identity made or read was made, or the
    /// welcome it joined by, seconds.
    newest_commit_at: AsyncMutex<u64>,
    /// Everything read from relays, by whichever path read it.
    events: broadcast::Sender<ChatEvent>,
    /// The live reader, while [`ChatEngine::listen`] runs.
    pump: AsyncMutex<Option<Pump>>,
}

/// The task feeding relay notifications to the engine, and the inbox
/// subscription it reads.
struct Pump {
    task: tokio::task::AbortHandle,
    inbox: on::SubscriptionId,
}

/// Events buffered for a slow reader of [`ChatEngine::events`] before it
/// starts losing them.
const EVENT_BUFFER: usize = 1024;

/// A member's key package, as found on relays.
struct KeyPackage {
    member: on::PublicKey,
    event: on::Event,
    /// Where the member receives welcomes: the key package's `relays` tag.
    relays: Vec<String>,
}

#[cfg(feature = "sqlite")]
impl ChatEngine<mdk_sqlite_storage::MdkSqliteStorage> {
    /// Open, or create, `identity`'s chat store in `dir`: MDK's SQLCipher
    /// store `<pubkey>.mdk.sqlite`, encrypted with [`crate::store_key`], and
    /// the engine's state file beside it.
    pub async fn open(
        dir: &std::path::Path,
        keys: on::Keys,
        relays: Relays,
        config: ChatConfig,
    ) -> Result<Self, ChatError> {
        use mdk_sqlite_storage::{EncryptionConfig, MdkSqliteStorage};

        std::fs::create_dir_all(dir)
            .map_err(|error| ChatError::Store(format!("{}: {error}", dir.display())))?;
        let name = keys.public_key().to_hex();
        let database = dir.join(format!("{name}.mdk.sqlite"));
        let state_path = dir.join(format!("{name}.state.json"));
        let key = crate::store_key(&keys);
        let store = tokio::task::spawn_blocking(move || {
            MdkSqliteStorage::new_with_key(&database, EncryptionConfig::new(*key))
                .map_err(|error| ChatError::Store(format!("{}: {error}", database.display())))
        })
        .await
        .map_err(|error| ChatError::Stopped(error.to_string()))??;
        let state = EngineState::load(&state_path)?;
        Self::with_store(store, keys, relays, config, state, Some(state_path))
    }
}

impl<S> ChatEngine<S>
where
    S: MdkStorageProvider + Send + 'static,
{
    /// An engine over `store`, an MDK store of the host's choosing, keeping
    /// its own bookkeeping in memory. [`ChatEngine::open`] is the persistent
    /// one.
    pub fn new(
        store: S,
        keys: on::Keys,
        relays: Relays,
        config: ChatConfig,
    ) -> Result<Self, ChatError> {
        Self::with_store(store, keys, relays, config, EngineState::default(), None)
    }

    fn with_store(
        store: S,
        keys: on::Keys,
        relays: Relays,
        config: ChatConfig,
        state: EngineState,
        state_path: Option<PathBuf>,
    ) -> Result<Self, ChatError> {
        let me = cross(&keys.public_key())?;
        Ok(Self {
            inner: Arc::new(Inner {
                mdk: Mutex::new(MDK::new(store)),
                keys,
                me,
                relays,
                config,
                state: AsyncMutex::new(state),
                state_path,
                followed: AsyncMutex::new(BTreeMap::new()),
                newest_commit_at: AsyncMutex::new(0),
                events: broadcast::channel(EVENT_BUFFER).0,
                pump: AsyncMutex::new(None),
            }),
        })
    }

    /// This identity's public key, hex.
    pub fn public_key(&self) -> String {
        self.inner.keys.public_key().to_hex()
    }

    /// Run `work` on MDK off the async threads: MDK is synchronous and its
    /// store does disk I/O.
    async fn mdk<T, F>(&self, work: F) -> Result<T, ChatError>
    where
        T: Send + 'static,
        F: FnOnce(&MDK<S>) -> Result<T, ChatError> + Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let mdk = inner.mdk.lock().map_err(|_| {
                ChatError::Stopped("an earlier operation failed midway; reopen the store".into())
            })?;
            work(&mdk)
        })
        .await
        .map_err(|error| ChatError::Stopped(error.to_string()))?
    }

    async fn save_state(&self, state: &EngineState) -> Result<(), ChatError> {
        match &self.inner.state_path {
            Some(path) => state.save(path),
            None => Ok(()),
        }
    }

    fn timeout(&self) -> Duration {
        self.inner.config.timeout
    }

    /// Wait until the clock has left the second of the newest commit this
    /// identity made or read (or the welcome it joined by). Relays give no
    /// order beyond `created_at`, and MDK does not retry a group event it
    /// failed to read, so anything made in an epoch must never tie with the
    /// commit that opened it: a reader could take the two in the wrong order
    /// and lose the second for good.
    async fn after_last_commit(&self) {
        let newest = *self.inner.newest_commit_at.lock().await;
        let deadline = tokio::time::Instant::now() + PACING_LIMIT;
        while on::Timestamp::now().as_secs() <= newest && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn saw_commit_at(&self, at: u64) {
        let mut newest = self.inner.newest_commit_at.lock().await;
        *newest = (*newest).max(at);
    }

    /// Publish a fresh key package in this device's slot, and the list of
    /// relays it is on, so peers can invite this identity. The two newest key
    /// packages keep their private keys; older ones are deleted from the
    /// store, since relays no longer offer them.
    pub async fn publish_key_package(&self) -> Result<Published, ChatError> {
        let relays = mdk_relays(&self.inner.config.relays)?;
        let me = self.inner.me;
        let package = self
            .mdk(move |mdk| Ok(mdk.create_key_package_for_event(&me, relays)?))
            .await?;

        let mut state = self.inner.state.lock().await;
        let slot = state
            .key_package_slot
            .get_or_insert_with(|| package.d_tag.clone())
            .clone();
        let tags: Vec<on::Tag> = cross::<_, Vec<on::Tag>>(&package.tags_30443)?
            .into_iter()
            .map(|tag| {
                if tag.kind() == "d" {
                    on::Tag::identifier(slot.clone())
                } else {
                    tag
                }
            })
            .collect();
        let event = on::EventBuilder::new(on::Kind::Custom(KIND_KEY_PACKAGE), package.content)
            .tags(tags)
            .finalize(&self.inner.keys)
            .map_err(|error| ChatError::Invalid(error.to_string()))?;
        let list = on::EventBuilder::new(on::Kind::Custom(KIND_KEY_PACKAGE_RELAYS), "")
            .tags(
                self.inner
                    .config
                    .relays
                    .iter()
                    .map(|url| on::Tag::parse(["relay", url.as_str()]))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| ChatError::Invalid(error.to_string()))?,
            )
            .finalize(&self.inner.keys)
            .map_err(|error| ChatError::Invalid(error.to_string()))?;

        let published = self
            .inner
            .relays
            .publish_to(&self.inner.config.relays, &event, self.timeout())
            .await?;
        self.inner
            .relays
            .publish_to(&self.inner.config.relays, &list, self.timeout())
            .await?;

        state.key_packages.push(hex::encode(&package.hash_ref));
        while state.key_packages.len() > 2 {
            let retired = hex::decode(state.key_packages.remove(0))
                .map_err(|error| ChatError::Store(error.to_string()))?;
            self.mdk(move |mdk| Ok(mdk.delete_key_package_from_storage_by_hash_ref(&retired)?))
                .await?;
        }
        state.key_package_published_at = Some(on::Timestamp::now().as_secs());
        self.save_state(&state).await?;
        Ok(published)
    }

    /// Publish a key package unless the current one is younger than a week.
    pub async fn ensure_key_package(&self) -> Result<Option<Published>, ChatError> {
        let fresh = self
            .inner
            .state
            .lock()
            .await
            .key_package_published_at
            .is_some_and(|at| on::Timestamp::now().as_secs() < at + KEY_PACKAGE_LIFETIME);
        if fresh {
            return Ok(None);
        }
        self.publish_key_package().await.map(Some)
    }

    /// The newest key package of `member` that MDK accepts, from the relays
    /// their kind-10051 list names, or ours.
    async fn key_package(&self, member: &on::PublicKey) -> Result<KeyPackage, ChatError> {
        let ours = &self.inner.config.relays;
        let lists = self
            .inner
            .relays
            .fetch(
                ours,
                on::Filter::new()
                    .author(*member)
                    .kind(on::Kind::Custom(KIND_KEY_PACKAGE_RELAYS)),
                self.timeout(),
            )
            .await?;
        let mut relays: Vec<String> = lists
            .iter()
            .max_by_key(|list| list.created_at)
            .map(|list| tag_values(list, "relay"))
            .unwrap_or_default();
        relays.truncate(KEY_PACKAGE_RELAYS_PER_MEMBER);
        for url in ours {
            if !relays.contains(url) {
                relays.push(url.clone());
            }
        }
        let mut candidates = self
            .inner
            .relays
            .fetch(
                &relays,
                on::Filter::new().author(*member).kinds([
                    on::Kind::Custom(KIND_KEY_PACKAGE),
                    on::Kind::Custom(KIND_KEY_PACKAGE_LEGACY),
                ]),
                self.timeout(),
            )
            .await?;
        candidates.sort_by_key(|event| std::cmp::Reverse(event.created_at));
        for event in candidates.into_iter().take(KEY_PACKAGE_CANDIDATES) {
            let parsed: mn::Event = cross(&event)?;
            let usable = self
                .mdk(move |mdk| Ok(mdk.parse_key_package(&parsed).is_ok()))
                .await?;
            if usable {
                let relays = tag_values(&event, "relays");
                return Ok(KeyPackage {
                    member: *member,
                    event,
                    relays,
                });
            }
        }
        Err(ChatError::NoKeyPackage {
            member: member.to_hex(),
        })
    }

    async fn key_packages(&self, members: &[String]) -> Result<Vec<KeyPackage>, ChatError> {
        let mut packages = Vec::with_capacity(members.len());
        for member in members {
            packages.push(self.key_package(&public_key(member)?).await?);
        }
        Ok(packages)
    }

    /// Gift-wrap each welcome to the member whose key package it answers and
    /// send it to the relays that key package names.
    async fn send_welcomes(
        &self,
        welcomes: &[mn::UnsignedEvent],
        packages: &[KeyPackage],
    ) -> Result<(), ChatError> {
        for welcome in welcomes {
            let answers = welcome
                .tags
                .iter()
                .find(|tag| tag.kind() == mn::TagKind::e())
                .and_then(|tag| tag.content())
                .ok_or_else(|| ChatError::Mdk("a welcome names no key package".into()))?;
            let package = packages
                .iter()
                .find(|package| package.event.id.to_hex() == answers)
                .ok_or_else(|| ChatError::Mdk("a welcome answers an unknown key package".into()))?;
            let rumor: on::UnsignedEvent = cross(welcome)?;
            let wrapped = nip59::wrap(&self.inner.keys, &package.member, rumor)
                .map_err(|error| ChatError::Invalid(error.to_string()))?;
            let relays = if package.relays.is_empty() {
                &self.inner.config.relays
            } else {
                &package.relays
            };
            self.inner
                .relays
                .publish_to(relays, &wrapped, self.timeout())
                .await?;
        }
        Ok(())
    }

    /// Create a group with this identity as its admin and `members` (hex
    /// public keys) in it, on `relays` (ours when empty). Each member gets a
    /// welcome; a member without a usable key package fails the whole call
    /// before anything is created.
    pub async fn create_group(
        &self,
        name: &str,
        members: &[String],
        relays: &[String],
    ) -> Result<GroupView, ChatError> {
        let packages = self.key_packages(members).await?;
        let events: Vec<mn::Event> = packages
            .iter()
            .map(|package| cross(&package.event))
            .collect::<Result<_, _>>()?;
        let relays = if relays.is_empty() {
            &self.inner.config.relays
        } else {
            relays
        };
        let config = NostrGroupConfigData::new(
            name.to_owned(),
            String::new(),
            None,
            None,
            None,
            mdk_relays(relays)?,
            vec![self.inner.me],
        );
        let me = self.inner.me;
        let created = self
            .mdk(move |mdk| {
                let created = mdk.create_group(&me, events, config)?;
                // Nobody else is in the group's first epoch to tell, so the
                // members' additions apply at once.
                mdk.merge_pending_commit(&created.group.mls_group_id)?;
                Ok(created)
            })
            .await?;
        self.send_welcomes(&created.welcome_rumors, &packages)
            .await?;
        let group = created.group.mls_group_id;
        self.follow(&group).await;
        self.view(group).await
    }

    /// Publish `update`'s commit to the group's relays and merge it once one
    /// holds it. If none does, the commit is dropped: the group stays in the
    /// epoch everyone else is in.
    async fn commit(&self, group: GroupId, update: UpdateGroupResult) -> Result<(), ChatError> {
        let relays = self.group_relays(group.clone()).await?;
        let commit: on::Event = cross(&update.evolution_event)?;
        if let Err(error) = self
            .inner
            .relays
            .publish_to(&relays, &commit, self.timeout())
            .await
        {
            self.mdk(move |mdk| Ok(mdk.clear_pending_commit(&group)?))
                .await?;
            return Err(error.into());
        }
        self.saw_commit_at(commit.created_at.as_secs()).await;
        self.mdk(move |mdk| Ok(mdk.merge_pending_commit(&group)?))
            .await
    }

    /// Rotate this identity's leaf keys in `group`: after joining, when the
    /// key package may have been used by others too (MIP-02), and
    /// periodically after that.
    async fn self_update(&self, group: GroupId) -> Result<(), ChatError> {
        self.after_last_commit().await;
        let id = group.clone();
        let update = self.mdk(move |mdk| Ok(mdk.self_update(&id)?)).await?;
        self.commit(group, update).await
    }

    /// Read `group`'s events up to now before changing it, so the commit is
    /// made in the newest epoch there is. A commit made from an older epoch
    /// forks the group, and under MIP-03 the earlier commit wins: this one
    /// would be undone.
    async fn sync_group(&self, group: &GroupId) -> Result<(), ChatError> {
        let view = self.view(group.clone()).await?;
        let now = on::Timestamp::now().as_secs();
        let since = self
            .inner
            .state
            .lock()
            .await
            .groups_read_until
            .unwrap_or(now.saturating_sub(FIRST_READ))
            .saturating_sub(CLOCK_MARGIN);
        let mut events = self
            .inner
            .relays
            .fetch(
                &view.relays,
                group_filter(&view.nostr_group_id).since(on::Timestamp::from(since)),
                self.timeout(),
            )
            .await?;
        events.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        for event in &events {
            self.ingest(event).await?;
        }
        Ok(())
    }

    /// Add `members` (hex public keys) to `group`, then welcome them.
    pub async fn add_members(
        &self,
        group: &str,
        members: &[String],
    ) -> Result<GroupView, ChatError> {
        let group = group_id(group)?;
        let packages = self.key_packages(members).await?;
        self.sync_group(&group).await?;
        self.after_last_commit().await;
        let events: Vec<mn::Event> = packages
            .iter()
            .map(|package| cross(&package.event))
            .collect::<Result<_, _>>()?;
        let id = group.clone();
        let update = self
            .mdk(move |mdk| Ok(mdk.add_members(&id, &events)?))
            .await?;
        let welcomes = update.welcome_rumors.clone().unwrap_or_default();
        self.commit(group.clone(), update).await?;
        self.send_welcomes(&welcomes, &packages).await?;
        self.view(group).await
    }

    /// Remove `members` (hex public keys) from `group`.
    pub async fn remove_members(
        &self,
        group: &str,
        members: &[String],
    ) -> Result<GroupView, ChatError> {
        let group = group_id(group)?;
        let members: Vec<mn::PublicKey> = members
            .iter()
            .map(|member| cross(&public_key(member)?))
            .collect::<Result<_, _>>()?;
        let id = group.clone();
        self.sync_group(&group).await?;
        self.after_last_commit().await;
        let update = self
            .mdk(move |mdk| Ok(mdk.remove_members(&id, &members)?))
            .await?;
        self.commit(group.clone(), update).await?;
        self.view(group).await
    }

    /// Rename `group`.
    pub async fn rename(&self, group: &str, name: &str) -> Result<GroupView, ChatError> {
        let group = group_id(group)?;
        let update = NostrGroupDataUpdate {
            name: Some(name.to_owned()),
            ..Default::default()
        };
        let id = group.clone();
        self.sync_group(&group).await?;
        self.after_last_commit().await;
        let update = self
            .mdk(move |mdk| Ok(mdk.update_group_data(&id, update)?))
            .await?;
        self.commit(group.clone(), update).await?;
        self.view(group).await
    }

    /// Leave `group`: ask the others to remove this identity, then forget the
    /// group here.
    pub async fn leave(&self, group: &str) -> Result<(), ChatError> {
        let id = group_id(group)?;
        let relays = self.group_relays(id.clone()).await?;
        let leaving = id.clone();
        self.sync_group(&id).await?;
        self.after_last_commit().await;
        let request = self.mdk(move |mdk| Ok(mdk.leave_group(&leaving)?)).await?;
        let request: on::Event = cross(&request.evolution_event)?;
        self.inner
            .relays
            .publish_to(&relays, &request, self.timeout())
            .await?;
        self.forget(group).await
    }

    /// Delete everything this store holds about `group`. Nobody is told.
    pub async fn forget(&self, group: &str) -> Result<(), ChatError> {
        let id = group_id(group)?;
        if let Some(subscription) = self.inner.followed.lock().await.remove(group) {
            let _ = self.inner.relays.unsubscribe(&subscription).await;
        }
        self.mdk(move |mdk| Ok(mdk.delete_group(&id)?)).await
    }

    /// Send a message of `kind` ([`crate::KIND_CHAT`], [`crate::KIND_FILE`])
    /// to `group`.
    pub async fn send(
        &self,
        group: &str,
        kind: u16,
        content: &str,
        tags: &[Vec<String>],
    ) -> Result<ChatMessage, ChatError> {
        let id = group_id(group)?;
        let relays = self.group_relays(id.clone()).await?;
        let tags = tags
            .iter()
            .map(|tag| mn::Tag::parse(tag.iter().map(String::as_str)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ChatError::Invalid(error.to_string()))?;
        self.after_last_commit().await;
        let mut rumor = mn::EventBuilder::new(mn::Kind::Custom(kind), content)
            .tags(tags)
            .build(self.inner.me);
        rumor.ensure_id();
        let message = message_view(&self.inner.me, &id, &rumor);
        let event = self
            .mdk(move |mdk| Ok(mdk.create_message(&id, rumor, None)?))
            .await?;
        let event: on::Event = cross(&event)?;
        self.inner
            .relays
            .publish_to(&relays, &event, self.timeout())
            .await?;
        Ok(message)
    }

    /// Every group in the store, active or not.
    pub async fn groups(&self) -> Result<Vec<GroupView>, ChatError> {
        self.mdk(|mdk| {
            mdk.get_groups()?
                .into_iter()
                .map(|group| group_view(mdk, group))
                .collect()
        })
        .await
    }

    /// The newest `limit` messages of `group`, oldest first.
    pub async fn messages(&self, group: &str, limit: usize) -> Result<Vec<ChatMessage>, ChatError> {
        let id = group_id(group)?;
        let me = self.inner.me;
        self.mdk(move |mdk| {
            let mut messages: Vec<ChatMessage> = mdk
                .get_messages(&id, Some(Pagination::new(Some(limit), Some(0))))?
                .iter()
                .map(|message| stored_message_view(&me, message))
                .collect();
            messages.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
            Ok(messages)
        })
        .await
    }

    async fn view(&self, group: GroupId) -> Result<GroupView, ChatError> {
        self.mdk(move |mdk| {
            let stored = mdk
                .get_group(&group)?
                .ok_or_else(|| ChatError::UnknownGroup(hex::encode(group.as_slice())))?;
            group_view(mdk, stored)
        })
        .await
    }

    async fn group_relays(&self, group: GroupId) -> Result<Vec<String>, ChatError> {
        let relays = self
            .mdk(move |mdk| {
                if mdk.get_group(&group)?.is_none() {
                    return Err(ChatError::UnknownGroup(hex::encode(group.as_slice())));
                }
                Ok(mdk.get_relays(&group)?)
            })
            .await?;
        if relays.is_empty() {
            return Ok(self.inner.config.relays.clone());
        }
        Ok(relays.iter().map(ToString::to_string).collect())
    }

    /// Handle one event from a relay: a gift wrap holding a welcome, or a
    /// group event. Anything else, or anything not for this identity, is
    /// nothing to show. What it yields also goes to [`ChatEngine::events`].
    pub async fn ingest(&self, event: &on::Event) -> Result<Vec<ChatEvent>, ChatError> {
        let happened = if event.kind == on::Kind::GiftWrap {
            self.ingest_gift_wrap(event).await?
        } else if event.kind == on::Kind::Custom(KIND_GROUP_EVENT) {
            self.ingest_group_event(event).await?
        } else {
            Vec::new()
        };
        for event in &happened {
            // Nobody reading is fine: the store keeps what was read.
            let _ = self.inner.events.send(event.clone());
        }
        Ok(happened)
    }

    /// Everything read from relays from now on -- by [`ChatEngine::listen`],
    /// [`ChatEngine::catch_up`], or the read before a commit -- each event
    /// once. A reader too slow to keep [`EVENT_BUFFER`] events loses the
    /// oldest, and should reload [`ChatEngine::groups`] and
    /// [`ChatEngine::messages`].
    pub fn events(&self) -> impl Stream<Item = ChatEvent> + Send + 'static {
        futures::stream::unfold(self.inner.events.subscribe(), |mut events| async move {
            loop {
                match events.recv().await {
                    Ok(event) => return Some((event, events)),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
    }

    async fn ingest_gift_wrap(&self, event: &on::Event) -> Result<Vec<ChatEvent>, ChatError> {
        // Not ours to open, or not a welcome (a NIP-17 message, say): the
        // TypeScript engine and the DM inbox read the same gift wraps.
        let Ok(opened) = nip59::open(&self.inner.keys, event) else {
            return Ok(Vec::new());
        };
        if opened.rumor.kind != on::Kind::Custom(KIND_WELCOME) {
            return Ok(Vec::new());
        }
        let welcomed_at = opened.rumor.created_at.as_secs();
        let rumor: mn::UnsignedEvent = cross(&opened.rumor)?;
        let wrapper: mn::EventId = cross(&event.id)?;
        // Welcomes in the TypeScript engine's format, or for a key package
        // this store never made, are that engine's: MDK refuses them.
        let joined = self
            .mdk(move |mdk| {
                let Ok(welcome) = mdk.process_welcome(&wrapper, &rumor) else {
                    return Ok(None);
                };
                // MDK hands back a welcome it has already handled; accepting
                // it again would rebuild the group from the welcome's epoch.
                if welcome.state != welcome_types::WelcomeState::Pending {
                    return Ok(None);
                }
                mdk.accept_welcome(&welcome)?;
                Ok(Some(welcome.mls_group_id))
            })
            .await?;
        let Some(group) = joined else {
            return Ok(Vec::new());
        };
        // The commit that added this identity was made with the welcome.
        self.saw_commit_at(welcomed_at).await;
        // Best effort here; a catch-up retries it while MDK still flags it.
        let _ = self.self_update(group.clone()).await;
        self.follow(&group).await;
        Ok(vec![ChatEvent::Joined(self.view(group).await?)])
    }

    async fn ingest_group_event(&self, event: &on::Event) -> Result<Vec<ChatEvent>, ChatError> {
        let crossed: mn::Event = cross(event)?;
        let made_at = event.created_at.as_secs();
        let me = self.inner.me;
        let outcome = self
            .mdk(move |mdk| {
                // MDK records every group event it has handled, ours
                // included. Relays hand the same events back on every read,
                // and each is shown once: only one never seen, or one MDK
                // marked to retry after rolling an epoch back, is processed.
                let seen = mdk
                    .provider
                    .storage()
                    .find_processed_message_by_event_id(&crossed.id)
                    .map_err(|error| ChatError::Store(error.to_string()))?;
                if seen.is_some_and(|seen| seen.state != ProcessedMessageState::Retryable) {
                    return Ok(None);
                }
                match mdk.process_message(&crossed) {
                    Ok(result) => Ok(Some(result)),
                    // One this store cannot read (another epoch, another
                    // client's group): nothing to show.
                    Err(_) => Ok(None),
                }
            })
            .await?;
        Ok(match outcome {
            Some(MessageProcessingResult::ApplicationMessage(message)) => {
                vec![ChatEvent::Message(stored_message_view(&me, &message))]
            }
            Some(MessageProcessingResult::Commit { mls_group_id }) => {
                self.saw_commit_at(made_at).await;
                self.changed(mls_group_id).await?
            }
            Some(MessageProcessingResult::PendingProposal { mls_group_id })
            | Some(MessageProcessingResult::ExternalJoinProposal { mls_group_id }) => {
                self.changed(mls_group_id).await?
            }
            Some(MessageProcessingResult::Proposal(update)) => {
                // MDK committed a member's request to leave on this
                // identity's behalf; the commit goes out like any other.
                let group = update.mls_group_id.clone();
                self.commit(group.clone(), update).await?;
                self.changed(group).await?
            }
            _ => Vec::new(),
        })
    }

    async fn changed(&self, group: GroupId) -> Result<Vec<ChatEvent>, ChatError> {
        let view = self.view(group).await?;
        if !view.active {
            if let Some(subscription) = self.inner.followed.lock().await.remove(&view.mls_group_id)
            {
                let _ = self.inner.relays.unsubscribe(&subscription).await;
            }
        }
        Ok(vec![ChatEvent::Changed(view)])
    }

    /// Read what relays hold since the last read: welcomes first, then each
    /// group's events in the order they were written.
    pub async fn catch_up(&self) -> Result<Vec<ChatEvent>, ChatError> {
        let now = on::Timestamp::now().as_secs();
        let (inbox_since, groups_since) = {
            let state = self.inner.state.lock().await;
            (
                state
                    .inbox_read_until
                    .unwrap_or(now.saturating_sub(FIRST_READ))
                    .saturating_sub(GIFT_WRAP_SKEW),
                state
                    .groups_read_until
                    .unwrap_or(now.saturating_sub(FIRST_READ))
                    .saturating_sub(CLOCK_MARGIN),
            )
        };
        let mut happened = Vec::new();

        let mut wraps = self
            .inner
            .relays
            .fetch(
                &self.inner.config.relays,
                on::Filter::new()
                    .kind(on::Kind::GiftWrap)
                    .pubkey(self.inner.keys.public_key())
                    .since(on::Timestamp::from(inbox_since)),
                self.timeout(),
            )
            .await?;
        wraps.sort_by_key(|event| event.created_at);
        for wrap in &wraps {
            happened.extend(self.ingest(wrap).await?);
        }

        for group in self
            .groups()
            .await?
            .into_iter()
            .filter(|group| group.active)
        {
            let mut events = self
                .inner
                .relays
                .fetch(
                    &group.relays,
                    group_filter(&group.nostr_group_id).since(on::Timestamp::from(groups_since)),
                    self.timeout(),
                )
                .await
                .unwrap_or_default();
            events.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
            for event in &events {
                happened.extend(self.ingest(event).await?);
            }
        }

        let due = self
            .mdk(|mdk| Ok(mdk.groups_needing_self_update(SELF_UPDATE_INTERVAL)?))
            .await?;
        for group in due {
            // A relay that refuses now is tried again at the next catch-up.
            let _ = self.self_update(group).await;
        }

        let mut state = self.inner.state.lock().await;
        state.inbox_read_until = Some(now);
        state.groups_read_until = Some(now);
        self.save_state(&state).await?;
        Ok(happened)
    }

    /// Follow `group`'s events live, if [`ChatEngine::listen`] is running.
    async fn follow(&self, group: &GroupId) {
        if self.inner.pump.lock().await.is_none() {
            return;
        }
        let handle = hex::encode(group.as_slice());
        let mut followed = self.inner.followed.lock().await;
        if followed.contains_key(&handle) {
            return;
        }
        let Ok(view) = self.view(group.clone()).await else {
            return;
        };
        let since = on::Timestamp::now().as_secs().saturating_sub(CLOCK_MARGIN);
        if let Ok(subscription) = self
            .inner
            .relays
            .subscribe_to(
                &view.relays,
                group_filter(&view.nostr_group_id).since(on::Timestamp::from(since)),
                self.timeout(),
            )
            .await
        {
            followed.insert(handle, subscription);
        }
    }

    /// Read relays live: welcomes to this identity and the events of every
    /// active group, groups joined later included. What is read goes to
    /// [`ChatEngine::events`]. Listening again while listening does nothing.
    pub async fn listen(&self) -> Result<(), ChatError> {
        let mut pump = self.inner.pump.lock().await;
        if pump.is_some() {
            return Ok(());
        }
        // Taken before subscribing, so nothing the relays send in between is
        // missed.
        let notifications = self.inner.relays.events();
        let since = on::Timestamp::now()
            .as_secs()
            .saturating_sub(GIFT_WRAP_SKEW);
        let inbox = self
            .inner
            .relays
            .subscribe_to(
                &self.inner.config.relays,
                on::Filter::new()
                    .kind(on::Kind::GiftWrap)
                    .pubkey(self.inner.keys.public_key())
                    .since(on::Timestamp::from(since)),
                self.timeout(),
            )
            .await?;
        let engine = self.clone();
        let task = tokio::spawn(async move {
            let mut notifications = std::pin::pin!(notifications);
            while let Some((_, event)) = notifications.next().await {
                // One event the store cannot take does not stop the rest.
                let _ = engine.ingest(&event).await;
            }
        });
        *pump = Some(Pump {
            task: task.abort_handle(),
            inbox,
        });
        drop(pump);
        for group in self
            .groups()
            .await?
            .into_iter()
            .filter(|group| group.active)
        {
            self.follow(&group_id(&group.mls_group_id)?).await;
        }
        Ok(())
    }

    /// Stop reading relays live.
    pub async fn stop_listening(&self) {
        let Some(pump) = self.inner.pump.lock().await.take() else {
            return;
        };
        pump.task.abort();
        let _ = self.inner.relays.unsubscribe(&pump.inbox).await;
        let followed = std::mem::take(&mut *self.inner.followed.lock().await);
        for subscription in followed.values() {
            let _ = self.inner.relays.unsubscribe(subscription).await;
        }
    }

    /// Stop listening and close the relays.
    pub async fn shutdown(&self) {
        self.stop_listening().await;
        self.inner.relays.shutdown().await;
    }
}

fn group_filter(nostr_group_id: &str) -> on::Filter {
    on::Filter::new()
        .kind(on::Kind::Custom(KIND_GROUP_EVENT))
        .custom_tag(on::SingleLetterTag::LOWERCASE_H, nostr_group_id)
}

fn tag_values(event: &on::Event, name: &str) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    for tag in event.tags.iter() {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) == Some(name) {
            for value in &slice[1..] {
                if !values.contains(value) {
                    values.push(value.clone());
                }
            }
        }
    }
    values
}

fn public_key(hex: &str) -> Result<on::PublicKey, ChatError> {
    on::PublicKey::parse(hex).map_err(|error| ChatError::Invalid(format!("{hex}: {error}")))
}

fn group_id(hex: &str) -> Result<GroupId, ChatError> {
    let bytes =
        hex::decode(hex).map_err(|error| ChatError::Invalid(format!("group {hex}: {error}")))?;
    Ok(GroupId::from_slice(&bytes))
}

fn mdk_relays(urls: &[String]) -> Result<Vec<mn::RelayUrl>, ChatError> {
    urls.iter()
        .map(|url| {
            mn::RelayUrl::parse(url).map_err(|error| ChatError::Invalid(format!("{url}: {error}")))
        })
        .collect()
}

fn group_view<S: MdkStorageProvider>(
    mdk: &MDK<S>,
    group: group_types::Group,
) -> Result<GroupView, ChatError> {
    let active = group.state == group_types::GroupState::Active;
    let members: BTreeSet<mn::PublicKey> = if active {
        mdk.get_members(&group.mls_group_id)?
    } else {
        BTreeSet::new()
    };
    let relays = mdk.get_relays(&group.mls_group_id).unwrap_or_default();
    Ok(GroupView {
        mls_group_id: hex::encode(group.mls_group_id.as_slice()),
        nostr_group_id: hex::encode(group.nostr_group_id),
        name: group.name,
        description: group.description,
        admins: group.admin_pubkeys.iter().map(|key| key.to_hex()).collect(),
        members: members.iter().map(|key| key.to_hex()).collect(),
        relays: relays.iter().map(ToString::to_string).collect(),
        active,
        epoch: group.epoch,
    })
}

fn message_view(me: &mn::PublicKey, group: &GroupId, rumor: &mn::UnsignedEvent) -> ChatMessage {
    ChatMessage {
        id: rumor.id.map(|id| id.to_hex()).unwrap_or_default(),
        mls_group_id: hex::encode(group.as_slice()),
        from: rumor.pubkey.to_hex(),
        kind: rumor.kind.as_u16(),
        content: rumor.content.clone(),
        tags: rumor
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
        at: rumor.created_at.as_secs(),
        mine: rumor.pubkey == *me,
    }
}

fn stored_message_view(me: &mn::PublicKey, message: &message_types::Message) -> ChatMessage {
    ChatMessage {
        id: message.id.to_hex(),
        mls_group_id: hex::encode(message.mls_group_id.as_slice()),
        from: message.pubkey.to_hex(),
        kind: message.kind.as_u16(),
        content: message.content.clone(),
        tags: message
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
        at: message.created_at.as_secs(),
        mine: message.pubkey == *me,
    }
}
