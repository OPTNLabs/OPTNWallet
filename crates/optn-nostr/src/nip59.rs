//! NIP-59 gift wraps for any rumor: the sender seals (kind 13) an unsigned
//! event, and a one-time key wraps the seal (kind 1059) with a scrambled
//! timestamp, so a relay sees neither who wrote it nor when.
//!
//! NIP-17 private messages ([`crate::nip17`]) are one kind of rumor; Marmot
//! welcomes (kind 444), which invite a member into an MLS group, are another.

use nostr::nips::nip59::{GiftWrapBuilder, UnwrappedGift};
use nostr::prelude::{Event, FinalizeEvent, Keys, PublicKey, UnsignedEvent};

/// A gift wrap, opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// Who sealed it: proven by the seal's signature, not by the outer event,
    /// whose author is a one-time key.
    pub sender: PublicKey,
    /// The unsigned event inside, authored by `sender`.
    pub rumor: UnsignedEvent,
}

/// Why a gift wrap could not be made or opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nip59Error(pub String);

impl std::fmt::Display for Nip59Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NIP-59 gift wrap: {}", self.0)
    }
}

impl std::error::Error for Nip59Error {}

const FOREIGN_AUTHOR: &str = "the rumor names a different author than the key that sealed it";

/// Seal `rumor` with `sender` and gift-wrap it to `receiver`. The rumor must
/// be authored by `sender`, or the receiver would refuse it.
pub fn wrap(
    sender: &Keys,
    receiver: &PublicKey,
    rumor: UnsignedEvent,
) -> Result<Event, Nip59Error> {
    if rumor.pubkey != sender.public_key() {
        return Err(Nip59Error(FOREIGN_AUTHOR.into()));
    }
    GiftWrapBuilder::new(*receiver, rumor)
        .finalize(sender)
        .map_err(|error| Nip59Error(error.to_string()))
}

/// Open a gift wrap addressed to `receiver`. The outer event and the seal are
/// verified, and the rumor must be authored by the key that sealed it.
pub fn open(receiver: &Keys, wrapped: &Event) -> Result<Opened, Nip59Error> {
    let gift = UnwrappedGift::from_gift_wrap(receiver, wrapped)
        .map_err(|error| Nip59Error(error.to_string()))?;
    // rust-nostr already binds the rumor's author to the seal; everything
    // downstream trusts that binding, so it is checked here too rather than
    // left to a dependency's behaviour.
    if gift.rumor.pubkey != gift.sender {
        return Err(Nip59Error(FOREIGN_AUTHOR.into()));
    }
    Ok(Opened {
        sender: gift.sender,
        rumor: gift.rumor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::prelude::{EventBuilder, FinalizeUnsignedEvent, Kind, Tag};

    fn rumor(author: &Keys, kind: u16, content: &str) -> UnsignedEvent {
        EventBuilder::new(Kind::Custom(kind), content)
            .tag(Tag::parse(["relays", "wss://relay.example.org"]).unwrap())
            .finalize_unsigned(author.public_key())
    }

    #[test]
    fn any_rumor_round_trips_to_its_receiver_only() {
        let sender = Keys::generate();
        let receiver = Keys::generate();
        let stranger = Keys::generate();
        let welcome = rumor(&sender, 444, "d2VsY29tZQ==");

        let wrapped = wrap(&sender, &receiver.public_key(), welcome.clone()).unwrap();
        assert_eq!(wrapped.kind, Kind::GiftWrap);
        assert_ne!(wrapped.pubkey, sender.public_key());

        let opened = open(&receiver, &wrapped).unwrap();
        assert_eq!(opened.sender, sender.public_key());
        assert_eq!(opened.rumor.kind, Kind::Custom(444));
        assert_eq!(opened.rumor.content, welcome.content);
        assert_eq!(opened.rumor.tags, welcome.tags);
        assert!(open(&stranger, &wrapped).is_err());
    }

    #[test]
    fn a_rumor_in_someone_elses_name_is_not_sealed() {
        let sender = Keys::generate();
        let impersonated = Keys::generate();
        let receiver = Keys::generate();
        assert_eq!(
            wrap(
                &sender,
                &receiver.public_key(),
                rumor(&impersonated, 444, "x")
            ),
            Err(Nip59Error(FOREIGN_AUTHOR.into()))
        );
    }
}
