//! NIP-17 private messages: a kind-14 rumor, sealed (kind 13) by the sender
//! and gift-wrapped (kind 1059) by a one-time key with a scrambled timestamp,
//! per NIP-59.
//!
//! The same envelope the TypeScript peers make and read with nostr-tools'
//! `wrapEvent` / `unwrapEvent`, so a Rust peer and a TypeScript peer exchange
//! the same bytes. On the wire a P2P CashFusion round message is any other
//! private message: the addressing (an ephemeral round key) keeps it apart from
//! chat, not the kind.

use nostr::nips::nip17::PrivateDirectMessageBuilder;
use nostr::nips::nip59::UnwrappedGift;
use nostr::prelude::{Event, FinalizeEvent, Keys, Kind, PublicKey};

/// A private message, opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateMessage {
    /// Who sealed it: proven by the seal's signature, not by the outer event,
    /// whose author is a one-time key.
    pub sender: PublicKey,
    pub content: String,
}

/// Why a private message could not be made or opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nip17Error(pub String);

impl std::fmt::Display for Nip17Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NIP-17 private message: {}", self.0)
    }
}

impl std::error::Error for Nip17Error {}

/// `content` from `sender` to `receiver`, gift-wrapped.
pub fn wrap(sender: &Keys, receiver: &PublicKey, content: &str) -> Result<Event, Nip17Error> {
    PrivateDirectMessageBuilder::new(*receiver, content)
        .finalize(sender)
        .map_err(|error| Nip17Error(error.to_string()))
}

/// Open a gift wrap addressed to `receiver`. The outer event and the seal are
/// verified, and only a kind-14 rumor is a private message.
pub fn unwrap(receiver: &Keys, wrapped: &Event) -> Result<PrivateMessage, Nip17Error> {
    let gift = UnwrappedGift::from_gift_wrap(receiver, wrapped)
        .map_err(|error| Nip17Error(error.to_string()))?;
    if gift.rumor.kind != Kind::PrivateDirectMessage {
        return Err(Nip17Error(format!(
            "the sealed event is kind {}, not a private message",
            gift.rumor.kind.as_u16()
        )));
    }
    // The rumor is unsigned: its author must be the key that sealed it, or
    // anyone could put words in another peer's mouth inside a valid seal.
    if gift.rumor.pubkey != gift.sender {
        return Err(Nip17Error(
            "the message names a different author than the key that sealed it".into(),
        ));
    }
    Ok(PrivateMessage {
        sender: gift.sender,
        content: gift.rumor.content,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::prelude::{EventBuilder, FinalizeUnsignedEvent, Tag, Timestamp};

    #[test]
    fn a_message_opens_only_for_its_receiver() {
        let sender = Keys::generate();
        let receiver = Keys::generate();
        let stranger = Keys::generate();
        let wrapped = wrap(&sender, &receiver.public_key(), r#"{"type":"round_ack"}"#).unwrap();

        assert_eq!(wrapped.kind, Kind::GiftWrap);
        // The outer author is a one-time key, not the sender.
        assert_ne!(wrapped.pubkey, sender.public_key());
        let opened = unwrap(&receiver, &wrapped).unwrap();
        assert_eq!(opened.sender, sender.public_key());
        assert_eq!(opened.content, r#"{"type":"round_ack"}"#);
        assert!(unwrap(&stranger, &wrapped).is_err());
    }

    #[test]
    fn a_tampered_wrap_is_refused() {
        let sender = Keys::generate();
        let receiver = Keys::generate();
        let mut wrapped = wrap(&sender, &receiver.public_key(), "hello").unwrap();
        wrapped.content.push('A');
        assert!(unwrap(&receiver, &wrapped).is_err());
    }

    const INTEROP: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/nostr-nip17-interop.json"
    );

    fn interop() -> (serde_json::Value, Keys) {
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(INTEROP).unwrap()).unwrap();
        let receiver = Keys::parse(fixture["receiver_secret_hex"].as_str().unwrap()).unwrap();
        (fixture, receiver)
    }

    /// TypeScript peers wrap round messages with nostr-tools; a Rust peer
    /// must open them, and the vitest beside the TypeScript transport checks
    /// the reverse. The fixture holds one wrap from each side.
    #[test]
    fn a_wrap_made_by_nostr_tools_opens_here() {
        let (fixture, receiver) = interop();
        for side in ["from_nostr_tools", "from_rust"] {
            let wrapped = Event::from_json(fixture[side].to_string())
                .unwrap_or_else(|error| panic!("{side}: {error}"));
            let opened =
                unwrap(&receiver, &wrapped).unwrap_or_else(|error| panic!("{side}: {error}"));
            assert_eq!(
                opened.sender.to_hex(),
                fixture["sender_pubkey_hex"].as_str().unwrap(),
                "{side}"
            );
            assert_eq!(
                opened.content,
                fixture["content"].as_str().unwrap(),
                "{side}"
            );
        }
    }

    /// Writes this side's wrap into the interop fixture. Run once with
    /// `--ignored` when the nostr-tools side is regenerated.
    #[test]
    #[ignore]
    fn write_interop_fixture() {
        let (mut fixture, receiver) = interop();
        let sender = Keys::parse(&"22".repeat(32)).unwrap();
        assert_eq!(
            sender.public_key().to_hex(),
            fixture["sender_pubkey_hex"].as_str().unwrap()
        );
        let wrapped = wrap(
            &sender,
            &receiver.public_key(),
            fixture["content"].as_str().unwrap(),
        )
        .unwrap();
        fixture["from_rust"] = serde_json::from_str(&wrapped.as_json()).unwrap();
        std::fs::write(
            INTEROP,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
    }

    #[test]
    fn only_a_kind_14_rumor_is_a_private_message() {
        use nostr::nips::nip59::GiftWrapBuilder;
        let sender = Keys::generate();
        let receiver = Keys::generate();
        let note = EventBuilder::new(Kind::TextNote, "not a DM")
            .tag(Tag::public_key(receiver.public_key()))
            .custom_created_at(Timestamp::now())
            .finalize_unsigned(sender.public_key());
        let wrapped = GiftWrapBuilder::new(receiver.public_key(), note)
            .finalize(&sender)
            .unwrap();
        assert!(unwrap(&receiver, &wrapped).is_err());
    }
}
