//! Durable network-configuration overlay for OPTN's multi-source chain runtime.
//!
//! The shipped/bootstrap catalog is versioned independently from user choices.
//! Application updates may replace that base, but must not erase user-added
//! sources, own-infrastructure groups, bans/disables, preferred order, protocol
//! filters, fallback boundaries, or explorer preference.

use crate::chain::{
    CapabilitySet, CatalogError, ChainSource, ConnectionPolicy, Endpoint, EndpointKind,
    ProtocolFamily, ProtocolSet, SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
    SourceScope, TransportPolicy,
};
use optn_app::{NetworkServers, ServerKind, ServerOverrides};
use optn_core::network::Network;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// 2 adds the transport policy (#75 §4.1). Version 1 files are still read and
/// migrate to the transport they always had; see [`migrate_stored`].
pub const NETWORK_CONFIG_SCHEMA_VERSION: u32 = 2;
/// The oldest schema this build can read and migrate forward.
pub const OLDEST_READABLE_SCHEMA_VERSION: u32 = 1;
pub const LEGACY_SERVER_CATALOG_VERSION: &str = "legacy-server-overrides-v1";

/// The legacy server fields are overrides, not additions to public Auto.
/// Only clearing every chain override opts back into the shipped defaults.
pub fn legacy_server_policy(sources: &[ChainSource]) -> ConnectionPolicy {
    let mut policy = ConnectionPolicy::auto();
    if !sources.is_empty() {
        policy.primary_scope =
            SourceScope::Explicit(sources.iter().map(|source| source.id.clone()).collect());
    }
    policy
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserNetworkOverlay {
    pub user_sources: Vec<ChainSource>,
    pub bootstrap_overrides: BTreeMap<SourceId, SourceDisposition>,
    pub connection_policy: ConnectionPolicy,
    /// Optional self-hosted explorer endpoint. Navigation only; never chain truth.
    pub explorer: Option<Endpoint>,
    /// Loopback SOCKS ports the holder has confirmed are their own Tor.
    ///
    /// Trust in a proxy cannot come from probing it: every no-auth SOCKS5
    /// proxy answers a greeting identically, and nothing in the protocol
    /// separates Tor from a corporate proxy or an SSH dynamic forward. So it
    /// comes from provenance instead -- a proxy this application started and
    /// owns needs no entry here, and anything else needs the holder to say
    /// once that it is theirs.
    ///
    /// Loopback only by design. A SOCKS proxy somewhere else on the network
    /// sees both the traffic and the address it came from, which is what Tor
    /// is being asked to hide.
    pub trusted_socks_ports: Vec<u16>,
}

impl Default for UserNetworkOverlay {
    fn default() -> Self {
        Self {
            user_sources: Vec::new(),
            bootstrap_overrides: BTreeMap::new(),
            connection_policy: ConnectionPolicy::auto(),
            explorer: None,
            trusted_socks_ports: Vec::new(),
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
    if !(OLDEST_READABLE_SCHEMA_VERSION..=NETWORK_CONFIG_SCHEMA_VERSION)
        .contains(&envelope.schema_version)
    {
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

/// Resolve the complete persisted source selection for a native host.
///
/// This is deliberately paired with the same codec used by every shell: a
/// caller either receives the catalog *and* policy the user selected, or an
/// error. Flattening the overlay to one convenient endpoint would silently
/// replace own-infrastructure, protocol, fallback, and ban choices.
pub fn resolve_chain_selection(
    bootstrap_base: &SourceCatalog,
    envelope: &NetworkConfigEnvelope,
) -> Result<(SourceCatalog, ConnectionPolicy), NetworkConfigError> {
    let catalog = merge_bootstrap_with_user_overlay(bootstrap_base, envelope)?;
    // Older server-field saves used Auto while their catalog contained only
    // the chosen overrides. Adding bootstrap discovery must not expand that
    // intent. Apply this compatibility rule in the shared GUI/CLI reader;
    // explicitly saved advanced policies retain their original meaning.
    // The transport is never part of that rule: it says how sources are
    // reached, and is kept whichever sources the rule selects.
    let policy = if envelope.bootstrap_catalog_version_seen == LEGACY_SERVER_CATALOG_VERSION
        && envelope
            .overlay
            .connection_policy
            .selects_like(&ConnectionPolicy::auto())
    {
        ConnectionPolicy {
            transport: envelope.overlay.connection_policy.transport,
            ..legacy_server_policy(&envelope.overlay.user_sources)
        }
    } else {
        envelope.overlay.connection_policy.clone()
    };
    Ok((catalog, policy))
}

/// Mount reviewed defaults and durable user intent identically in GUI and CLI.
/// Policy still controls eligibility: a catalog entry is not permission to probe
/// it, and own-infrastructure/exact selection never gains a public fallback.
pub fn resolve_shipped_chain_selection(
    network: Network,
    envelope: Option<&NetworkConfigEnvelope>,
) -> Result<(SourceCatalog, ConnectionPolicy), NetworkConfigError> {
    let bootstrap = crate::bootstrap::shipped_source_catalog(network);
    match envelope {
        Some(envelope) => resolve_chain_selection(&bootstrap, envelope),
        None => Ok((bootstrap, ConnectionPolicy::auto())),
    }
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
    // The server fields choose servers. How they are reached belongs to the
    // transport selector, so no transport makes a configuration unshowable.
    if !overlay.bootstrap_overrides.is_empty()
        || (!overlay
            .connection_policy
            .selects_like(&ConnectionPolicy::auto())
            && !overlay
                .connection_policy
                .selects_like(&legacy_server_policy(&overlay.user_sources)))
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
    /// The chain this overlay belongs to. CashAddr prefixes are shared by
    /// several test networks, so a prefix or a file name is not enough.
    pub network: Network,
    pub overlay: UserNetworkOverlay,
}

impl PortableNetworkConfig {
    /// Snapshot a network's user intent for transfer to another installation.
    ///
    /// The legacy server bridge encoded a narrow selection as Auto plus a
    /// user source. Make that effective policy explicit before dropping the
    /// local catalog marker, otherwise an import could widen it to public
    /// bootstrap sources. Proxy confirmations are machine-local provenance,
    /// so they never enter a portable backup.
    pub fn from_envelope(network: Network, value: &NetworkConfigEnvelope) -> Self {
        let mut normalized = value.clone();
        promote_legacy_policy(&mut normalized);
        normalized.overlay.trusted_socks_ports.clear();
        Self {
            schema_version: normalized.schema_version,
            network,
            overlay: normalized.overlay,
        }
    }

    /// Turn imported user intent back into a current durable envelope.
    ///
    /// The installed application supplies the current bootstrap catalog; the
    /// overlay is the portable part. A portable value never grants proxy
    /// provenance, even if a caller constructed one directly rather than via
    /// [`Self::from_envelope`].
    pub fn into_envelope(self) -> NetworkConfigEnvelope {
        let mut overlay = self.overlay;
        overlay.trusted_socks_ports.clear();
        NetworkConfigEnvelope {
            schema_version: self.schema_version,
            bootstrap_catalog_version_seen: SHIPPED_CATALOG_VERSION.to_owned(),
            overlay,
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
    NetworkMismatch { expected: Network, found: Network },
    PortableTrustNotTransferable,
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
    network: StoredNetwork,
    overlay: StoredOverlay,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredNetwork {
    Mainnet,
    Testnet3,
    Testnet4,
    Chipnet,
    Regtest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredOverlay {
    user_sources: Vec<StoredSource>,
    bootstrap_overrides: BTreeMap<String, StoredDisposition>,
    connection_policy: StoredPolicy,
    explorer: Option<StoredEndpoint>,
    /// Absent in records written before this field existed, which is the
    /// safe reading: no proxy was trusted then either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    trusted_socks_ports: Vec<u16>,
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
    IpfsGatewayHttps,
    BcmrIndexerHttps,
    BchDnsSeed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPolicy {
    protocols: Vec<StoredProtocol>,
    primary_scope: StoredScope,
    fallback_scope: Option<StoredScope>,
    preferred: Vec<String>,
    /// Absent in schema 1, where it was always this default. Required from
    /// schema 2, checked by [`migrate_stored`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transport: Option<StoredTransport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredTransport {
    Tor,
    Direct,
}

impl From<TransportPolicy> for Option<StoredTransport> {
    fn from(value: TransportPolicy) -> Self {
        Some(match value {
            TransportPolicy::Tor => StoredTransport::Tor,
            TransportPolicy::Direct => StoredTransport::Direct,
        })
    }
}

impl From<Option<StoredTransport>> for TransportPolicy {
    fn from(value: Option<StoredTransport>) -> Self {
        match value {
            None | Some(StoredTransport::Tor) => Self::Tor,
            Some(StoredTransport::Direct) => Self::Direct,
        }
    }
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

impl From<Network> for StoredNetwork {
    fn from(value: Network) -> Self {
        match value {
            Network::Mainnet => Self::Mainnet,
            Network::Testnet3 => Self::Testnet3,
            Network::Testnet4 => Self::Testnet4,
            Network::Chipnet => Self::Chipnet,
            Network::Regtest => Self::Regtest,
        }
    }
}

impl From<StoredNetwork> for Network {
    fn from(value: StoredNetwork) -> Self {
        match value {
            StoredNetwork::Mainnet => Self::Mainnet,
            StoredNetwork::Testnet3 => Self::Testnet3,
            StoredNetwork::Testnet4 => Self::Testnet4,
            StoredNetwork::Chipnet => Self::Chipnet,
            StoredNetwork::Regtest => Self::Regtest,
        }
    }
}

pub fn encode_envelope_json(
    value: &NetworkConfigEnvelope,
) -> Result<String, NetworkConfigCodecError> {
    // Always the current shape, so always the current label: a transport
    // written under an older number would be reset by the next read.
    let stored = StoredEnvelope {
        schema_version: NETWORK_CONFIG_SCHEMA_VERSION,
        bootstrap_catalog_version_seen: value.bootstrap_catalog_version_seen.clone(),
        overlay: StoredOverlay::from_overlay(&value.overlay)?,
    };
    serde_json::to_string_pretty(&stored).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))
}

pub fn decode_envelope_json(value: &str) -> Result<NetworkConfigEnvelope, NetworkConfigCodecError> {
    let mut stored: StoredEnvelope =
        serde_json::from_str(value).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))?;
    migrate_stored(stored.schema_version, &mut stored.overlay)?;
    Ok(NetworkConfigEnvelope {
        schema_version: NETWORK_CONFIG_SCHEMA_VERSION,
        bootstrap_catalog_version_seen: stored.bootstrap_catalog_version_seen,
        overlay: stored.overlay.into_overlay()?,
    })
}

pub fn export_portable_json(
    value: &PortableNetworkConfig,
) -> Result<String, NetworkConfigCodecError> {
    let mut overlay = StoredOverlay::from_overlay(&value.overlay)?;
    // A SOCKS confirmation is provenance for this installation, not portable
    // configuration. Keep the field available to the durable codec, but never
    // put it in a transfer payload.
    overlay.trusted_socks_ports.clear();
    let stored = StoredPortable {
        schema_version: NETWORK_CONFIG_SCHEMA_VERSION,
        network: value.network.into(),
        overlay,
    };
    serde_json::to_string_pretty(&stored).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))
}

/// Decode a portable overlay only for the network the caller selected.
///
/// A portable file is allowed to move user endpoints and policy, never the
/// fact that a proxy was trusted on another machine. Older or hand-edited
/// payloads that try to carry that provenance are rejected rather than
/// silently granting it.
pub fn import_portable_json(
    value: &str,
    expected_network: Network,
) -> Result<PortableNetworkConfig, NetworkConfigCodecError> {
    let mut stored: StoredPortable =
        serde_json::from_str(value).map_err(|e| NetworkConfigCodecError::Json(e.to_string()))?;
    migrate_stored(stored.schema_version, &mut stored.overlay)?;
    let network = stored.network.into();
    if network != expected_network {
        return Err(NetworkConfigCodecError::NetworkMismatch {
            expected: expected_network,
            found: network,
        });
    }
    if !stored.overlay.trusted_socks_ports.is_empty() {
        return Err(NetworkConfigCodecError::PortableTrustNotTransferable);
    }
    Ok(PortableNetworkConfig {
        schema_version: NETWORK_CONFIG_SCHEMA_VERSION,
        network,
        overlay: stored.overlay.into_overlay()?,
    })
}

/// Bring a stored overlay from `found` up to the current schema, in memory.
///
/// Nothing is written here. A migrated value reaches disk only through the
/// store's atomic write, the next time the holder saves; until then the file
/// keeps its old schema, which this build reads identically. A version this
/// build cannot read is refused rather than reset, so preferences written by
/// a newer build are never overwritten with defaults.
fn migrate_stored(found: u32, overlay: &mut StoredOverlay) -> Result<(), NetworkConfigCodecError> {
    if !(OLDEST_READABLE_SCHEMA_VERSION..=NETWORK_CONFIG_SCHEMA_VERSION).contains(&found) {
        return Err(NetworkConfigCodecError::UnsupportedSchema {
            found,
            current: NETWORK_CONFIG_SCHEMA_VERSION,
        });
    }
    // 1 -> 2: the transport every schema-1 configuration was reached with.
    if found < 2 {
        overlay.connection_policy.transport = TransportPolicy::default().into();
    } else if overlay.connection_policy.transport.is_none() {
        return Err(NetworkConfigCodecError::Json(
            "a schema-2 network configuration must name its transport".into(),
        ));
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
            trusted_socks_ports: value.trusted_socks_ports.clone(),
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
            trusted_socks_ports: self.trusted_socks_ports,
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
        let host = self.host.trim();
        if host.is_empty() {
            return Err(NetworkConfigCodecError::InvalidEndpoint(
                "endpoint host must not be empty".into(),
            ));
        }
        if host.contains(['/', '\\', '@', '?', '#']) || host.chars().any(char::is_whitespace) {
            return Err(NetworkConfigCodecError::InvalidEndpoint(
                "endpoint host must be a host name or IP literal, not a URL or path".into(),
            ));
        }
        if self.port == Some(0) {
            return Err(NetworkConfigCodecError::InvalidEndpoint(
                "endpoint port must be between 1 and 65535".into(),
            ));
        }
        if matches!(
            self.kind,
            StoredEndpointKind::BchP2p
                | StoredEndpointKind::ElectrumTls
                | StoredEndpointKind::ElectrumTcp
                | StoredEndpointKind::BchnRpc
                | StoredEndpointKind::BchnZmq
                | StoredEndpointKind::IpfsGatewayHttps
                | StoredEndpointKind::BcmrIndexerHttps
                | StoredEndpointKind::BchDnsSeed
        ) && self.port.is_none()
        {
            return Err(NetworkConfigCodecError::InvalidEndpoint(
                "chain endpoint requires an explicit port".into(),
            ));
        }
        Ok(Endpoint {
            kind: self.kind.into(),
            host: host.to_owned(),
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
            transport: value.transport.into(),
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
            transport: self.transport.into(),
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
            EndpointKind::IpfsGatewayHttps => Self::IpfsGatewayHttps,
            EndpointKind::BcmrIndexerHttps => Self::BcmrIndexerHttps,
            EndpointKind::BchDnsSeed => Self::BchDnsSeed,
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
            StoredEndpointKind::IpfsGatewayHttps => Self::IpfsGatewayHttps,
            StoredEndpointKind::BcmrIndexerHttps => Self::BcmrIndexerHttps,
            StoredEndpointKind::BchDnsSeed => Self::BchDnsSeed,
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

/// The policy choices a person actually makes, as #75 names them.
///
/// A preset is a readable name for a `ConnectionPolicy`, not a second policy
/// model: every one of these round-trips through [`ChainPolicyPreset::policy`]
/// and back, so a surface can offer names while the runtime keeps enforcing the
/// policy itself. A policy that no preset describes stays [`Self::Custom`]
/// rather than being rounded to the nearest one, because silently relaxing
/// "own infrastructure only" into "auto" is exactly the leak #75 forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainPolicyPreset {
    /// Operation-aware selection across every enabled source.
    Auto,
    /// Client-side filtering only: no wallet scripts handed to indexed servers.
    Privacy,
    /// Only sources the holder declared as their own infrastructure.
    OwnInfrastructure,
    ElectrumOnly,
    Bip37Only,
    NeutrinoOnly,
    /// Something this list cannot name; left exactly as persisted.
    Custom,
}

impl ChainPolicyPreset {
    /// The policy this preset means. `Custom` has none by definition.
    pub fn policy(self) -> Option<ConnectionPolicy> {
        Some(match self {
            Self::Auto => ConnectionPolicy::auto(),
            Self::Privacy => {
                // Bloom/compact-filter SPV asks for blocks, not for "tell me
                // about this address", which is the distinction #75 draws
                // between Privacy and Auto.
                let mut protocols = ProtocolSet::only(ProtocolFamily::Bip37);
                protocols.insert(ProtocolFamily::Neutrino);
                ConnectionPolicy {
                    protocols,
                    primary_scope: SourceScope::AllEnabled,
                    fallback_scope: None,
                    preferred: Vec::new(),
                    transport: TransportPolicy::default(),
                }
            }
            Self::OwnInfrastructure => ConnectionPolicy::own_infrastructure(),
            Self::ElectrumOnly => protocol_only(ProtocolFamily::Electrum),
            Self::Bip37Only => protocol_only(ProtocolFamily::Bip37),
            Self::NeutrinoOnly => protocol_only(ProtocolFamily::Neutrino),
            Self::Custom => return None,
        })
    }

    /// Name a persisted policy, or report that no name fits it.
    pub fn describe(policy: &ConnectionPolicy) -> Self {
        for candidate in [
            Self::Auto,
            Self::Privacy,
            Self::OwnInfrastructure,
            Self::ElectrumOnly,
            Self::Bip37Only,
            Self::NeutrinoOnly,
        ] {
            // A preset names sources and protocols; transport is separate.
            if candidate
                .policy()
                .is_some_and(|named| named.selects_like(policy))
            {
                return candidate;
            }
        }
        Self::Custom
    }
}

fn protocol_only(protocol: ProtocolFamily) -> ConnectionPolicy {
    ConnectionPolicy {
        protocols: ProtocolSet::only(protocol),
        primary_scope: SourceScope::AllEnabled,
        fallback_scope: None,
        preferred: Vec::new(),
        transport: TransportPolicy::default(),
    }
}

/// Make a legacy envelope's effective policy explicit before editing it.
///
/// A file written by the one-server settings bridge carries the legacy catalog
/// marker, and its `Auto` policy does not mean auto: the reader narrows it to
/// the saved overrides so adding bootstrap discovery cannot widen an existing
/// choice. An editor that writes richer intent has to stop relying on that
/// reader rule, so the effective policy is written down first and only then is
/// the marker advanced. Without this step, saving any unrelated change would
/// silently turn "only my server" into "auto over every shipped server".
pub fn promote_legacy_policy(envelope: &mut NetworkConfigEnvelope) {
    if envelope.bootstrap_catalog_version_seen != LEGACY_SERVER_CATALOG_VERSION {
        return;
    }
    if envelope
        .overlay
        .connection_policy
        .selects_like(&ConnectionPolicy::auto())
    {
        envelope.overlay.connection_policy = ConnectionPolicy {
            transport: envelope.overlay.connection_policy.transport,
            ..legacy_server_policy(&envelope.overlay.user_sources)
        };
    }
    envelope.bootstrap_catalog_version_seen = SHIPPED_CATALOG_VERSION.to_owned();
}

/// Marker for envelopes whose policy field means exactly what it says.
pub const SHIPPED_CATALOG_VERSION: &str = "optn-shipped-v3-metadata-20260926";

/// Apply a named policy to the overlay.
///
/// `Custom` is refused: it is the answer to "what is this policy called", not
/// an instruction, and accepting it would quietly overwrite an advanced policy
/// with whatever this function guessed.
pub fn set_policy_preset(
    overlay: &mut UserNetworkOverlay,
    preset: ChainPolicyPreset,
) -> Result<(), String> {
    let mut policy = preset
        .policy()
        .ok_or("a custom policy cannot be selected by name")?;
    // Choosing which sources to use never changes how they are reached.
    policy.transport = overlay.connection_policy.transport;
    overlay.connection_policy = policy;
    Ok(())
}

/// Enable, disable or ban one source.
///
/// A bootstrap entry is recorded as an override rather than edited, because the
/// shipped catalog is replaced on update and a copy would be silently restored
/// to whatever the new base says. User sources carry their disposition
/// directly, since nothing else supplies them.
pub fn set_source_disposition(
    overlay: &mut UserNetworkOverlay,
    id: &SourceId,
    disposition: SourceDisposition,
) -> Result<(), String> {
    if let Some(source) = overlay
        .user_sources
        .iter_mut()
        .find(|source| &source.id == id)
    {
        source.disposition = disposition;
        return Ok(());
    }
    overlay.bootstrap_overrides.insert(id.clone(), disposition);
    Ok(())
}

/// Add a source the holder typed in.
///
/// The id is derived from the endpoint rather than supplied, so adding the same
/// host twice is refused instead of producing two entries that the selection
/// plan would treat as independent.
pub fn add_user_source(
    overlay: &mut UserNetworkOverlay,
    label: &str,
    endpoint: Endpoint,
    infrastructure_group: Option<&str>,
) -> Result<SourceId, String> {
    let host = endpoint
        .host
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err("a source needs a host".into());
    }
    let id = SourceId::new(format!("host:{host}"));
    // Store the normalized host, not what was typed. The id already collapses
    // case and a trailing dot, so keeping the raw spelling made the same server
    // added twice look like two different endpoints under one source -- and
    // handed the dialer a name that differs from the one the id promised.
    let endpoint = Endpoint {
        host: host.clone(),
        ..endpoint
    };
    let infrastructure_group = infrastructure_group
        .map(str::trim)
        .filter(|group| !group.is_empty());
    if let Some(existing) = overlay
        .user_sources
        .iter_mut()
        .find(|source| source.id == id)
    {
        match (&existing.origin, infrastructure_group) {
            (SourceOrigin::UserAdded, Some(_)) => {
                return Err(format!(
                    "{host} is already a custom source. Adding a service cannot change its ownership; remove this user-created source before re-adding it as infrastructure."
                ));
            }
            (SourceOrigin::UserInfrastructure { group }, Some(requested)) if group != requested => {
                return Err(format!(
                    "{host} already belongs to infrastructure group '{group}'"
                ));
            }
            (SourceOrigin::UserAdded | SourceOrigin::UserInfrastructure { .. }, _) => {}
            _ => return Err(format!("{host} is not a user-managed source")),
        }
        if existing.endpoints.contains(&endpoint) {
            return Err(format!("{host} is already a source"));
        }
        existing.endpoints.push(endpoint);
        return Ok(id);
    }
    let label = label.trim();
    overlay.user_sources.push(ChainSource {
        id: id.clone(),
        label: if label.is_empty() {
            host.clone()
        } else {
            label.to_owned()
        },
        origin: match infrastructure_group {
            // "Own infrastructure" is a claim about ownership, so it is the
            // holder's to make; it is also what `OwnInfrastructure` policy and
            // the direct-dial rule key off, which is why it is not inferred
            // from the address.
            Some(group) => SourceOrigin::UserInfrastructure {
                group: group.to_owned(),
            },
            _ => SourceOrigin::UserAdded,
        },
        endpoints: vec![endpoint],
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority: 0,
    });
    Ok(id)
}

/// Add a logical source's service bundle without exposing partial updates.
pub fn add_user_source_services(
    overlay: &mut UserNetworkOverlay,
    label: &str,
    endpoints: Vec<Endpoint>,
    infrastructure_group: Option<&str>,
) -> Result<SourceId, String> {
    if endpoints.is_empty() || endpoints.len() > 16 {
        return Err("Choose between one and sixteen services for this source".into());
    }
    let mut staged = overlay.clone();
    let mut id = None;
    for endpoint in endpoints {
        let endpoint = StoredEndpoint::from_endpoint(&endpoint)
            .into_endpoint()
            .map_err(|error| format!("Invalid service endpoint: {error:?}"))?;
        let added = add_user_source(&mut staged, label, endpoint, infrastructure_group)?;
        if id.as_ref().is_some_and(|first| first != &added) {
            return Err("Services on different hosts belong to separate sources".into());
        }
        id = Some(added);
    }
    *overlay = staged;
    Ok(id.expect("nonempty services checked above"))
}

/// Remove a user-created source without broadening its selection policy.
pub fn remove_user_source(overlay: &mut UserNetworkOverlay, id: &SourceId) -> Result<(), String> {
    let before = overlay.user_sources.len();
    overlay.user_sources.retain(|source| &source.id != id);
    if overlay.user_sources.len() == before {
        return Err("that source is not one this device added; disable it instead".into());
    }
    // Removing a source is not consent to expand the permitted route pool.
    // An empty explicit scope intentionally stays offline until the holder edits it.
    overlay
        .connection_policy
        .preferred
        .retain(|kept| kept != id);
    if let SourceScope::Explicit(selected) = &mut overlay.connection_policy.primary_scope {
        selected.remove(id);
    }
    if let Some(SourceScope::Explicit(selected)) = &mut overlay.connection_policy.fallback_scope {
        selected.remove(id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{BootstrapProject, SourceOrigin};

    #[test]
    fn service_bundle_is_one_source_and_rejects_partial_or_cross_host_updates() {
        let mut overlay = UserNetworkOverlay::default();
        let endpoints = vec![
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "Node.Home.".into(),
                port: Some(48333),
            },
            Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "node.home".into(),
                port: Some(48332),
            },
            Endpoint {
                kind: EndpointKind::BchnZmq,
                host: "node.home".into(),
                port: Some(28332),
            },
        ];
        let id =
            add_user_source_services(&mut overlay, "My node", endpoints, Some("home")).unwrap();
        assert_eq!(overlay.user_sources.len(), 1);
        assert_eq!(overlay.user_sources[0].endpoints.len(), 3);
        assert_eq!(overlay.user_sources[0].id, id);
        assert!(overlay.user_sources[0].capabilities.iter().next().is_none());
        let before = overlay.clone();
        let electrum = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "node.home".into(),
            port: Some(50002),
        };
        let duplicate = overlay.user_sources[0].endpoints[0].clone();
        assert!(add_user_source_services(
            &mut overlay,
            "Other",
            vec![electrum.clone(), duplicate],
            Some("home")
        )
        .is_err());
        assert_eq!(overlay, before);
        let other_host = Endpoint {
            host: "other.home".into(),
            ..electrum.clone()
        };
        assert!(add_user_source_services(
            &mut overlay,
            "Other",
            vec![electrum.clone(), other_host],
            Some("home")
        )
        .is_err());
        assert_eq!(overlay, before);
        add_user_source_services(&mut overlay, "Other", vec![electrum], Some("home")).unwrap();
        assert_eq!(overlay.user_sources.len(), 1);
        assert_eq!(overlay.user_sources[0].label, "My node");
        assert_eq!(overlay.user_sources[0].endpoints.len(), 4);
    }

    #[test]
    fn editing_a_legacy_file_keeps_its_narrower_meaning() {
        // The legacy reader treats Auto-with-overrides as "only these". Writing
        // richer intent leaves that reader rule behind, so the narrower policy
        // has to become explicit in the same write or the next launch would
        // quietly reach for every shipped public server instead.
        let mut overlay = UserNetworkOverlay::default();
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "mine.example".into(),
            port: Some(50002),
        };
        add_user_source(&mut overlay, "Mine", endpoint, None).unwrap();
        let mut envelope = NetworkConfigEnvelope::current(LEGACY_SERVER_CATALOG_VERSION, overlay);
        let before = resolve_shipped_chain_selection(Network::Chipnet, Some(&envelope))
            .unwrap()
            .1;

        promote_legacy_policy(&mut envelope);

        assert_eq!(
            envelope.bootstrap_catalog_version_seen,
            SHIPPED_CATALOG_VERSION
        );
        assert_eq!(envelope.overlay.connection_policy, before);
        assert_ne!(envelope.overlay.connection_policy, ConnectionPolicy::auto());
        assert_eq!(
            resolve_shipped_chain_selection(Network::Chipnet, Some(&envelope))
                .unwrap()
                .1,
            before
        );
    }

    #[test]
    fn every_named_policy_round_trips_and_an_unnamed_one_stays_custom() {
        for preset in [
            ChainPolicyPreset::Auto,
            ChainPolicyPreset::Privacy,
            ChainPolicyPreset::OwnInfrastructure,
            ChainPolicyPreset::ElectrumOnly,
            ChainPolicyPreset::Bip37Only,
            ChainPolicyPreset::NeutrinoOnly,
        ] {
            let policy = preset.policy().expect("a named preset has a policy");
            assert_eq!(ChainPolicyPreset::describe(&policy), preset);
        }
        assert_eq!(ChainPolicyPreset::Custom.policy(), None);

        // An advanced policy no name describes must not be rounded to the
        // nearest preset: reporting "auto" for a pinned single source is how a
        // surface would later overwrite it with a public fallback.
        let pinned =
            ConnectionPolicy::exact(SourceId::new("host:node.example"), ProtocolFamily::Bip37);
        assert_eq!(
            ChainPolicyPreset::describe(&pinned),
            ChainPolicyPreset::Custom
        );

        let mut overlay = UserNetworkOverlay::default();
        assert!(set_policy_preset(&mut overlay, ChainPolicyPreset::Custom).is_err());
        overlay.connection_policy = pinned.clone();
        assert!(set_policy_preset(&mut overlay, ChainPolicyPreset::Custom).is_err());
        assert_eq!(
            overlay.connection_policy, pinned,
            "a refused edit changes nothing"
        );
    }

    #[test]
    fn privacy_never_selects_an_address_querying_protocol() {
        // The point of Privacy in #75 is that wallet scripts are not handed to
        // a public indexed server, so Electrum must be absent by construction.
        let policy = ChainPolicyPreset::Privacy.policy().unwrap();
        assert!(!policy.protocols.contains(ProtocolFamily::Electrum));
        assert!(policy.protocols.contains(ProtocolFamily::Bip37));
        assert!(policy.protocols.contains(ProtocolFamily::Neutrino));
    }

    #[test]
    fn a_disabled_bootstrap_source_is_recorded_as_an_override() {
        // Bootstrap entries are replaced wholesale on update. Editing a copy
        // would let the next release silently re-enable something banned here.
        let mut overlay = UserNetworkOverlay::default();
        let id = SourceId::new("bootstrap:electrum-tls:server.example:50002");
        set_source_disposition(&mut overlay, &id, SourceDisposition::Banned).unwrap();
        assert_eq!(
            overlay.bootstrap_overrides.get(&id),
            Some(&SourceDisposition::Banned)
        );
        assert!(overlay.user_sources.is_empty());
    }

    #[test]
    fn adding_a_source_twice_is_refused_rather_than_duplicated() {
        let mut overlay = UserNetworkOverlay::default();
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "Node.Example.".into(),
            port: Some(50002),
        };
        let id = add_user_source(&mut overlay, "Home", endpoint.clone(), None).unwrap();
        // The id normalizes the host, so case and a trailing dot cannot produce
        // a second entry the selection plan would treat as another server.
        assert_eq!(id, SourceId::new("host:node.example"));
        let again = Endpoint {
            host: "node.example".into(),
            ..endpoint.clone()
        };
        assert!(add_user_source(&mut overlay, "Home", again, None).is_err());
        assert_eq!(overlay.user_sources.len(), 1);

        // A second protocol on the same host joins that source instead.
        let peer = Endpoint {
            kind: EndpointKind::BchP2p,
            host: "node.example".into(),
            port: Some(8333),
        };
        add_user_source(&mut overlay, "Home", peer, None).unwrap();
        assert_eq!(overlay.user_sources.len(), 1);
        assert_eq!(overlay.user_sources[0].endpoints.len(), 2);
    }

    #[test]
    fn declaring_a_group_marks_the_source_as_own_infrastructure() {
        let mut overlay = UserNetworkOverlay::default();
        let endpoint = Endpoint {
            kind: EndpointKind::BchP2p,
            host: "10.0.0.2".into(),
            port: Some(8333),
        };
        add_user_source(&mut overlay, "Rack", endpoint, Some(" home ")).unwrap();
        assert!(matches!(
            &overlay.user_sources[0].origin,
            SourceOrigin::UserInfrastructure { group } if group == "home"
        ));
        assert!(overlay.user_sources[0].is_user_infrastructure());
    }

    #[test]
    fn adding_a_group_to_an_existing_public_host_is_refused_without_promotion() {
        let mut overlay = UserNetworkOverlay::default();
        add_user_source(
            &mut overlay,
            "Public",
            Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "node.example".into(),
                port: Some(50002),
            },
            None,
        )
        .unwrap();

        assert!(add_user_source(
            &mut overlay,
            "Mine",
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "node.example".into(),
                port: Some(8333),
            },
            Some("home"),
        )
        .is_err());
        assert!(matches!(
            overlay.user_sources[0].origin,
            SourceOrigin::UserAdded
        ));
        assert_eq!(overlay.user_sources[0].endpoints.len(), 1);
    }

    #[test]
    fn conflicting_group_for_an_existing_own_host_is_refused_but_ungrouped_append_keeps_it_own() {
        let mut overlay = UserNetworkOverlay::default();
        add_user_source(
            &mut overlay,
            "Home",
            Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "node.example".into(),
                port: Some(50002),
            },
            Some("home"),
        )
        .unwrap();

        assert!(add_user_source(
            &mut overlay,
            "Office",
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "node.example".into(),
                port: Some(8333),
            },
            Some("office"),
        )
        .is_err());
        add_user_source(
            &mut overlay,
            "Home",
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "node.example".into(),
                port: Some(8333),
            },
            None,
        )
        .unwrap();
        assert!(matches!(
            &overlay.user_sources[0].origin,
            SourceOrigin::UserInfrastructure { group } if group == "home"
        ));
        assert_eq!(overlay.user_sources[0].endpoints.len(), 2);
    }

    #[test]
    fn removing_a_pinned_source_preserves_privacy_after_restart() {
        let mut overlay = UserNetworkOverlay::default();
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "node.example".into(),
            port: Some(50002),
        };
        let id = add_user_source(&mut overlay, "Home", endpoint, None).unwrap();
        overlay.connection_policy = ConnectionPolicy::exact(id.clone(), ProtocolFamily::Electrum);

        remove_user_source(&mut overlay, &id).unwrap();
        assert!(overlay.user_sources.is_empty());
        assert_eq!(
            overlay.connection_policy.protocols,
            ProtocolSet::only(ProtocolFamily::Electrum)
        );
        assert_eq!(
            overlay.connection_policy.primary_scope,
            SourceScope::Explicit(Default::default())
        );
        assert!(overlay.connection_policy.fallback_scope.is_none());
        let saved = NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, overlay.clone());
        let reopened = decode_envelope_json(&encode_envelope_json(&saved).unwrap()).unwrap();
        let (catalog, policy) =
            resolve_shipped_chain_selection(Network::Chipnet, Some(&reopened)).unwrap();
        assert!(catalog.iter().any(|source| source.is_public()));
        let plan = crate::chain::build_selection_plan(&catalog, &policy);
        assert!(plan.primary.is_empty());
        assert!(plan.fallback.is_empty());

        // A bootstrap entry is not this device's to delete.
        assert!(remove_user_source(&mut overlay, &SourceId::new("bootstrap:x")).is_err());
    }

    #[test]
    fn removal_prunes_explicit_fallback_without_expanding_other_scopes() {
        let mut overlay = UserNetworkOverlay::default();
        let id = add_user_source(
            &mut overlay,
            "Home",
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "node.example".into(),
                port: Some(48333),
            },
            Some("home"),
        )
        .unwrap();
        overlay.connection_policy = ConnectionPolicy::own_infrastructure();
        overlay.connection_policy.preferred = vec![id.clone()];
        overlay.connection_policy.fallback_scope =
            Some(SourceScope::Explicit(BTreeSet::from([id.clone()])));
        let protocols = overlay.connection_policy.protocols.clone();
        remove_user_source(&mut overlay, &id).unwrap();
        assert_eq!(
            overlay.connection_policy.primary_scope,
            SourceScope::UserInfrastructure
        );
        assert_eq!(overlay.connection_policy.protocols, protocols);
        assert!(overlay.connection_policy.preferred.is_empty());
        assert_eq!(
            overlay.connection_policy.fallback_scope,
            Some(SourceScope::Explicit(BTreeSet::new()))
        );
        let saved = NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, overlay);
        let (catalog, policy) =
            resolve_shipped_chain_selection(Network::Chipnet, Some(&saved)).unwrap();
        let plan = crate::chain::build_selection_plan(&catalog, &policy);
        assert!(plan.primary.is_empty() && plan.fallback.is_empty());
    }

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
    fn saved_server_overrides_never_gain_public_fallback_after_restart() {
        use crate::chain::build_selection_plan;

        let mut source = user_source("chosen-server");
        source.priority = 0;
        // An unreachable local override is still a selection, never consent
        // to reveal this wallet to a different public server.
        source.endpoints[0].host = "127.0.0.1".into();
        source.endpoints[0].port = Some(1);
        let mut overlay = UserNetworkOverlay {
            user_sources: vec![source.clone()],
            ..Default::default()
        };
        for stored_policy in [
            ConnectionPolicy::auto(),
            legacy_server_policy(&overlay.user_sources),
        ] {
            overlay.connection_policy = stored_policy;
            let saved =
                NetworkConfigEnvelope::current(LEGACY_SERVER_CATALOG_VERSION, overlay.clone());
            let reopened = decode_envelope_json(&encode_envelope_json(&saved).unwrap()).unwrap();
            assert_eq!(
                legacy_network_servers_from_overlay(&reopened.overlay)
                    .unwrap()
                    .electrum
                    .as_deref(),
                Some("127.0.0.1:1")
            );
            let (mut catalog, policy) =
                resolve_shipped_chain_selection(Network::Chipnet, Some(&reopened)).unwrap();
            assert!(catalog.iter().any(|entry| entry.is_public()));
            assert_eq!(
                build_selection_plan(&catalog, &policy).primary,
                vec![source.id.clone()]
            );
            catalog
                .set_disposition(&source.id, SourceDisposition::Disabled)
                .unwrap();
            let unavailable = build_selection_plan(&catalog, &policy);
            assert!(unavailable.primary.is_empty());
            assert!(unavailable.fallback.is_empty());
        }

        // Advanced Auto retains its explicit policy; the compatibility rule
        // belongs only to records emitted by the old server-override bridge.
        overlay.connection_policy = ConnectionPolicy::auto();
        let advanced = NetworkConfigEnvelope::current("advanced-auto", overlay);
        let (catalog, policy) =
            resolve_shipped_chain_selection(Network::Chipnet, Some(&advanced)).unwrap();
        assert_eq!(
            build_selection_plan(&catalog, &policy).primary.len(),
            crate::bootstrap::shipped_source_catalog(Network::Chipnet)
                .iter()
                .filter(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
                .count()
                + 1
        );

        let reset =
            NetworkConfigEnvelope::current(LEGACY_SERVER_CATALOG_VERSION, Default::default());
        let (catalog, policy) =
            resolve_shipped_chain_selection(Network::Chipnet, Some(&reset)).unwrap();
        let defaults = build_selection_plan(&catalog, &policy);
        assert_eq!(
            defaults.primary.len(),
            crate::bootstrap::shipped_source_catalog(Network::Chipnet)
                .iter()
                .filter(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
                .count()
        );
        assert!(catalog.get(&defaults.primary[0]).unwrap().is_public());
    }

    /// The old server fields choose servers; the transport selector says how
    /// they are reached. Neither may undo the other.
    #[test]
    fn legacy_server_fields_hold_their_meaning_under_every_transport() {
        use crate::chain::build_selection_plan;
        let mut source = user_source("chosen-server");
        source.priority = 0;
        for transport in TransportPolicy::ALL {
            let mut overlay = UserNetworkOverlay {
                user_sources: vec![source.clone()],
                ..Default::default()
            };
            // Auto, as the one-server bridge wrote it, over this transport.
            overlay.connection_policy.transport = transport;
            assert_eq!(
                legacy_network_servers_from_overlay(&overlay)
                    .unwrap()
                    .electrum
                    .as_deref(),
                Some("chosen-server.example:50002"),
                "{transport:?}"
            );
            let mut envelope =
                NetworkConfigEnvelope::current(LEGACY_SERVER_CATALOG_VERSION, overlay);
            let (catalog, policy) =
                resolve_shipped_chain_selection(Network::Chipnet, Some(&envelope)).unwrap();
            // Still "only this server", never Auto over every shipped one.
            assert_eq!(
                build_selection_plan(&catalog, &policy).primary,
                vec![source.id.clone()],
                "{transport:?}"
            );
            assert_eq!(policy.transport, transport);
            // Making that explicit before an edit keeps both halves.
            promote_legacy_policy(&mut envelope);
            assert_eq!(envelope.overlay.connection_policy, policy, "{transport:?}");
        }
    }

    #[test]
    fn chain_selection_keeps_the_persisted_policy_and_source_kind() {
        let source = ChainSource {
            id: SourceId::new("self-hosted"),
            label: "My node".into(),
            origin: SourceOrigin::UserInfrastructure {
                group: "rack".into(),
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::BchP2p,
                host: "127.0.0.1".into(),
                port: Some(8333),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        let policy = ConnectionPolicy::exact(source.id.clone(), ProtocolFamily::Bip37);
        let envelope = NetworkConfigEnvelope::current(
            "test",
            UserNetworkOverlay {
                user_sources: vec![source.clone()],
                connection_policy: policy.clone(),
                ..Default::default()
            },
        );

        let (catalog, restored_policy) =
            resolve_chain_selection(&SourceCatalog::default(), &envelope).unwrap();
        assert_eq!(restored_policy, policy);
        assert_eq!(catalog.get(&source.id), Some(&source));
    }

    #[test]
    fn shipped_selection_preserves_bans_and_never_expands_private_scope() {
        use crate::chain::build_selection_plan;
        for network in [Network::Mainnet, Network::Chipnet] {
            let (catalog, policy) = resolve_shipped_chain_selection(network, None).unwrap();
            let default = catalog
                .iter()
                .find(|source| source.endpoints[0].host == network.default_host())
                .expect("reviewed network default");
            assert_eq!(default.endpoints[0].host, network.default_host());
            let eligible = build_selection_plan(&catalog, &policy).primary;
            // Metadata entries belong in the catalog, not the chain sync pool.
            assert_eq!(
                eligible.len(),
                catalog
                    .iter()
                    .filter(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
                    .count()
            );
            assert!(eligible.contains(&default.id));

            let mut overlay = UserNetworkOverlay::default();
            overlay
                .bootstrap_overrides
                .insert(default.id.clone(), SourceDisposition::Banned);
            let envelope = NetworkConfigEnvelope::current("older-release", overlay);
            let (banned, policy) =
                resolve_shipped_chain_selection(network, Some(&envelope)).unwrap();
            let remaining = build_selection_plan(&banned, &policy).primary;
            assert_eq!(remaining.len(), eligible.len() - 1);
            assert!(!remaining.contains(&default.id));
            assert_eq!(
                banned.get(&default.id).unwrap().disposition,
                SourceDisposition::Banned
            );

            let envelope = NetworkConfigEnvelope::current(
                "older-release",
                UserNetworkOverlay {
                    connection_policy: ConnectionPolicy::own_infrastructure(),
                    ..Default::default()
                },
            );
            let (private, policy) =
                resolve_shipped_chain_selection(network, Some(&envelope)).unwrap();
            let selection = build_selection_plan(&private, &policy);
            assert!(selection.primary.is_empty());
            assert!(selection.fallback.is_empty());
        }
        assert_eq!(
            resolve_shipped_chain_selection(Network::Regtest, None)
                .unwrap()
                .0
                .iter()
                .count(),
            0
        );
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
    fn portable_export_is_network_bound_and_excludes_local_proxy_provenance() {
        let mut overlay = UserNetworkOverlay::default();
        let mut own = user_source("my-node");
        own.origin = SourceOrigin::UserInfrastructure {
            group: "home-rack".into(),
        };
        own.priority = 4;
        overlay.user_sources.push(own.clone());
        overlay
            .bootstrap_overrides
            .insert(SourceId::new("bootstrap:bad"), SourceDisposition::Banned);
        overlay.connection_policy = ConnectionPolicy::own_infrastructure();
        overlay.connection_policy.preferred = vec![own.id.clone()];
        overlay.trusted_socks_ports = vec![9050];
        let envelope = NetworkConfigEnvelope::current("v1", overlay);
        let portable = PortableNetworkConfig::from_envelope(Network::Chipnet, &envelope);
        let json = export_portable_json(&portable).unwrap();
        assert!(!json.contains("seed"));
        assert!(!json.contains("private_key"));
        assert!(!json.contains("mnemonic"));
        assert!(json.contains("\"network\": \"chipnet\""));
        assert!(!json.contains("trusted_socks_ports"));
        assert!(portable.overlay.trusted_socks_ports.is_empty());
        assert_eq!(
            import_portable_json(&json, Network::Chipnet).unwrap(),
            portable
        );
        assert!(matches!(
            import_portable_json(&json, Network::Mainnet),
            Err(NetworkConfigCodecError::NetworkMismatch {
                expected: Network::Mainnet,
                found: Network::Chipnet,
            })
        ));
        assert_eq!(portable.overlay.user_sources[0].origin, own.origin);
        assert_eq!(
            portable
                .overlay
                .bootstrap_overrides
                .get(&SourceId::new("bootstrap:bad")),
            Some(&SourceDisposition::Banned)
        );
        assert_eq!(
            portable.overlay.connection_policy.preferred,
            vec![SourceId::new("my-node")]
        );
    }

    #[test]
    fn portable_import_rejects_proxy_provenance_injected_into_payload() {
        let envelope = NetworkConfigEnvelope::current("v1", UserNetworkOverlay::default());
        let portable = PortableNetworkConfig::from_envelope(Network::Chipnet, &envelope);
        let json = export_portable_json(&portable).unwrap();
        let mut payload: serde_json::Value = serde_json::from_str(&json).unwrap();
        payload["overlay"]["trusted_socks_ports"] = serde_json::json!([9050]);
        let injected = serde_json::to_string(&payload).unwrap();
        assert!(matches!(
            import_portable_json(&injected, Network::Chipnet),
            Err(NetworkConfigCodecError::PortableTrustNotTransferable)
        ));
    }

    #[test]
    fn decoder_rejects_future_schema_instead_of_resetting() {
        let json = r#"{"schema_version":99,"bootstrap_catalog_version_seen":"x","overlay":{"user_sources":[],"bootstrap_overrides":{},"connection_policy":{"protocols":[],"primary_scope":{"kind":"all_enabled"},"fallback_scope":null,"preferred":[]},"explorer":null}}"#;
        assert!(matches!(
            decode_envelope_json(json),
            Err(NetworkConfigCodecError::UnsupportedSchema { found: 99, .. })
        ));
    }

    /// A configuration exercising everything a migration could drop: an own
    /// infrastructure group, a pasted source, a ban, a pinned order, protocol
    /// filters, a fallback scope, an explorer and a confirmed proxy.
    fn rich_overlay() -> UserNetworkOverlay {
        let mut overlay = UserNetworkOverlay::default();
        let mut own = user_source("my-node");
        own.origin = SourceOrigin::UserInfrastructure {
            group: "home-rack".into(),
        };
        own.priority = 4;
        let mut pasted = user_source("pasted");
        pasted.disposition = SourceDisposition::Disabled;
        overlay.user_sources = vec![own.clone(), pasted];
        overlay
            .bootstrap_overrides
            .insert(SourceId::new("bootstrap:bad"), SourceDisposition::Banned);
        overlay.connection_policy = ConnectionPolicy {
            protocols: ProtocolSet::only(ProtocolFamily::Electrum),
            primary_scope: SourceScope::UserInfrastructure,
            fallback_scope: Some(SourceScope::PublicEnabled),
            preferred: vec![own.id, SourceId::new("pasted")],
            transport: TransportPolicy::default(),
        };
        overlay.explorer = Some(Endpoint {
            kind: EndpointKind::ExplorerHttps,
            host: "explorer.example".into(),
            port: Some(443),
        });
        overlay.trusted_socks_ports = vec![9050];
        overlay
    }

    /// What a schema-1 build wrote for the same configuration: that number,
    /// and no transport. Envelopes and portable files share the layout.
    fn as_schema_1(json: &str) -> String {
        let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
        value["schema_version"] = serde_json::json!(1);
        let policy = value["overlay"]["connection_policy"]
            .as_object_mut()
            .unwrap();
        assert!(policy.remove("transport").is_some());
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn schema_1_reads_as_schema_2_with_the_transport_it_always_had() {
        let envelope = NetworkConfigEnvelope::current("catalog-9", rich_overlay());
        let schema_1 = as_schema_1(&encode_envelope_json(&envelope).unwrap());
        assert!(!schema_1.contains("transport"));

        let migrated = decode_envelope_json(&schema_1).unwrap();
        // Every field survives, and the transport is the one schema 1 used.
        assert_eq!(migrated, envelope);
        assert_eq!(migrated.schema_version, NETWORK_CONFIG_SCHEMA_VERSION);
        assert_eq!(
            migrated.overlay.connection_policy.transport,
            TransportPolicy::Tor
        );
        assert!(merge_bootstrap_with_user_overlay(&SourceCatalog::default(), &migrated).is_ok());

        // Saving it writes schema 2 and names the transport.
        let saved = encode_envelope_json(&migrated).unwrap();
        let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(value["schema_version"], NETWORK_CONFIG_SCHEMA_VERSION);
        assert_eq!(value["overlay"]["connection_policy"]["transport"], "tor");
        assert_eq!(decode_envelope_json(&saved).unwrap(), envelope);

        // A schema-1 portable backup imports the same way.
        let portable = PortableNetworkConfig::from_envelope(Network::Chipnet, &envelope);
        let exported = export_portable_json(&portable).unwrap();
        let imported = import_portable_json(&as_schema_1(&exported), Network::Chipnet).unwrap();
        assert_eq!(imported, portable);
    }

    #[test]
    fn every_transport_survives_saving_and_portable_transfer() {
        for transport in TransportPolicy::ALL {
            let mut overlay = rich_overlay();
            overlay.connection_policy.transport = transport;
            let envelope = NetworkConfigEnvelope::current("catalog-9", overlay);
            let restored = decode_envelope_json(&encode_envelope_json(&envelope).unwrap()).unwrap();
            assert_eq!(restored, envelope, "{transport:?}");

            // The rule travels with a backup; the machine's proxy trust does not.
            let portable = PortableNetworkConfig::from_envelope(Network::Chipnet, &envelope);
            let exported = export_portable_json(&portable).unwrap();
            assert!(!exported.contains("trusted_socks_ports"));
            let imported = import_portable_json(&exported, Network::Chipnet).unwrap();
            assert_eq!(imported.overlay.connection_policy.transport, transport);
            assert!(imported.overlay.trusted_socks_ports.is_empty());
        }
    }

    #[test]
    fn transport_names_are_the_same_on_disk_and_across_ipc() {
        for transport in TransportPolicy::ALL {
            let stored: Option<StoredTransport> = transport.into();
            assert_eq!(
                serde_json::to_value(stored).unwrap(),
                serde_json::json!(transport.as_str())
            );
            assert_eq!(transport.as_str().parse(), Ok(transport));
        }
        assert!("on".parse::<TransportPolicy>().is_err());
    }

    #[test]
    fn schema_2_must_name_a_transport_it_knows() {
        let envelope = NetworkConfigEnvelope::current("catalog-9", rich_overlay());
        let json = encode_envelope_json(&envelope).unwrap();
        for transport in [None, Some(serde_json::json!("carrier_pigeon"))] {
            let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
            let policy = value["overlay"]["connection_policy"]
                .as_object_mut()
                .unwrap();
            match &transport {
                None => {
                    policy.remove("transport");
                }
                Some(unknown) => {
                    policy.insert("transport".into(), unknown.clone());
                }
            }
            // Refused, never read as the default: a holder's Tor-for-everything
            // must not quietly become something laxer.
            assert!(
                matches!(
                    decode_envelope_json(&serde_json::to_string(&value).unwrap()),
                    Err(NetworkConfigCodecError::Json(_))
                ),
                "{transport:?}"
            );
        }
    }

    #[test]
    fn schemas_outside_what_this_build_reads_are_refused_not_reset() {
        let envelope = NetworkConfigEnvelope::current("catalog-9", rich_overlay());
        let json = encode_envelope_json(&envelope).unwrap();
        let portable = export_portable_json(&PortableNetworkConfig::from_envelope(
            Network::Chipnet,
            &envelope,
        ))
        .unwrap();
        for found in [0, NETWORK_CONFIG_SCHEMA_VERSION + 1] {
            let relabel = |json: &str| {
                let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
                value["schema_version"] = serde_json::json!(found);
                serde_json::to_string(&value).unwrap()
            };
            assert_eq!(
                decode_envelope_json(&relabel(&json)),
                Err(NetworkConfigCodecError::UnsupportedSchema {
                    found,
                    current: NETWORK_CONFIG_SCHEMA_VERSION
                })
            );
            assert_eq!(
                import_portable_json(&relabel(&portable), Network::Chipnet),
                Err(NetworkConfigCodecError::UnsupportedSchema {
                    found,
                    current: NETWORK_CONFIG_SCHEMA_VERSION
                })
            );
            let mut in_memory = envelope.clone();
            in_memory.schema_version = found;
            assert!(matches!(
                merge_bootstrap_with_user_overlay(&SourceCatalog::default(), &in_memory),
                Err(NetworkConfigError::UnsupportedSchema { .. })
            ));
        }
    }

    #[test]
    fn choosing_sources_never_changes_how_they_are_reached() {
        let mut overlay = UserNetworkOverlay::default();
        overlay.connection_policy.transport = TransportPolicy::Direct;
        for preset in [
            ChainPolicyPreset::Privacy,
            ChainPolicyPreset::OwnInfrastructure,
            ChainPolicyPreset::Auto,
        ] {
            set_policy_preset(&mut overlay, preset).unwrap();
            assert_eq!(
                overlay.connection_policy.transport,
                TransportPolicy::Direct,
                "{preset:?}"
            );
            // A preset names sources and protocols; the transport is separate.
            assert_eq!(
                ChainPolicyPreset::describe(&overlay.connection_policy),
                preset
            );
        }
    }
}
