//! Shared bounded and atomic native network-configuration storage.
use optn_runtime::network_config::{
    decode_envelope_json, encode_envelope_json, NetworkConfigEnvelope, NetworkConfigStore,
};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
const MAX_BYTES: u64 = 128 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct NetworkConfigFile {
    path: PathBuf,
}

impl NetworkConfigFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Serialize read-modify-write across hosts using a stable sidecar lock.
    /// Contention is reported so an interactive command never waits forever.
    pub fn update(
        &self,
        edit: impl FnOnce(Option<NetworkConfigEnvelope>) -> Result<NetworkConfigEnvelope, String>,
    ) -> Result<NetworkConfigEnvelope, String> {
        let _lock = lock_file(&self.path)
            .map_err(|error| format!("network settings are busy or cannot be locked: {error}"))?;
        let updated = edit(self.load()?)?;
        let bytes = encode_envelope_json(&updated)
            .map_err(|error| format!("encode network config: {error:?}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("network configuration file is too large".into());
        }
        // Apply the same trust-boundary validation on writes and reads.
        decode_envelope_json(&bytes)
            .map_err(|error| format!("invalid network configuration: {error:?}"))?;
        write_atomically(&self.path, bytes.as_bytes()).map_err(|error| error.to_string())?;
        Ok(updated)
    }
}

impl NetworkConfigStore for NetworkConfigFile {
    fn load(&self) -> Result<Option<NetworkConfigEnvelope>, String> {
        let Some(bytes) = read_bounded(&self.path, MAX_BYTES)? else {
            return Ok(None);
        };
        decode_envelope_json(
            std::str::from_utf8(&bytes)
                .map_err(|_| "network configuration is not UTF-8".to_string())?,
        )
        .map(Some)
        .map_err(|error| format!("invalid network configuration: {error:?}"))
    }

    fn store_atomic(&self, value: &NetworkConfigEnvelope) -> Result<(), String> {
        self.update(|_| Ok(value.clone())).map(|_| ())
    }
}

pub(crate) fn lock_file(path: &Path) -> io::Result<File> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "data directory is unavailable")
    })?;
    fs::create_dir_all(parent)?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))?;
    lock.try_lock().map_err(io::Error::other)?;
    Ok(lock)
}

pub(crate) fn read_bounded(path: &Path, max: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max {
        return Err("data file is too large".into());
    }
    Ok(Some(bytes))
}

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "data directory is unavailable")
    })?;
    fs::create_dir_all(directory)?;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
