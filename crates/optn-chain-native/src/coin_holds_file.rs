//! Durable per-wallet coin holds, stored the way every other native setting is.
//!
//! One file per wallet: a hold belongs to the wallet whose coin it is, and
//! keeping them together would let one wallet's entries be read while another
//! is open. The read/modify/write is serialized with the same sidecar lock the
//! network configuration uses, because two windows freezing coins at once must
//! not lose one of the holds — a lost hold is a coin that gets spent.

use crate::network_config::{lock_file, read_bounded, write_atomically};
use optn_runtime::coin_holds::CoinHolds;
use std::path::PathBuf;

/// Generous for a list of outpoints, small enough that a corrupt or hostile
/// file cannot be read into memory unbounded.
const MAX_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
pub struct CoinHoldsFile {
    path: PathBuf,
}

impl CoinHoldsFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<CoinHolds, String> {
        let Some(bytes) = read_bounded(&self.path, MAX_BYTES)? else {
            return Ok(CoinHolds::default());
        };
        let text = std::str::from_utf8(&bytes).map_err(|_| "coin holds are not UTF-8")?;
        serde_json::from_str::<CoinHolds>(text)
            .map_err(|error| format!("coin holds file is unreadable: {error}"))?
            .accept()
            .map_err(|error| error.to_string())
    }

    /// Read, edit and write under one lock.
    pub fn update(
        &self,
        edit: impl FnOnce(&mut CoinHolds) -> Result<(), String>,
    ) -> Result<CoinHolds, String> {
        let _lock = lock_file(&self.path)
            .map_err(|error| format!("coin holds are busy or cannot be locked: {error}"))?;
        let mut holds = self.load()?;
        edit(&mut holds)?;
        let bytes = serde_json::to_vec_pretty(&holds)
            .map_err(|error| format!("cannot encode coin holds: {error}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("too many coin holds to store".into());
        }
        write_atomically(&self.path, &bytes).map_err(|error| error.to_string())?;
        Ok(holds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::coins::FreezeReason;

    const TXID: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn temporary() -> PathBuf {
        let unique = format!(
            "optn-holds-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn a_missing_file_is_an_empty_record_rather_than_an_error() {
        // A wallet that has never frozen anything has no file, and refusing to
        // open its coin list over that would be absurd.
        let file = CoinHoldsFile::new(temporary());
        assert_eq!(file.load().unwrap(), CoinHolds::default());
    }

    #[test]
    fn a_hold_survives_being_written_and_read_back() {
        let path = temporary();
        let file = CoinHoldsFile::new(path.clone());
        file.update(|holds| {
            holds
                .hold(TXID, 3, FreezeReason::User, Some("rent".into()))
                .map_err(|error| error.to_string())
        })
        .unwrap();

        let reloaded = CoinHoldsFile::new(path.clone()).load().unwrap();
        assert!(reloaded.is_held(TXID, 3));
        assert_eq!(reloaded.holds[0].note.as_deref(), Some("rent"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("lock"));
    }

    #[test]
    fn a_file_this_build_cannot_read_is_refused_rather_than_replaced() {
        // Overwriting it would drop holds this build cannot see.
        let path = temporary();
        std::fs::write(&path, br#"{"schema_version":99,"holds":[]}"#).unwrap();
        let file = CoinHoldsFile::new(path.clone());
        assert!(file.load().is_err());
        assert!(file.update(|_| Ok(())).is_err());
        assert!(std::fs::read_to_string(&path).unwrap().contains("99"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("lock"));
    }
}
