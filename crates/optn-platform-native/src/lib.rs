#![forbid(unsafe_code)]

//! Shell-independent native capability providers.
//!
//! Providers are selected per capability. Enabling clipboard does not pull
//! secure-storage or notification dependencies, and vice versa.

#[cfg(all(
    feature = "clipboard",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
mod clipboard {
    use optn_platform::{
        Capability, CapabilityProvider, Clipboard, PlatformError, PlatformFuture, PlatformResult,
        ProviderDescriptor, ProviderKind,
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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn assert_provider<T: Clipboard + CapabilityProvider>() {}

        #[test]
        fn clipboard_provider_is_shell_independent() {
            assert_provider::<NativeClipboard>();
            assert_eq!(
                NativeClipboard::new().descriptor().kind,
                ProviderKind::PureRust
            );
        }
    }
}

#[cfg(all(
    feature = "secure-storage",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
mod secure_storage {
    use optn_platform::{
        Capability, CapabilityProvider, PlatformError, PlatformFuture, PlatformResult,
        ProviderDescriptor, ProviderKind, SecureStorage,
    };

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

    #[cfg(test)]
    mod tests {
        use super::*;

        fn assert_provider<T: SecureStorage + CapabilityProvider>() {}

        #[test]
        fn storage_provider_is_shell_independent() {
            assert_provider::<NativeSecureStorage>();
            assert_eq!(
                NativeSecureStorage::new("com.optilabs.wallet")
                    .descriptor()
                    .kind,
                ProviderKind::NativeFfi
            );
        }
    }
}

#[cfg(all(
    feature = "notifications",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
mod notifications {
    use optn_platform::{
        Capability, CapabilityProvider, Notifications, PlatformError, PlatformFuture,
        ProviderDescriptor, ProviderKind,
    };

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

        fn assert_provider<T: Notifications + CapabilityProvider>() {}

        #[test]
        fn notification_provider_is_shell_independent() {
            assert_provider::<NativeNotifications>();
            assert_eq!(
                NativeNotifications.descriptor().capabilities,
                &[Capability::Notifications]
            );
        }
    }
}

#[cfg(all(
    feature = "clipboard",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
pub use clipboard::NativeClipboard;

#[cfg(all(
    feature = "secure-storage",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
pub use secure_storage::NativeSecureStorage;

#[cfg(all(
    feature = "notifications",
    not(any(target_os = "android", target_os = "ios", target_arch = "wasm32"))
))]
pub use notifications::NativeNotifications;
