//! Native ciphertext files, shared by CLI and desktop. No wallet secrets here.
use optn_platform::{PlatformError, PlatformResult, WalletStorage};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub struct NativeWalletStorage {
    root: PathBuf,
}

fn error(_: impl std::fmt::Display) -> PlatformError {
    PlatformError::Io("Wallet file operation failed.".into())
}

impl NativeWalletStorage {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self, handle: &str) -> PlatformResult<PathBuf> {
        let mut parts = Path::new(handle).components();
        if !matches!(parts.next(), Some(Component::Normal(_)))
            || parts.next().is_some()
            || !handle.ends_with(".optn")
            || handle.contains(['/', '\\', ':'])
            || handle.chars().any(char::is_control)
        {
            return Err(PlatformError::InvalidData("Invalid wallet handle.".into()));
        }
        Ok(self.root.join(handle))
    }

    fn read_path(path: &Path) -> PlatformResult<Vec<u8>> {
        if fs::symlink_metadata(path)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err(PlatformError::PermissionDenied);
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(error)?
            .take(262_145)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        if bytes.len() > 262_144 {
            return Err(PlatformError::InvalidData(
                "Wallet file is too large.".into(),
            ));
        }
        Ok(bytes)
    }

    fn lock(&self) -> PlatformResult<File> {
        fs::create_dir_all(&self.root).map_err(error)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(".wallet-security.lock"))
            .map_err(error)?;
        file.try_lock().map_err(error)?;
        Ok(file)
    }

    fn atomic_write(&self, path: &Path, bytes: &[u8]) -> PlatformResult<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(error)?;
        temporary.write_all(bytes).map_err(error)?;
        temporary.as_file().sync_all().map_err(error)?;
        temporary.persist(path).map_err(error)?;
        #[cfg(unix)]
        File::open(&self.root)
            .map_err(error)?
            .sync_all()
            .map_err(error)?;
        Ok(())
    }
}

impl WalletStorage for NativeWalletStorage {
    fn list(&self) -> PlatformResult<Vec<String>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(error(e)),
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(error)?;
            if !entry.file_type().map_err(error)?.is_file() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if self.path(name).is_ok() {
                    names.push(name.to_owned());
                }
            }
        }
        names.sort();
        Ok(names)
    }
    fn read(&self, handle: &str) -> PlatformResult<Vec<u8>> {
        Self::read_path(&self.path(handle)?)
    }
    fn save(&self, handle: &str, previous: Option<&[u8]>, bytes: &[u8]) -> PlatformResult<()> {
        let path = self.path(handle)?;
        if bytes.len() > 262_144 {
            return Err(PlatformError::InvalidData(
                "Wallet file is too large.".into(),
            ));
        }
        let _lock = self.lock()?;
        match previous {
            Some(previous) if Self::read_path(&path)? == previous => {}
            Some(_) => return Err(PlatformError::InvalidData("Wallet changed on disk.".into())),
            None => match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error(e)),
                Ok(_) => return Err(PlatformError::InvalidData("Wallet already exists.".into())),
            },
        }
        self.atomic_write(&path, bytes)
    }
    fn entropy(&self) -> PlatformResult<[u8; 56]> {
        let mut entropy = [0u8; 56];
        getrandom::getrandom(&mut entropy).map_err(error)?;
        Ok(entropy)
    }
    fn auto_lock_minutes(&self) -> PlatformResult<Option<u32>> {
        let path = self.root.join(".auto-lock");
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(error(e)),
            Ok(_) => {}
        }
        let bytes = Self::read_path(&path)?;
        let minutes = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|minutes| [0, 1, 5, 15, 30, 60, 120, 240].contains(minutes))
            .ok_or_else(|| PlatformError::InvalidData("Invalid auto-lock policy.".into()))?;
        Ok(Some(minutes))
    }
    fn save_auto_lock_minutes(&self, minutes: u32) -> PlatformResult<()> {
        if ![0, 1, 5, 15, 30, 60, 120, 240].contains(&minutes) {
            return Err(PlatformError::InvalidData(
                "Invalid auto-lock policy.".into(),
            ));
        }
        let _lock = self.lock()?;
        self.atomic_write(
            &self.root.join(".auto-lock"),
            minutes.to_string().as_bytes(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_replacements_reject_stale_writers_and_path_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let store = NativeWalletStorage::new(directory.path().to_owned());
        store.save("sample.optn", None, b"ciphertext A").unwrap();
        assert!(store.save("sample.optn", None, b"clobber").is_err());
        store
            .save("sample.optn", Some(b"ciphertext A"), b"ciphertext B")
            .unwrap();
        assert!(store
            .save("sample.optn", Some(b"ciphertext A"), b"stale")
            .is_err());
        assert_eq!(store.read("sample.optn").unwrap(), b"ciphertext B");
        for handle in [
            "../sample.optn",
            "C:\\sample.optn",
            "a/b.optn",
            ".auto-lock",
        ] {
            assert!(store.read(handle).is_err());
        }
        store.save_auto_lock_minutes(30).unwrap();
        assert_eq!(store.auto_lock_minutes().unwrap(), Some(30));
    }
}
