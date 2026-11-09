#![forbid(unsafe_code)]

//! Marmot group chat (MLS over Nostr) for OPTN, through MDK.
//!
//! MDK -- the Marmot Development Kit, the MLS layer from the rust-nostr
//! project -- is used as published, unmodified. This crate gives it a store
//! keyed from the chat identity, the holder's relays ([`optn_nostr`]), and
//! turns what it returns into chat a wallet can show:
//!
//! - key packages (kind 30443, one slot per device, rotated in place) and the
//!   relay list that says where they are (kind 10051);
//! - groups created with members' key packages, welcomes gift-wrapped to each
//!   new member (NIP-59, kind 444 inside), and commits (kind 445) published to
//!   the group's relays before they are merged;
//! - text (kind 9) and inline files (kind 15) as MLS application messages;
//! - catching up from relays and listening live, with welcomes accepted as
//!   they arrive, as the TypeScript engine does.
//!
//! It runs beside the TypeScript ts-mls engine, which keeps every group it
//! made and everything MDK does not speak (the Paytaca envelope, the
//! account-identity proof, app-data profiles, gift-wrapped private groups,
//! groups whose required capabilities MDK lacks). `docs/chat-mdk.md` lists
//! those cases.

mod bridge;
mod engine;
mod state;

pub use engine::{ChatConfig, ChatEngine};
#[cfg(feature = "sqlite")]
pub use mdk_sqlite_storage::MdkSqliteStorage;
pub use state::{store_key, EngineState};

use serde::Serialize;

/// Key packages: addressable, one per device slot (MIP-00).
pub const KIND_KEY_PACKAGE: u16 = 30443;
/// Key packages as first published; still read, never written.
pub const KIND_KEY_PACKAGE_LEGACY: u16 = 443;
/// The relays a member keeps key packages on.
pub const KIND_KEY_PACKAGE_RELAYS: u16 = 10051;
/// A welcome into a group, always gift-wrapped (MIP-02).
pub const KIND_WELCOME: u16 = 444;
/// A group event: commit, proposal or application message (MIP-03).
pub const KIND_GROUP_EVENT: u16 = 445;
/// A chat message inside a group.
pub const KIND_CHAT: u16 = 9;
/// An inline file inside a group: the content is a `data:` URL.
pub const KIND_FILE: u16 = 15;

/// Why a chat operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatError {
    /// MDK refused the operation or failed in it.
    Mdk(String),
    /// The relays did.
    Relay(optn_nostr::RelayError),
    /// This member has published no key package MDK can use: they run no
    /// Marmot client yet. OPTN's TypeScript engine publishes an older format
    /// MDK does not read, so its users are invited from that engine.
    NoKeyPackage { member: String },
    /// No group with this id is in the store.
    UnknownGroup(String),
    /// A public key, group id or relay that does not parse.
    Invalid(String),
    /// The store or its state file could not be opened or written.
    Store(String),
    /// The store stopped after a fault and must be reopened.
    Stopped(String),
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatError::Mdk(reason) => write!(f, "MDK: {reason}"),
            ChatError::Relay(error) => write!(f, "{error}"),
            ChatError::NoKeyPackage { member } => write!(
                f,
                "{member} has published no Marmot key package yet; invite them from the \
                 TypeScript engine, or once they run a Marmot client"
            ),
            ChatError::UnknownGroup(group) => write!(f, "no chat group {group} in this store"),
            ChatError::Invalid(reason) => write!(f, "{reason}"),
            ChatError::Store(reason) => write!(f, "chat store: {reason}"),
            ChatError::Stopped(reason) => write!(f, "chat store stopped: {reason}"),
        }
    }
}

impl std::error::Error for ChatError {}

impl From<mdk_core::Error> for ChatError {
    fn from(error: mdk_core::Error) -> Self {
        ChatError::Mdk(error.to_string())
    }
}

impl From<optn_nostr::RelayError> for ChatError {
    fn from(error: optn_nostr::RelayError) -> Self {
        ChatError::Relay(error)
    }
}

/// A group, as the chat shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    /// The stable handle: the MLS group id, hex.
    pub mls_group_id: String,
    /// The id group events are tagged with (`h`), hex. A group may rotate it.
    pub nostr_group_id: String,
    pub name: String,
    pub description: String,
    /// Hex public keys of the admins, who may add, remove and rename.
    pub admins: Vec<String>,
    /// Hex public keys of the members.
    pub members: Vec<String>,
    pub relays: Vec<String>,
    /// False once this identity left or was removed.
    pub active: bool,
    pub epoch: u64,
}

/// A message in a group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// The inner event's id, hex.
    pub id: String,
    pub mls_group_id: String,
    /// Hex public key of the author, proven by the MLS sender's credential.
    pub from: String,
    /// [`KIND_CHAT`], [`KIND_FILE`], or whatever a peer's client sent.
    pub kind: u16,
    pub content: String,
    pub tags: Vec<Vec<String>>,
    /// The author's timestamp, seconds.
    pub at: u64,
    pub mine: bool,
}

/// Something that happened, for the chat to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Message(ChatMessage),
    /// A welcome was accepted: this identity is now in the group.
    Joined(GroupView),
    /// Members, name, admins or epoch changed, or this identity was removed
    /// (`active` false).
    Changed(GroupView),
}
