#![forbid(unsafe_code)]

//! Platform capability ports.
//!
//! Application/domain crates depend on these contracts rather than Tauri,
//! Capacitor, Dioxus, browser APIs, Swift, Kotlin, or any other shell.
//! Current adapters can use Tauri; future adapters can be swapped without
//! changing wallet/business logic.

use std::{future::Future, pin::Pin};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    SecureStorage,
    Biometrics,
    QrScanner,
    Clipboard,
    Notifications,
    FileSystem,
    DeepLinks,
    HardwareWallet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Standalone Rust implementation with no shell dependency.
    PureRust,
    /// Implementation supplied through the current application shell.
    Shell,
    /// Thin direct bridge to Android/iOS/desktop native APIs.
    NativeFfi,
    /// Browser/WASM host implementation.
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub kind: ProviderKind,
    pub capabilities: &'static [Capability],
}

/// Metadata shared by all capability providers.
///
/// Business/application code depends on the capability traits below, not on
/// this metadata. Hosts use descriptors to select and diagnose providers.
pub trait CapabilityProvider {
    fn descriptor(&self) -> ProviderDescriptor;
}

pub type PlatformResult<T> = Result<T, PlatformError>;
pub type PlatformFuture<'a, T> = Pin<Box<dyn Future<Output = PlatformResult<T>> + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    Unavailable,
    PermissionDenied,
    Cancelled,
    InvalidData(String),
    Io(String),
    Other(String),
}

pub trait SecureStorage {
    fn get<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, Option<Vec<u8>>>;
    fn set<'a>(&'a self, key: &'a str, value: &'a [u8]) -> PlatformFuture<'a, ()>;
    fn delete<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait Biometrics {
    fn authenticate<'a>(&'a self, reason: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait QrScanner {
    fn scan<'a>(&'a self) -> PlatformFuture<'a, String>;
}

pub trait Clipboard {
    fn read_text<'a>(&'a self) -> PlatformFuture<'a, String>;
    fn write_text<'a>(&'a self, value: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait Notifications {
    fn notify<'a>(&'a self, title: &'a str, body: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait FileSystem {
    fn read<'a>(&'a self, path: &'a str) -> PlatformFuture<'a, Vec<u8>>;
    fn write<'a>(&'a self, path: &'a str, bytes: &'a [u8]) -> PlatformFuture<'a, ()>;
}

pub trait DeepLinks {
    fn initial_url<'a>(&'a self) -> PlatformFuture<'a, Option<String>>;
}

pub trait HardwareWallet {
    fn exchange<'a>(&'a self, request: &'a [u8]) -> PlatformFuture<'a, Vec<u8>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExampleProvider;

    impl CapabilityProvider for ExampleProvider {
        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: "example",
                kind: ProviderKind::PureRust,
                capabilities: &[Capability::Clipboard],
            }
        }
    }

    #[test]
    fn provider_metadata_is_independent_from_capability_contracts() {
        let descriptor = ExampleProvider.descriptor();
        assert_eq!(descriptor.id, "example");
        assert_eq!(descriptor.kind, ProviderKind::PureRust);
        assert_eq!(descriptor.capabilities, &[Capability::Clipboard]);
    }
}
