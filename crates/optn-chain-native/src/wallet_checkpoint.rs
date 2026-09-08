//! Native encrypted HD restart files. No Tauri, renderer, or key-store access.
//! The host supplies its already-unlocked wallet key and an explicit path.

use crate::network_config::{lock_file, read_bounded, write_atomically};
use optn_core::{
    header_hash::sha256d,
    wallet_pack::{PackKey, NONCE_LEN},
};
use optn_runtime::wallet_checkpoint::{
    WalletCheckpoint, WalletCheckpointStorage, MAX_CHECKPOINT_BYTES,
};
use rand_core::{OsRng, RngCore};
use std::path::PathBuf;

/// One directory for a native host's account-scoped restart files. Identifiers
/// are hashes supplied by the runtime, never renderer paths or private keys.
pub struct WalletCheckpointDirectory(pub PathBuf);

impl WalletCheckpointStorage for WalletCheckpointDirectory {
    fn load(
        &self,
        id: &[u8; 32],
        key: &PackKey,
    ) -> Result<Option<(WalletCheckpoint, [u8; 32])>, String> {
        WalletCheckpointFile::new(self.0.join(hex::encode(id)).with_extension("state")).load(key)
    }

    fn store(
        &self,
        id: &[u8; 32],
        checkpoint: &WalletCheckpoint,
        key: &PackKey,
        expected: Option<[u8; 32]>,
    ) -> Result<[u8; 32], String> {
        WalletCheckpointFile::new(self.0.join(hex::encode(id)).with_extension("state"))
            .store(checkpoint, key, expected)
    }
}

#[derive(Clone)]
pub struct WalletCheckpointFile {
    path: PathBuf,
}

impl WalletCheckpointFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The ciphertext digest is a compare-and-swap token, not a trust anchor.
    pub fn load(&self, key: &PackKey) -> Result<Option<(WalletCheckpoint, [u8; 32])>, String> {
        let Some(bytes) = read_bounded(&self.path, MAX_CHECKPOINT_BYTES as u64)? else {
            return Ok(None);
        };
        Ok(Some((
            WalletCheckpoint::open(key, &bytes)?,
            sha256d(&bytes),
        )))
    }

    /// Preserve another process's newer state. `None` creates a new file only;
    /// overwrites require the revision returned by a successful load/write.
    /// This prevents accidental lost updates, not malicious disk rollback.
    // ponytail: rewrite the bounded checkpoint atomically; move to a journal
    // only if measured wallet history makes whole-file writes impractical.
    pub fn store(
        &self,
        checkpoint: &WalletCheckpoint,
        key: &PackKey,
        expected: Option<[u8; 32]>,
    ) -> Result<[u8; 32], String> {
        let _lock = lock_file(&self.path)
            .map_err(|error| format!("wallet state is busy or cannot be locked: {error}"))?;
        let previous = read_bounded(&self.path, MAX_CHECKPOINT_BYTES as u64)?;
        if previous.as_deref().map(sha256d) != expected {
            return Err("wallet state changed in another process; reload before saving".into());
        }
        if let Some(previous) = previous {
            if !WalletCheckpoint::open(key, &previous)?.same_wallet(checkpoint) {
                return Err("cannot overwrite another wallet's checkpoint".into());
            }
        }
        let mut nonce = [0u8; NONCE_LEN];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| "OS randomness unavailable for wallet state")?;
        let bytes = checkpoint.seal(key, &nonce)?;
        write_atomically(&self.path, &bytes).map_err(|error| error.to_string())?;
        Ok(sha256d(&bytes))
    }
}
