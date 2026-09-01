//! Platform capability ports.
//!
//! Application/domain crates depend on these contracts rather than Tauri,
//! Capacitor, Dioxus, browser APIs, Swift, Kotlin, or any other shell.
//! Current adapters can use Tauri; future adapters can be swapped without
//! changing wallet/business logic.

use std::{future::Future, pin::Pin};

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
