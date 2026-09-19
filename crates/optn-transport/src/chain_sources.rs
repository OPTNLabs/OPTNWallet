//! Typed source catalog shared across renderer adapters. Policy stays in the runtime.
use serde::{Deserialize, Serialize};

/// Private host request. Never include this in network exports or app snapshots.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum RpcCredentialRequest {
    Status {
        source: String,
    },
    Set {
        source: String,
        username: optn_app::SecretText,
        password: optn_app::SecretText,
    },
    Remove {
        source: String,
    },
}

impl RpcCredentialRequest {
    pub fn source(&self) -> &str {
        match self {
            Self::Status { source } | Self::Set { source, .. } | Self::Remove { source } => source,
        }
    }
    pub fn mutates(&self) -> bool {
        !matches!(self, Self::Status { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointView {
    /// `electrum-tls`, `p2p`, … — the same labels the source ids are built from.
    pub kind: String,
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceFailureView {
    pub protocol: String,
    pub endpoint: EndpointView,
    pub error: String,
}

/// Runtime evidence for one endpoint/protocol pair. This is a status, not
/// authorization: source selection remains enforced by the runtime policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceProtocolStatus {
    Unknown,
    Advertised,
    Verified,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceProtocolView {
    pub endpoint: EndpointView,
    pub protocol: String,
    pub status: SourceProtocolStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCapabilityView {
    pub name: String,
    pub confidence: SourceProtocolStatus,
    pub discovery: String,
}

/// A claim currently held by a registered backend. It is separate from source
/// catalog metadata and does not imply that policy or health permits use.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRouteCapabilityView {
    pub endpoint: Option<EndpointView>,
    pub protocol: String,
    pub name: String,
    pub confidence: SourceProtocolStatus,
    pub discovery: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainSourceView {
    pub id: String,
    pub label: String,
    /// `bootstrap` | `user` | `own-infrastructure`.
    pub origin: String,
    pub group: Option<String>,
    /// `enabled` | `disabled` | `banned`.
    pub disposition: String,
    pub priority: u16,
    /// Bootstrap entries are disabled, never deleted: the base catalog has to
    /// stay recoverable for a later refresh to be deterministic.
    pub can_remove: bool,
    pub endpoints: Vec<EndpointView>,
    pub capabilities: Vec<String>,
    /// Source-level catalog claims. These are not endpoint evidence.
    #[serde(default)]
    pub capability_details: Vec<SourceCapabilityView>,
    #[serde(default)]
    pub registered_capability_details: Vec<SourceRouteCapabilityView>,
    /// Per-endpoint protocol evidence. Catalog metadata can only advertise a
    /// protocol; source-level verification/rejection remains in
    /// `capability_details`. Native failures stay in `failures`, because a
    /// transport refusal is not necessarily a capability verdict.
    #[serde(default)]
    pub protocol_statuses: Vec<SourceProtocolView>,
    /// In the current selection plan: `primary`, `fallback`, or absent.
    pub role: Option<String>,
    /// Protocols this source has a live provider for right now. An empty list
    /// next to a `primary` role is the honest way to show a route that was
    /// selected but could not be opened.
    pub live_protocols: Vec<String>,
    pub failures: Vec<SourceFailureView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedTipView {
    pub height: u32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainSourcesView {
    pub network: String,
    /// `auto` | `privacy` | `own_infrastructure` | `electrum_only` |
    /// `bip37_only` | `neutrino_only` | `custom`.
    pub policy: String,
    pub selection: WireConnectionPolicy,
    pub protocols: Vec<String>,
    /// `all-enabled` | `own-infrastructure` | `explicit`.
    pub scope: String,
    pub sources: Vec<ChainSourceView>,
    /// A persisted policy that could not be resolved. No provider is registered
    /// in that state, which is why it is surfaced rather than swallowed.
    pub configuration_error: Option<String>,
    /// How many routes can answer a wallet refresh right now. Zero with sources
    /// present means the policy or the transport refused them, not that the
    /// wallet has no servers configured.
    pub wallet_routes: usize,
    /// Tip of the accepted chain this host has verified (SHV/MMR), if any.
    pub verified_tip: Option<VerifiedTipView>,
    /// What this host found when it went looking for a proxy.
    pub tor: TorProxyView,
}

/// The proxy situation, for a screen that has to explain a refusal.
///
/// "No Tor found" and "a proxy is there but I cannot tell whether it is yours"
/// call for different actions from the holder -- start Tor, or confirm the Tor
/// they already run -- and a screen that cannot tell them apart can only offer
/// the wrong one half the time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorProxyView {
    /// `verified` | `unverified` | `absent` | `not_needed`.
    pub status: String,
    /// The port a proxy answered on, whether or not it is trusted.
    pub socks_port: Option<u16>,
    /// Ports the holder has already confirmed.
    pub trusted_ports: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddSourceRequest {
    pub network: Option<String>,
    pub label: String,
    pub kind: String,
    pub host: String,
    pub port: Option<u16>,
    /// Naming a group declares this as the holder's own infrastructure, which
    /// is what `own_infrastructure` policy selects and what may be dialled
    /// directly rather than through Tor.
    pub infrastructure_group: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ChainSourceEdit {
    Policy(String),
    Selection(WireConnectionPolicy),
    Disposition { source: String, disposition: String },
    Add(AddSourceRequest),
    Remove(String),
    Retry,
    Import(String),
}

/// The serializable selection contract. Hosts convert it into the runtime policy;
/// the renderer cannot turn these choices into authorization by itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireConnectionPolicy {
    pub protocols: Vec<WireChainProtocol>,
    pub primary_scope: WireSourceScope,
    pub fallback_scope: Option<WireSourceScope>,
    pub preferred: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireChainProtocol {
    FulcrumElectrum,
    Bip37,
    Neutrino,
    BchnRpc,
    BchnZmq,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireSourceScope {
    AllEnabled,
    PublicEnabled,
    MyInfrastructure,
    Selected(Vec<String>),
}
