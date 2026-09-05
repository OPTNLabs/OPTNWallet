//! Framework-neutral application update scaffolding.
//!
//! Canonical design: https://github.com/OPTNLabs/OPTNWallet/issues/75
//!
//! Update authenticity is intentionally independent from BCH chain-provider
//! trust. A Fulcrum/BIP37/Neutrino/BCHN source must never be able to authorize
//! executable wallet updates.

use std::{future::Future, pin::Pin};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRelease {
    /// Human-readable semantic/application version.
    pub version: String,
    pub notes: Option<String>,
    pub download_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateState {
    Unsupported,
    Idle,
    Checking,
    UpToDate,
    Available(VerifiedRelease),
    Downloading {
        release: VerifiedRelease,
        downloaded: u64,
        total: Option<u64>,
    },
    ReadyToInstall(VerifiedRelease),
    Failed(UpdateFailure),
}

impl Default for UpdateState {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateFailure {
    Offline,
    InvalidMetadata,
    AuthenticationFailed,
    UnsupportedPlatform,
    DownloadFailed(String),
    InstallFailed(String),
    Other(String),
}

pub type UpdateResult<T> = Result<T, UpdateFailure>;
pub type UpdateFuture<'a, T> = Pin<Box<dyn Future<Output = UpdateResult<T>> + Send + 'a>>;

/// Platform/shell adapter contract. Implementations must authenticate release
/// metadata/artifacts before returning `VerifiedRelease` to the runtime.
pub trait UpdateProvider: Send + Sync {
    fn check<'a>(&'a self) -> UpdateFuture<'a, Option<VerifiedRelease>>;
    fn download<'a>(&'a self, release: &'a VerifiedRelease) -> UpdateFuture<'a, ()>;
    fn install<'a>(&'a self, release: &'a VerifiedRelease) -> UpdateFuture<'a, ()>;
}

/// Pure state transition helper for renderers/tests. The runtime owns the state;
/// UI code merely renders it and dispatches typed user intent later.
pub fn update_available(release: VerifiedRelease) -> UpdateState {
    UpdateState::Available(release)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn available_state_carries_only_verified_release_metadata() {
        let release = VerifiedRelease {
            version: "1.8.0".into(),
            notes: Some("Network catalog refresh".into()),
            download_size: Some(42),
        };
        assert_eq!(
            update_available(release.clone()),
            UpdateState::Available(release)
        );
    }

    #[test]
    fn default_is_idle_not_implicitly_checking_or_installing() {
        assert_eq!(UpdateState::default(), UpdateState::Idle);
    }
}
