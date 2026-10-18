//! The renderer's fusion depth record, sealed by the renderer and kept here.
//!
//! Wallets whose keys live in the renderer's key database record CashFusion
//! depth (optn-core `fusion::depth`) in the renderer, in localStorage, which
//! WebView2 writes back lazily: in the fleet run a hard stop lost a round that
//! had been recorded. After each change the renderer seals the record with the
//! wallet's password-derived key (its SecretCryptoService) and hands the
//! ciphertext over; it is written whole, flushed and renamed into place before
//! the call returns, so a stop after that cannot lose it. On open the renderer
//! reads it back and merges it in, the deeper entry winning.
//!
//! Runtime-held wallets keep the record in their sealed checkpoint instead
//! (`AppRuntime::record_fusion_round`). Only ciphertext is stored here: a
//! record that does not carry the renderer's `enc:v1:` marker is refused.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// The renderer's ciphertext marker (SecretCryptoService `SECRET_ENC_PREFIX`).
const SEALED_PREFIX: &str = "enc:v1:";
/// A depth record is a few kilobytes; this bounds a misbehaving page.
const MAX_SEALED_BYTES: usize = 4 * 1024 * 1024;

fn record_path(directory: &Path, wallet_id: u32) -> Result<PathBuf, String> {
    if wallet_id == 0 {
        return Err("no wallet named".into());
    }
    Ok(directory.join(format!("wallet-{wallet_id}.sealed")))
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("fusion-depth"))
}

fn load(directory: &Path, wallet_id: u32) -> Result<Option<String>, String> {
    let path = record_path(directory, wallet_id)?;
    match std::fs::read_to_string(&path) {
        Ok(sealed) if sealed.starts_with(SEALED_PREFIX) && sealed.len() <= MAX_SEALED_BYTES => {
            Ok(Some(sealed))
        }
        Ok(_) => Err(format!(
            "{} is not a sealed fusion depth record",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

fn store(directory: &Path, wallet_id: u32, sealed: &str) -> Result<(), String> {
    if !sealed.starts_with(SEALED_PREFIX) {
        return Err("the fusion depth record must be sealed before it is stored".into());
    }
    if sealed.len() > MAX_SEALED_BYTES {
        return Err("the fusion depth record is too large".into());
    }
    let path = record_path(directory, wallet_id)?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let staged = path.with_extension("sealed.tmp");
    let written = std::fs::File::create(&staged).and_then(|mut file| {
        file.write_all(sealed.as_bytes())?;
        file.sync_all()
    });
    written
        .and_then(|()| std::fs::rename(&staged, &path))
        .map_err(|error| format!("cannot write {}: {error}", path.display()))
}

/// The sealed depth record of `wallet_id`, or none yet.
#[tauri::command]
pub fn optn_fusion_depth_load(
    app: tauri::AppHandle,
    wallet_id: u32,
) -> Result<Option<String>, String> {
    load(&directory(&app)?, wallet_id)
}

/// Keep `sealed`, the renderer's ciphertext of `wallet_id`'s depth record,
/// durably: on disk before this returns.
#[tauri::command]
pub fn optn_fusion_depth_store(
    app: tauri::AppHandle,
    wallet_id: u32,
    sealed: String,
) -> Result<(), String> {
    store(&directory(&app)?, wallet_id, &sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_record_is_kept_whole_and_plaintext_is_refused() {
        let root =
            std::env::temp_dir().join(format!("optn-fusion-depth-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(load(&root, 7), Ok(None));

        store(&root, 7, "enc:v1:first").unwrap();
        store(&root, 7, "enc:v1:second").unwrap();
        assert_eq!(load(&root, 7), Ok(Some("enc:v1:second".into())));
        assert!(!root.join("wallet-7.sealed.tmp").exists());
        assert_eq!(load(&root, 8), Ok(None));

        assert!(store(&root, 7, r#"{"coins":{}}"#).is_err());
        assert!(store(&root, 0, "enc:v1:x").is_err());
        let oversized = format!("enc:v1:{}", "a".repeat(MAX_SEALED_BYTES));
        assert!(store(&root, 7, &oversized).is_err());
        assert_eq!(load(&root, 7), Ok(Some("enc:v1:second".into())));

        // A file that is not sealed is not handed back as if it were.
        std::fs::write(root.join("wallet-9.sealed"), "{}").unwrap();
        assert!(load(&root, 9).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
