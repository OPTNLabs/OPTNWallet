#![forbid(unsafe_code)]

//! Shell-independent native capability providers.
//!
//! These providers depend on standalone Rust crates and OS APIs, never Tauri,
//! Leptos, Capacitor, or another application shell. Hosts may use them directly
//! or substitute shell/native/web providers capability by capability.

#[cfg(not(any(target_os = "android", target_os = "ios", target_arch = "wasm32")))]
mod desktop {
    use optn_platform::{
        Capability, CapabilityProvider, Clipboard, Notifications, PlatformError, PlatformFuture,
        PlatformResult, ProviderDescriptor, ProviderKind, SecureStorage,
    };
    use std::sync::Mutex;

    pub struct NativeClipboard {
        clipboard: Mutex<Option<arboard::Clipboard>>,
    }

    impl NativeClipboard {
        pub fn new() -> Self {
            Self {
                clipboard: Mutex::new(None),
            }
        }

        fn with_clipboard<T>(
            &self,
            operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
        ) -> PlatformResult<T> {
            let mut stored = self
                .clipboard
                .lock()
                .map_err(|_| PlatformError::Other("clipboard state lock poisoned".into()))?;
            if stored.is_none() {
                *stored = Some(
                    arboard::Clipboard::new()
                        .map_err(|error| PlatformError::Other(error.to_string()))?,
                );
            }
            let Some(clipboard) = stored.as_mut() else {
                return Err(PlatformError::Unavailable);
            };
            operation(clipboard).map_err(|error| PlatformError::Other(error.to_string()))
        }

        pub fn read_text_sync(&self) -> PlatformResult<String> {
            self.with_clipboard(|clipboard| clipboard.get_text())
        }

        pub fn write_text_sync(&self, value: &str) -> PlatformResult<()> {
            self.with_clipboard(|clipboard| clipboard.set_text(value.to_owned()))
        }
    }

    impl Default for NativeClipboard {
        fn default() -> Self {
            Self::new()
        }
    }

    impl CapabilityProvider for NativeClipboard {
        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: "native-arboard",
                kind: ProviderKind::PureRust,
                capabilities: &[Capability::Clipboard],
            }
        }
    }

    impl Clipboard for NativeClipboard {
        fn read_text<'a>(&'a self) -> PlatformFuture<'a, String> {
            Box::pin(async move { self.read_text_sync() })
        }

        fn write_text<'a>(&'a self, value: &'a str) -> PlatformFuture<'a, ()> {
            Box::pin(async move { self.write_text_sync(value) })
        }
    }

    #[derive(Clone)]
    pub struct NativeSecureStorage {
        service: String,
    }

    impl NativeSecureStorage {
        pub fn new(service: impl Into<String>) -> Self {
            Self {
                service: service.into(),
            }
        }

        fn entry(&self, key: &str) -> PlatformResult<keyring::v1::Entry> {
            keyring::v1::Entry::new(&self.service, key).map_err(map_keyring_error)
        }
    }

    fn map_keyring_error(error: keyring::v1::Error) -> PlatformError {
        match error {
            keyring::v1::Error::NoStorageAccess(_) => PlatformError::PermissionDenied,
            keyring::v1::Error::NoEntry => PlatformError::Unavailable,
            other => PlatformError::Other(other.to_string()),
        }
    }

    impl CapabilityProvider for NativeSecureStorage {
        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: "native-keyring-4",
                kind: ProviderKind::NativeFfi,
                capabilities: &[Capability::SecureStorage],
            }
        }
    }

    impl SecureStorage for NativeSecureStorage {
        fn get<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move {
                let entry = self.entry(key)?;
                match entry.get_secret() {
                    Ok(secret) => Ok(Some(secret)),
                    Err(keyring::v1::Error::NoEntry) => Ok(None),
                    Err(error) => Err(map_keyring_error(error)),
                }
            })
        }

        fn set<'a>(&'a self, key: &'a str, value: &'a [u8]) -> PlatformFuture<'a, ()> {
            Box::pin(async move {
                self.entry(key)?
                    .set_secret(value)
                    .map_err(map_keyring_error)
            })
        }

        fn delete<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, ()> {
            Box::pin(async move {
                match self.entry(key)?.delete_credential() {
                    Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
                    Err(error) => Err(map_keyring_error(error)),
                }
            })
        }
    }

    #[derive(Clone, Copy, Default)]
    pub struct NativeNotifications;

    impl CapabilityProvider for NativeNotifications {
        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: "native-notify-rust",
                kind: ProviderKind::NativeFfi,
                capabilities: &[Capability::Notifications],
            }
        }
    }

    impl Notifications for NativeNotifications {
        fn notify<'a>(&'a self, title: &'a str, body: &'a str) -> PlatformFuture<'a, ()> {
            Box::pin(async move {
                notify_rust::Notification::new()
                    .summary(title)
                    .body(body)
                    .show()
                    .map(|_| ())
                    .map_err(|error| PlatformError::Other(error.to_string()))
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn assert_clipboard<T: Clipboard + CapabilityProvider>() {}
        fn assert_storage<T: SecureStorage + CapabilityProvider>() {}
        fn assert_notifications<T: Notifications + CapabilityProvider>() {}

        #[test]
        fn providers_satisfy_shell_neutral_contracts() {
            assert_clipboard::<NativeClipboard>();
            assert_storage::<NativeSecureStorage>();
            assert_notifications::<NativeNotifications>();

            assert_eq!(
                NativeSecureStorage::new("com.optilabs.wallet")
                    .descriptor()
                    .kind,
                ProviderKind::NativeFfi
            );
            assert_eq!(
                NativeNotifications.descriptor().capabilities,
                &[Capability::Notifications]
            );
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_arch = "wasm32")))]
pub use desktop::{NativeClipboard, NativeNotifications, NativeSecureStorage};
