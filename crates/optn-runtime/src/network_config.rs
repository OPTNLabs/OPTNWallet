//! Durable network-configuration overlay for OPTN's multi-source chain runtime.
//!
//! The shipped/bootstrap catalog is versioned independently from user choices.
//! Application updates may replace that base, but must not erase user-added
//! sources, own-infrastructure groups, bans/disables, preferred order, protocol
//! filters, fallback boundaries, or explorer preference.

use crate::chain::{
    CapabilitySet, CatalogError, ChainSource, ConnectionPolicy, Endpoint, EndpointKind,
    ProtocolFamily, ProtocolSet, SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
    SourceScope,
};
use optn_app::{NetworkServers, ServerKind, ServerOverrides};
use optn_core::network::Network;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const NETWORK_CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserNetworkOverlay {
    pub user_sources: Vec<ChainSource>,
    pub bootstrap_overrides: BTreeMap<SourceId, SourceDisposition>,
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
    for (id, disposition) in &envelope.overlay.bootstrap_overrides {
        if merged.get(id).is_some() {
            merged.set_disposition(id, *disposition)?;
        }
    }
    for source in &envelope.overlay.user_sources {
        merged.insert(source.clone())?;
    }
    Ok(merged)
}

/// Decode the one-Electrum/one-peer/one-explorer settings shape used by the
/// current desktop settings UI.
///
/// A richer overlay must not be flattened by a surface that cannot faithfully
/// enforce its policy. Callers therefore receive an error rather than a public
/// default when the file contains advanced source selection.
pub fn legacy_network_servers_from_overlay(
    overlay: &UserNetworkOverlay,
) -> Result<NetworkServers, String> {
    if !overlay.bootstrap_overrides.is_empty()
        || overlay.connection_policy != ConnectionPolicy::auto()
    {
        return Err(
            "this network configuration uses source policy features this surface cannot enforce"
                .into(),
        );
    }

    let mut servers = NetworkServers::new();
    for source in &overlay.user_sources {
        if !matches!(&source.origin, SourceOrigin::UserAdded)
            || source.disposition != SourceDisposition::Enabled
            || source.priority != 0
        {
            return Err(
                "this network configuration has a source this surface cannot represent".into(),
            );
        }
        for endpoint in &source.endpoints {
            let (kind, entry) = match endpoint.kind {
                EndpointKind::ElectrumTls => (
                    ServerKind::Electrum,
                    host_port(&endpoint.host, required_port(endpoint)?)?,
                ),
                EndpointKind::ElectrumTcp => {
                    return Err(
                        "this network configuration has a plaintext Electrum endpoint this surface cannot represent"
                            .into(),
                    )
                }
                EndpointKind::BchP2p => (
                    ServerKind::Peer,
                    host_port(&endpoint.host, required_port(endpoint)?)?,
                ),
                _ => {
                    return Err(
                        "this network configuration has an endpoint this surface cannot represent"
                            .into(),
                    )
                }
            };
            set_once(&mut servers, kind, entry)?;
        }
    }
    if let Some(explorer) = &overlay.explorer {
        if explorer.kind != EndpointKind::ExplorerHttps {
            return Err(
                "this network configuration has a non-HTTPS explorer this surface cannot represent"
                    .into(),
            );
        }
        set_once(
            &mut servers,
            ServerKind::Explorer,
            format!(
                "https://{}",
                host_port_optional(&explorer.host, explorer.port)?
            ),
        )?;
    }
    Ok(servers)
}

fn set_once(servers: &mut NetworkServers, kind: ServerKind, value: String) -> Result<(), String> {
    if servers.get(kind).is_some() {
        return Err(
            "this network configuration has multiple endpoints of one kind, which this surface cannot represent"
                .into(),
        );
    }
    let mut validated = ServerOverrides::new();
    validated
        .set(Network::Mainnet, kind, &value)
        .map_err(|error| format!("invalid persisted {} endpoint: {error}", kind.id()))?;
    let value = validated
        .for_network(Network::Mainnet)
        .get(kind)
        .expect("validated endpoint was stored")
        .to_owned();
    match kind {
        ServerKind::Electrum => servers.electrum = Some(value),
        ServerKind::Peer => servers.peer = Some(value),
        ServerKind::Explorer => servers.explorer = Some(value),
    }
    Ok(())
}

fn required_port(endpoint: &Endpoint) -> Result<u16, String> {
    endpoint
        .port
        .ok_or_else(|| "this network configuration has an endpoint without a port".into())
}

fn host_port(host: &str, port: u16) -> Result<String, String> {
    Ok(format!("{}:{port}", host_port_optional(host, None)?))
}

fn host_port_optional(host: &str, port: Option<u16>) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || host.contains(['/', '\\', '@', '?', '#', ' ']) {
        return Err("this network configuration has an invalid endpoint host".into());
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Persistence port. Filesystem/key-value implementations live in platform or
/// shell adapters; migration and merge semantics remain runtime-owned.
pub trait NetworkConfigStore: Send + Sync {
    fn load(&self) -> Result<Option<NetworkConfigEnvelope>, String>;
    fn store_atomic(&self, value: &NetworkConfigEnvelope) -> Result<(), String>;
}

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

// ---------------------------------------------------------------------------
// Stable portable JSON. Runtime types intentionally do not derive Serialize:
// capability/health observations are ephemeral and must be re-probed after a
// restore. Only user intent/endpoints are persisted.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkConfigCodecError {
    Json(String),
    UnsupportedSchema { found: u32, current: u32 },
    InvalidUserSourceOrigin,
    InvalidEndpoint(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEnvelope {
    schema_version: u32,
    bootstrap_catalog_version_seen: String,
    overlay: StoredOverlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPortable {
    schema_version: u32,
    overlay: StoredOverlay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredOverlay {
    user_sources: Vec<StoredSource>,
    bootstrap_overrides: BTreeMap<String, StoredDisposition>,
    connection_policy: StoredPolicy,
    explorer: Option<StoredEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSource {
    id: String,
    label: String,
    origin: StoredUserOrigin,
    endpoints: Vec<StoredEndpoint>,
    disposition: StoredDisposition,
    priority: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredUserOrigin {
    UserAdded,
    UserInfrastructure { group: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredDisposition {
    Enabled,
    Disabled,
    Banned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEndpoint {
    kind: StoredEndpointKind,
    host: String,
    port: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredEndpointKind {
    BchP2p,
    ElectrumTls,
    ElectrumTcp,
    BchnRpc,
    BchnZmq,
    ExplorerHttp,
    ExplorerHttps,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPolicy {
    protocols: Vec<StoredProtocol>,
    primary_scope: StoredScope,
    fallback_scope: Option<StoredScope>,
    preferred: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredProtocol {
    Electrum,
    Bip37,
    Neutrino,
    BchnRpc,
    BchnZmq,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredScope {
    AllEnabled,
    PublicEnabled,
    UserInfrastructure,
    Explicit { source_ids: Vec<String> },
}

pub fn encode_envelope_json(
    value: &NetworkConfigEnvelope,
) -> Result<String, NetworkConfigCodecError> {
    let stored = StoredEnvelope {
        schema_version: value.schema_version,
        bootstrap_catalog_version_seen: value.bootstrap_catalog_version_seen.clone(),
        overlay: StoredOverlay::from_overlay(&value.overlay)?,
    };
    serde_json::to_string_pretty(&stored).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))
}

pub fn decode_envelope_json(value: &str) -> Result<NetworkConfigEnvelope, NetworkConfigCodecError> {
    let stored: StoredEnvelope =
        serde_json::from_str(value).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))?;
    ensure_schema(stored.schema_version)?;
    Ok(NetworkConfigEnvelope {
        schema_version: stored.schema_version,
        bootstrap_catalog_version_seen: stored.bootstrap_catalog_version_seen,
        overlay: stored.overlay.into_overlay()?,
    })
}

pub fn export_portable_json(
    value: &PortableNetworkConfig,
) -> Result<String, NetworkConfigCodecError> {
    let stored = StoredPortable {
        schema_version: value.schema_version,
        overlay: StoredOverlay::from_overlay(&value.overlay)?,
    };
    serde_json::to_string_pretty(&stored).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))
}

pub fn import_portable_json(value: &str) -> Result<PortableNetworkConfig, NetworkConfigCodecError> {
    let stored: StoredPortable =
        serde_json::from_str(value).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))?;
    ensure_schema(stored.schema_version)?;
    Ok(PortableNetworkConfig {
        schema_version: stored.schema_version,
        overlay: stored.overlay.into_overlay()?,
    })
}

fn ensure_schema(found: u32) -> Result<(), NetworkConfigCodecError> {
    if found != NETWORK_CONFIG_SCHEMA_VERSION {
        return Err(NetworkConfigCodecError::UnsupportedSchema {
            found,
            current: NETWORK_CONFIG_SCHEMA_VERSION,
        });
    }
    Ok(())
}

impl StoredOverlay {
    fn from_overlay(value: &UserNetworkOverlay) -> Result<Self, NetworkConfigCodecError> {
        let user_sources = value
            .user_sources
            .iter()
            .map(StoredSource::from_source)
            .collect::<Result<Vec<_>, _>>()?;
        let bootstrap_overrides = value
            .bootstrap_overrides
            .iter()
            .map(|(id, disposition)| (id.as_str().to_owned(), (*disposition).into()))
            .collect();
        Ok(Self {
            user_sources,
            bootstrap_overrides,
            connection_policy: StoredPolicy::from_policy(&value.connection_policy),
            explorer: value.explorer.as_ref().map(StoredEndpoint::from_endpoint),
        })
    }

    fn into_overlay(self) -> Result<UserNetworkOverlay, NetworkConfigCodecError> {
        Ok(UserNetworkOverlay {
            user_sources: self
                .user_sources
                .into_iter()
                .map(StoredSource::into_source)
                .collect::<Result<Vec<_>, _>>()?,
            bootstrap_overrides: self
                .bootstrap_overrides
                .into_iter()
                .map(|(id, disposition)| (SourceId::new(id), disposition.into()))
                .collect(),
            connection_policy: self.connection_policy.into_policy(),
            explorer: self
                .explorer
                .map(StoredEndpoint::into_endpoint)
                .transpose()?,
        })
    }
}

impl StoredSource {
    fn from_source(value: &ChainSource) -> Result<Self, NetworkConfigCodecError> {
        let origin = match &value.origin {
            SourceOrigin::UserAdded => StoredUserOrigin::UserAdded,
            SourceOrigin::UserInfrastructure { group } => StoredUserOrigin::UserInfrastructure {
                group: group.clone(),
            },
            SourceOrigin::Bootstrap { .. } => {
                return Err(NetworkConfigCodecError::InvalidUserSourceOrigin)
            }
        };
        Ok(Self {
            id: value.id.as_str().to_owned(),
            label: value.label.clone(),
            origin,
            endpoints: value
                .endpoints
                .iter()
                .map(StoredEndpoint::from_endpoint)
                .collect(),
            disposition: value.disposition.into(),
            priority: value.priority,
        })
    }

    fn into_source(self) -> Result<ChainSource, NetworkConfigCodecError> {
        let origin = match self.origin {
            StoredUserOrigin::UserAdded => SourceOrigin::UserAdded,
            StoredUserOrigin::UserInfrastructure { group } => {
                SourceOrigin::UserInfrastructure { group }
            }
        };
        Ok(ChainSource {
            id: SourceId::new(self.id),
            label: self.label,
            origin,
            endpoints: self
                .endpoints
                .into_iter()
                .map(StoredEndpoint::into_endpoint)
                .collect::<Result<Vec<_>, _>>()?,
            // Never restore stale advertised/verified capability claims. The
            // runtime must probe the restored endpoint again.
            capabilities: CapabilitySet::default(),
            disposition: self.disposition.into(),
            priority: self.priority,
        })
    }
}

impl StoredEndpoint {
    fn from_endpoint(value: &Endpoint) -> Self {
        Self {
            kind: value.kind.into(),
            host: value.host.clone(),
            port: value.port,
        }
    }

    fn into_endpoint(self) -> Result<Endpoint, NetworkConfigCodecError> {
        if self.host.trim().is_empty() {
            return Err(NetworkConfigCodecError::InvalidEndpoint(
                "endpoint host must not be empty".into(),
            ));
        }
        Ok(Endpoint {
            kind: self.kind.into(),
            host: self.host,
            port: self.port,
        })
    }
}

impl StoredPolicy {
    fn from_policy(value: &ConnectionPolicy) -> Self {
        let all = [
            ProtocolFamily::Electrum,
            ProtocolFamily::Bip37,
            ProtocolFamily::Neutrino,
            ProtocolFamily::BchnRpc,
            ProtocolFamily::BchnZmq,
        ];
        Self {
            protocols: all
                .into_iter()
                .filter(|protocol| value.protocols.contains(*protocol))
                .map(Into::into)
                .collect(),
            primary_scope: StoredScope::from_scope(&value.primary_scope),
            fallback_scope: value.fallback_scope.as_ref().map(StoredScope::from_scope),
            preferred: value
                .preferred
                .iter()
                .map(|id| id.as_str().to_owned())
                .collect(),
        }
    }

    fn into_policy(self) -> ConnectionPolicy {
        let mut protocols = ProtocolSet::default();
        for protocol in self.protocols {
            protocols.insert(protocol.into());
        }
        ConnectionPolicy {
            protocols,
            primary_scope: self.primary_scope.into_scope(),
            fallback_scope: self.fallback_scope.map(StoredScope::into_scope),
            preferred: self.preferred.into_iter().map(SourceId::new).collect(),
        }
    }
}

impl StoredScope {
    fn from_scope(value: &SourceScope) -> Self {
        match value {
            SourceScope::AllEnabled => Self::AllEnabled,
            SourceScope::PublicEnabled => Self::PublicEnabled,
            SourceScope::UserInfrastructure => Self::UserInfrastructure,
            SourceScope::Explicit(ids) => Self::Explicit {
                source_ids: ids.iter().map(|id| id.as_str().to_owned()).collect(),
            },
        }
    }

    fn into_scope(self) -> SourceScope {
        match self {
            Self::AllEnabled => SourceScope::AllEnabled,
            Self::PublicEnabled => SourceScope::PublicEnabled,
            Self::UserInfrastructure => SourceScope::UserInfrastructure,
            Self::Explicit { source_ids } => SourceScope::Explicit(
                source_ids
                    .into_iter()
                    .map(SourceId::new)
                    .collect::<BTreeSet<_>>(),
            ),
        }
    }
}

impl From<SourceDisposition> for StoredDisposition {
    fn from(value: SourceDisposition) -> Self {
        match value {
            SourceDisposition::Enabled => Self::Enabled,
            SourceDisposition::Disabled => Self::Disabled,
            SourceDisposition::Banned => Self::Banned,
        }
    }
}

impl From<StoredDisposition> for SourceDisposition {
    fn from(value: StoredDisposition) -> Self {
        match value {
            StoredDisposition::Enabled => Self::Enabled,
            StoredDisposition::Disabled => Self::Disabled,
            StoredDisposition::Banned => Self::Banned,
        }
    }
}

impl From<EndpointKind> for StoredEndpointKind {
    fn from(value: EndpointKind) -> Self {
        match value {
            EndpointKind::BchP2p => Self::BchP2p,
            EndpointKind::ElectrumTls => Self::ElectrumTls,
            EndpointKind::ElectrumTcp => Self::ElectrumTcp,
            EndpointKind::BchnRpc => Self::BchnRpc,
            EndpointKind::BchnZmq => Self::BchnZmq,
            EndpointKind::ExplorerHttp => Self::ExplorerHttp,
            EndpointKind::ExplorerHttps => Self::ExplorerHttps,
        }
    }
}

impl From<StoredEndpointKind> for EndpointKind {
    fn from(value: StoredEndpointKind) -> Self {
        match value {
            StoredEndpointKind::BchP2p => Self::BchP2p,
            StoredEndpointKind::ElectrumTls => Self::ElectrumTls,
            StoredEndpointKind::ElectrumTcp => Self::ElectrumTcp,
            StoredEndpointKind::BchnRpc => Self::BchnRpc,
            StoredEndpointKind::BchnZmq => Self::BchnZmq,
            StoredEndpointKind::ExplorerHttp => Self::ExplorerHttp,
            StoredEndpointKind::ExplorerHttps => Self::ExplorerHttps,
        }
    }
}

impl From<ProtocolFamily> for StoredProtocol {
    fn from(value: ProtocolFamily) -> Self {
        match value {
            ProtocolFamily::Electrum => Self::Electrum,
            ProtocolFamily::Bip37 => Self::Bip37,
            ProtocolFamily::Neutrino => Self::Neutrino,
            ProtocolFamily::BchnRpc => Self::BchnRpc,
            ProtocolFamily::BchnZmq => Self::BchnZmq,
        }
    }
}

impl From<StoredProtocol> for ProtocolFamily {
    fn from(value: StoredProtocol) -> Self {
        match value {
            StoredProtocol::Electrum => Self::Electrum,
            StoredProtocol::Bip37 => Self::Bip37,
            StoredProtocol::Neutrino => Self::Neutrino,
            StoredProtocol::BchnRpc => Self::BchnRpc,
            StoredProtocol::BchnZmq => Self::BchnZmq,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{BootstrapProject, SourceOrigin};

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
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: format!("{id}.example"),
                port: Some(50002),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 7,
        }
    }

    #[test]
    fn legacy_server_bridge_preserves_the_desktop_electrum_override() {
        let mut source = user_source("desktop-fulcrum");
        source.priority = 0;
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(source);

        let servers = legacy_network_servers_from_overlay(&overlay).unwrap();
        assert_eq!(
            servers.electrum.as_deref(),
            Some("desktop-fulcrum.example:50002")
        );
    }

    #[test]
    fn legacy_server_bridge_refuses_policy_it_cannot_enforce() {
        let overlay = UserNetworkOverlay {
            connection_policy: ConnectionPolicy::own_infrastructure(),
            ..Default::default()
        };

        assert!(legacy_network_servers_from_overlay(&overlay).is_err());
    }

    #[test]
    fn bootstrap_refresh_keeps_user_source_and_ban() {
        let mut new_base = SourceCatalog::default();
        new_base.insert(bootstrap("bootstrap-a")).unwrap();
        new_base.insert(bootstrap("bootstrap-new")).unwrap();

        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(user_source("my-node"));
        overlay
            .bootstrap_overrides
            .insert(SourceId::from("bootstrap-a"), SourceDisposition::Banned);

        let merged = merge_bootstrap_with_user_overlay(
            &new_base,
            &NetworkConfigEnvelope::current("v2", overlay),
        )
        .unwrap();

        assert_eq!(
            merged
                .get(&SourceId::from("bootstrap-a"))
                .unwrap()
                .disposition,
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
    fn json_round_trip_preserves_user_intent_but_not_ephemeral_capabilities() {
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(user_source("my-node"));
        overlay
            .bootstrap_overrides
            .insert(SourceId::new("public-bad"), SourceDisposition::Banned);
        overlay.connection_policy =
            ConnectionPolicy::exact(SourceId::new("my-node"), ProtocolFamily::Electrum);
        let envelope = NetworkConfigEnvelope::current("catalog-9", overlay);
        let json = encode_envelope_json(&envelope).unwrap();
        let restored = decode_envelope_json(&json).unwrap();
        assert_eq!(restored, envelope);
        assert!(restored.overlay.user_sources[0]
            .capabilities
            .claim(crate::chain::Capability::Broadcast)
            .is_none());
    }

    #[test]
    fn portable_export_contains_no_wallet_secret_fields() {
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(user_source("my-node"));
        let envelope = NetworkConfigEnvelope::current("v1", overlay);
        let portable = PortableNetworkConfig::from(&envelope);
        let json = export_portable_json(&portable).unwrap();
        assert!(!json.contains("seed"));
        assert!(!json.contains("private_key"));
        assert!(!json.contains("mnemonic"));
        assert_eq!(import_portable_json(&json).unwrap(), portable);
    }

    #[test]
    fn decoder_rejects_future_schema_instead_of_resetting() {
        let json = r#"{"schema_version":99,"bootstrap_catalog_version_seen":"x","overlay":{"user_sources":[],"bootstrap_overrides":{},"connection_policy":{"protocols":[],"primary_scope":{"kind":"all_enabled"},"fallback_scope":null,"preferred":[]},"explorer":null}}"#;
        assert!(matches!(
            decode_envelope_json(json),
            Err(NetworkConfigCodecError::UnsupportedSchema { found: 99, .. })
        ));
    }
}
