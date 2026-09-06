//! Native appearance preferences, deliberately separate from wallet persistence.

use optn_app::{AppState, ThemeMode, UiSkin};
use optn_transport::{WireSkin, WireTheme};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
const MAX_BYTES: u64 = 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Appearance {
    theme: WireTheme,
    skin: WireSkin,
}

pub struct AppearanceStore {
    path: PathBuf,
    // Serialize appearance actions through their durable acknowledgement so a
    // slower save cannot overwrite a newer selection from another window.
    pub(crate) write_lock: tokio::sync::Mutex<()>,
}

impl AppearanceStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn restore(&self, state: &mut AppState) -> io::Result<()> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "appearance file is too large",
            ));
        }
        let appearance: Appearance = serde_json::from_slice(&bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid appearance preferences")
        })?;
        state.theme = appearance.theme.into();
        state.skin = appearance.skin.into();
        Ok(())
    }

    pub fn save(&self, theme: ThemeMode, skin: UiSkin) -> io::Result<()> {
        let bytes = serde_json::to_vec(&Appearance {
            theme: theme.into(),
            skin: skin.into(),
        })?;
        let directory = self.path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "appearance config directory is unavailable",
            )
        })?;
        fs::create_dir_all(directory)?;
        let temporary = self.path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        // Exclusive creation never truncates an existing file or follows a
        // pre-existing temporary symlink. Rename stays on the same filesystem.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.path)?;
            #[cfg(unix)]
            File::open(directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct TestDirectory(pub PathBuf);

    impl TestDirectory {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "optn-appearance-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        pub fn store(&self) -> AppearanceStore {
            AppearanceStore::new(self.0.join("appearance.json"))
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn restart_restores_all_eight_combinations_before_initial_snapshot() {
        let directory = TestDirectory::new();
        for theme in [
            ThemeMode::Light,
            ThemeMode::Gray,
            ThemeMode::Green,
            ThemeMode::Dark,
        ] {
            for skin in [UiSkin::Default, UiSkin::Cyberpunk] {
                directory.store().save(theme, skin).unwrap();
                let mut initial = AppState::default();
                directory.store().restore(&mut initial).unwrap();
                let (runtime, _driver) = optn_runtime::AppRuntime::new(initial);
                let snapshot = optn_transport::WireState::from(&runtime.state());
                assert_eq!(snapshot.theme, WireTheme::from(theme));
                assert_eq!(snapshot.skin, WireSkin::from(skin));
                let stored: serde_json::Value =
                    serde_json::from_slice(&fs::read(directory.0.join("appearance.json")).unwrap())
                        .unwrap();
                assert_eq!(
                    stored,
                    serde_json::json!({ "theme": WireTheme::from(theme), "skin": WireSkin::from(skin) })
                );
                assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
            }
        }
    }

    #[test]
    fn missing_is_default_but_invalid_or_unreadable_data_is_an_error_without_partial_restore() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut state = AppState::default();
        store.restore(&mut state).unwrap();
        for bytes in [
            b"{".to_vec(),
            br#"{"theme":"light"}"#.to_vec(),
            br#"{"theme":"unknown","skin":"default"}"#.to_vec(),
            br#"{"theme":"light","skin":"unknown"}"#.to_vec(),
            br#"{"theme":"light","skin":"default","wallet":{}}"#.to_vec(),
            vec![b' '; MAX_BYTES as usize + 1],
        ] {
            fs::write(&store.path, &bytes).unwrap();
            assert_eq!(
                store.restore(&mut state).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(state.theme, ThemeMode::Green);
            assert_eq!(state.skin, UiSkin::Default);
            assert_eq!(fs::read(&store.path).unwrap(), bytes);
        }
        fs::remove_file(&store.path).unwrap();
        fs::create_dir(&store.path).unwrap();
        assert!(store.restore(&mut state).is_err());
        assert!(store.save(ThemeMode::Light, UiSkin::Cyberpunk).is_err());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
