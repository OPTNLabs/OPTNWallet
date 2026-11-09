//! A wallet's fusion depth record (`optn_core::fusion::depth`) on disk, for
//! native hosts.
//!
//! The wallet runtime now seals the record with the wallet's encrypted
//! checkpoint (`AppRuntime::record_fusion_round`). This plaintext file is what
//! earlier CLI builds wrote; the CLI reads it once, merges it into the sealed
//! record and removes it.
//!
//! One JSON document per wallet holding the same three stored forms the desktop
//! keeps (coins, txid depths, fusion txids), so a record moves between surfaces
//! unchanged. Written whole to a temporary file and renamed over the old one, so
//! a crash leaves either the old record or the new one.
//!
//! A document that is not JSON at all is refused rather than read as empty: an
//! empty record reads every coin as depth 0, and Auto would pay again to redo
//! mixing those coins already have. Damage inside a part is tolerated the way
//! the book tolerates it.

use std::path::{Path, PathBuf};

use optn_core::fusion::depth::FusionDepthBook;
use serde_json::{json, Value};

pub const DEPTH_FILE_VERSION: u64 = 1;

pub struct DepthFile {
    path: PathBuf,
}

impl DepthFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored record; an absent file is an empty record.
    pub fn load(&self) -> Result<FusionDepthBook, String> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FusionDepthBook::new())
            }
            Err(error) => return Err(format!("cannot read {}: {error}", self.path.display())),
        };
        let document: Value = serde_json::from_str(&text).map_err(|error| {
            format!(
                "{} is not a fusion depth record ({error}); refusing to treat it as empty",
                self.path.display()
            )
        })?;
        let version = document.get("version").and_then(Value::as_u64);
        if version != Some(DEPTH_FILE_VERSION) {
            return Err(format!(
                "{} is fusion depth record version {version:?}; this build reads {DEPTH_FILE_VERSION}",
                self.path.display()
            ));
        }
        let part = |name: &str| document.get(name).map(Value::to_string);
        Ok(FusionDepthBook::from_stored(
            part("coins").as_deref(),
            part("txDepth").as_deref(),
            part("txids").as_deref(),
        ))
    }

    /// Replace the stored record with `book`.
    pub fn save(&self, book: &FusionDepthBook) -> Result<(), String> {
        let parse = |stored: String| -> Result<Value, String> {
            serde_json::from_str(&stored).map_err(|error| error.to_string())
        };
        let document = json!({
            "version": DEPTH_FILE_VERSION,
            "coins": parse(book.stored_coins())?,
            "txDepth": parse(book.stored_tx_depth())?,
            "txids": parse(book.stored_txids())?,
        });
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, document.to_string())
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        std::fs::rename(&temporary, &self.path)
            .map_err(|error| format!("cannot replace {}: {error}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path no other test uses.
    fn temporary() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "optn-fusion-depth-{}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ))
    }

    #[test]
    fn an_absent_file_is_empty_and_a_saved_record_reads_back() {
        let file = DepthFile::new(temporary());
        assert_eq!(file.load().unwrap(), FusionDepthBook::new());
        let mut book = FusionDepthBook::new();
        book.record_round(
            &["in:0".to_string()],
            &[format!("{}:2", "ab".repeat(32))],
            7,
        );
        file.save(&book).unwrap();
        assert_eq!(file.load().unwrap(), book);
        assert!(!file.path().with_extension("json.tmp").exists());
        std::fs::remove_file(file.path()).unwrap();
    }

    #[test]
    fn a_damaged_or_foreign_document_is_refused_not_emptied() {
        let file = DepthFile::new(temporary());
        std::fs::write(file.path(), "not json").unwrap();
        assert!(file.load().unwrap_err().contains("refusing"));
        std::fs::write(file.path(), r#"{"version":2}"#).unwrap();
        assert!(file.load().unwrap_err().contains("version"));
        std::fs::remove_file(file.path()).unwrap();
    }
}
