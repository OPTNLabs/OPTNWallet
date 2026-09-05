//! Durable network-configuration overlay for OPTN's multi-source chain runtime.
//!
//! Canonical design: https://github.com/OPTNLabs/OPTNWallet/issues/75
//!
//! The shipped/bootstrap catalog is versioned independently from user choices.
//! Updating the application may replace the bootstrap base, but must never erase
//! user-added sources, own-infrastructure groups, bans/disables, preferred order,
//! protocol filters, or fallback boundaries.

use crate::chain::{
    CatalogError, ChainSource, ConnectionPolicy, Endpoint, SourceCatalog, SourceDisposition, SourceId,
};
use std::collections::BTreeMap;

/// Increment when the persisted *shape* changes, not when bootstrap nodes change.
pub const NETWORK_CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserNetworkOverlay {
    /// Public/custom endpoints or grouped own infrastructure entered by the user.
    /// Bootstrap sources never belong here.
    pub user_sources: Vec<ChainSource>,
    /// Durable user decisions about bootstrap sources. These survive catalog refreshes.
    pub bootstrap_overrides: BTreeMap<SourceId, SourceDisposition>,
    /// Protocol filter + primary/fallback scopes + preference order.
    pub connection_policy: ConnectionPolicy,
    /// Optional self-hosted explorer endpoint. Navigation only; never chain truth.
    pub explorer: Option<Endpoint>,
}

impl Default for UserNetworkOverlay {
    fn default() -> Self {
        Self {
            user_sources: Vec::new(),
            bootstrap_overrides: BTreeMap::new(),
            connection_policy: ConnectionPolicy::auto(),
            explorer: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConfigEnvelope {
    pub schema_version: u32,
    /// Version/revision of the shipped bootstrap base last merged with this overlay.
    /// This is provenance, not the schema version.
    pub bootstrap_catalog_version_seen: String,
    pub overlay: UserNetworkOverlay,
}

impl NetworkConfigEnvelope {
    pub fn current(
        bootstrap_catalog_version_seen: impl Into<String>,
        overlay: UserNetworkOverlay,
    ) -> Self {
        Self {
            schema_version: NETWORK_CONFIG_SCHEMA_VERSION,
            bootstrap_catalog_version_seen: bootstrap_catalog_version_seen.into(),
            overlay,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkConfigError {
    UnsupportedSchema { found: u32, current: u32 },
    Catalog(CatalogError),
}

impl From<CatalogError> for NetworkConfigError {
    fn from(value: CatalogError) -> Self {
        Self::Catalog(value)
    }
}

/// Merge the *current* shipped bootstrap base with the durable user overlay.
///
/// This function intentionally returns a new catalog. Callers can persist the
/// migrated envelope only after the complete merge/validation succeeds, making
/// upgrade migration transactional rather than "reset to defaults on error".
pub fn merge_bootstrap_with_user_overlay(
    bootstrap_base: &SourceCatalog,
    envelope: &NetworkConfigEnvelope,
) -> Result<SourceCatalog, NetworkConfigError> {
    if envelope.schema_version != NETWORK_CONFIG_SCHEMA_VERSION {
        return Err(NetworkConfigError::UnsupportedSchema {
            found: envelope.schema_version,
            current: NETWORK_CONFIG_SCHEMA_VERSION,
        });
    }

    let mut merged = bootstrap_base.clone();

    // Re-apply durable bans/disables to matching bootstrap source IDs. If a
    // maintainer removed a source from the new base, the stale override is
    // harmless and can be garbage-collected by a later migration.
    for (id, disposition) in &envelope.overlay.bootstrap_overrides {
        if merged.get(id).is_some() {
            merged.set_disposition(id, *disposition)?;
        }
    }

    // User-created sources always survive a bootstrap refresh. Duplicate stable
    // IDs are rejected rather than silently replacing a shipped source.
    for source in &envelope.overlay.user_sources {
        merged.insert(source.clone())?;
    }

    Ok(merged)
}

/// Persistence port. Concrete filesystem/key-value implementations belong in a
/// shell/platform adapter; network policy and migration do not.
pub trait NetworkConfigStore: Send + Sync {
    fn load(&self) -> Result<Option<NetworkConfigEnvelope>, String>;
    fn store_atomic(&self, value: &NetworkConfigEnvelope) -> Result<(), String>;
}

/// Portable backup is deliberately only network/preferences data. Seed/private
/// key material must never be added to this structure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortableNetworkConfig {
    pub schema_version: u32,
    pub overlay: UserNetworkOverlay,
}

impl From<&NetworkConfigEnvelope> for PortableNetworkConfig {
    fn from(value: &NetworkConfigEnvelope) -> Self {
        Self {
            schema_version: value.schema_version,
            overlay: value.overlay.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{
        BootstrapProject, CapabilitySet, ChainSource, SourceOrigin,
    };

    fn bootstrap(id: &str) -> ChainSource {
        ChainSource {
            id: SourceId::from(id),
            label: id.into(),
            origin: SourceOrigin::Bootstrap {
                project: BootstrapProject::Bchn,
                provenance: "test".into(),
            },
            endpoints: Vec::new(),
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        }
    }

    fn user_source(id: &str) -> ChainSource {
        ChainSource {
            id: SourceId::from(id),
            label: id.into(),
            origin: SourceOrigin::UserAdded,
            endpoints: Vec::new(),
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        }
    }

    #[test]
    fn bootstrap_refresh_keeps_user_source_and_ban() {
        let mut new_base = SourceCatalog::default();
        new_base.insert(bootstrap("bootstrap-a")).unwrap();
        new_base.insert(bootstrap("bootstrap-new")).unwrap();

        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(user_source("my-node"));
        overlay.bootstrap_overrides.insert(
            SourceId::from("bootstrap-a"),
            SourceDisposition::Banned,
        );

        let merged = merge_bootstrap_with_user_overlay(
            &new_base,
            &NetworkConfigEnvelope::current("v2", overlay),
        )
        .unwrap();

        assert_eq!(
            merged.get(&SourceId::from("bootstrap-a")).unwrap().disposition,
            SourceDisposition::Banned
        );
        assert!(merged.get(&SourceId::from("bootstrap-new")).is_some());
        assert!(merged.get(&SourceId::from("my-node")).is_some());
    }

    #[test]
    fn maintainer_removed_bootstrap_does_not_remove_user_source() {
        let new_base = SourceCatalog::default();
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(user_source("my-node"));
        overlay.bootstrap_overrides.insert(
            SourceId::from("removed-bootstrap"),
            SourceDisposition::Banned,
        );

        let merged = merge_bootstrap_with_user_overlay(
            &new_base,
            &NetworkConfigEnvelope::current("v3", overlay),
        )
        .unwrap();

        assert!(merged.get(&SourceId::from("removed-bootstrap")).is_none());
        assert!(merged.get(&SourceId::from("my-node")).is_some());
    }

    #[test]
    fn unsupported_schema_fails_instead_of_resetting_preferences() {
        let envelope = NetworkConfigEnvelope {
            schema_version: NETWORK_CONFIG_SCHEMA_VERSION + 1,
            bootstrap_catalog_version_seen: "future".into(),
            overlay: UserNetworkOverlay::default(),
        };
        assert!(matches!(
            merge_bootstrap_with_user_overlay(&SourceCatalog::default(), &envelope),
            Err(NetworkConfigError::UnsupportedSchema { .. })
        ));
    }

    #[test]
    fn portable_backup_contains_the_overlay_not_wallet_secrets() {
        let envelope = NetworkConfigEnvelope::current("v1", UserNetworkOverlay::default());
        let portable = PortableNetworkConfig::from(&envelope);
        assert_eq!(portable.schema_version, NETWORK_CONFIG_SCHEMA_VERSION);
        assert_eq!(portable.overlay, envelope.overlay);
    }
}
