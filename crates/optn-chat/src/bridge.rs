//! Between MDK's rust-nostr (0.44) and the relays' (0.45, `optn-nostr`).
//!
//! Events, unsigned events, tags, ids and keys cross as their NIP-01 JSON,
//! which both releases write and read the same way. An event's id and
//! signature cover that serialization, so a crossed event still verifies.

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::ChatError;

/// `value` as the other release's type.
pub(crate) fn cross<T, U>(value: &T) -> Result<U, ChatError>
where
    T: Serialize,
    U: DeserializeOwned,
{
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|error| ChatError::Invalid(format!("Nostr value across releases: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdk_nostr as mn;
    use optn_nostr::nostr::prelude as on;
    use optn_nostr::nostr::prelude::FinalizeEvent;

    #[test]
    fn a_signed_event_crosses_and_still_verifies() {
        let keys = on::Keys::generate();
        let event = on::EventBuilder::new(on::Kind::Custom(445), "payload")
            .tag(on::Tag::parse(["h", &"ab".repeat(32)]).unwrap())
            .finalize(&keys)
            .unwrap();
        let crossed: mn::Event = cross(&event).unwrap();
        crossed.verify().unwrap();
        assert_eq!(crossed.id.to_hex(), event.id.to_hex());

        let back: on::Event = cross(&crossed).unwrap();
        assert_eq!(back, event);

        let key: mn::PublicKey = cross(&keys.public_key()).unwrap();
        assert_eq!(key.to_hex(), keys.public_key().to_hex());
    }
}
