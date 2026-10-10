//! What the engine keeps beside MDK's store: the key-package slot and how far
//! the inbox and the groups have been read. Nothing secret -- the slot is
//! public on relays and the rest are timestamps -- so it is a plain file next
//! to the encrypted store, written whole and renamed into place.

use std::path::{Path, PathBuf};

use hkdf::Hkdf;
use optn_nostr::nostr::prelude::Keys;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::ChatError;

/// The engine's own bookkeeping.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    /// The `d` tag of this device's key-package slot. Relays keep one event
    /// per slot, so a rotated key package replaces the last one.
    pub key_package_slot: Option<String>,
    /// Hash refs (hex) of the key packages published from this store, oldest
    /// first. The newest two keep their private keys, so a welcome for the one
    /// just replaced can still be read; older ones are deleted.
    pub key_packages: Vec<String>,
    /// When the current key package was published, seconds.
    pub key_package_published_at: Option<u64>,
    /// Gift wraps addressed here have been read up to this time, seconds.
    pub inbox_read_until: Option<u64>,
    /// Group events have been read up to this time, seconds.
    pub groups_read_until: Option<u64>,
}

impl EngineState {
    /// The state saved at `path`, or a fresh one if there is none.
    pub fn load(path: &Path) -> Result<Self, ChatError> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| ChatError::Store(format!("{}: {error}", path.display()))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(ChatError::Store(format!("{}: {error}", path.display()))),
        }
    }

    /// Write the state to `path`: whole, then renamed over the old file.
    pub fn save(&self, path: &Path) -> Result<(), ChatError> {
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|error| ChatError::Store(error.to_string()))?;
        let mut staged = PathBuf::from(path);
        staged.set_extension("json.tmp");
        std::fs::write(&staged, bytes)
            .and_then(|()| std::fs::rename(&staged, path))
            .map_err(|error| ChatError::Store(format!("{}: {error}", path.display())))
    }
}

/// The key that encrypts `identity`'s chat store: HKDF-SHA256 of the chat
/// identity's secret key. Whoever holds the wallet seed the identity comes
/// from can open the store; nobody else can.
pub fn store_key(identity: &Keys) -> Zeroizing<[u8; 32]> {
    let secret = Zeroizing::new(identity.secret_key().to_secret_bytes());
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(b"optn-chat"), secret.as_ref())
        .expand(b"mdk sqlcipher store v1", key.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_key_is_the_identitys_alone() {
        let one = Keys::generate();
        let other = Keys::generate();
        assert_eq!(*store_key(&one), *store_key(&one));
        assert_ne!(*store_key(&one), *store_key(&other));
        assert_ne!(
            store_key(&one).as_slice(),
            one.secret_key().to_secret_bytes().as_slice()
        );
    }

    #[test]
    fn state_round_trips_and_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        assert_eq!(EngineState::load(&path).unwrap(), EngineState::default());
        let state = EngineState {
            key_package_slot: Some("ab".repeat(32)),
            key_packages: vec!["01".into(), "02".into()],
            key_package_published_at: Some(5),
            inbox_read_until: Some(7),
            groups_read_until: Some(9),
        };
        state.save(&path).unwrap();
        assert_eq!(EngineState::load(&path).unwrap(), state);
        assert!(!path.with_extension("json.tmp").exists());
    }
}
