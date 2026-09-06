//! Provider-neutral BCH chain architecture scaffolding.
//!
//! Canonical design: https://github.com/OPTNLabs/OPTNWallet/issues/75
//!
//! Sources are what users select. Protocols/endpoints are delivery routes.
//! Capabilities describe what the wallet needs and are intentionally not owned
//! by whichever protocol happens to implement them first.

use std::collections::{BTreeMap, BTreeSet};

pub type Hash32 = [u8; 32];

// ---------------------------------------------------------------------------
// Protocols and capability discovery
// ---------------------------------------------------------------------------

/// A transport/protocol family the user may permit or exclude.
///
/// ZMQ is included for endpoint/capability modeling but is an event source,
/// not a wallet synchronization mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProtocolFamily {
    Electrum,
    Bip37,
    Neutrino,
    BchnRpc,
    BchnZmq,
}

impl ProtocolFamily {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Electrum => "Fulcrum / Electrum",
            Self::Bip37 => "BIP37",
            Self::Neutrino => "Neutrino / compact filters",
            Self::BchnRpc => "BCHN RPC",
            Self::BchnZmq => "BCHN ZMQ",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProtocolSet(BTreeSet<ProtocolFamily>);

impl ProtocolSet {
    pub fn all() -> Self {
        Self(BTreeSet::from([
            ProtocolFamily::Electrum,
            ProtocolFamily::Bip37,
            ProtocolFamily::Neutrino,
            ProtocolFamily::BchnRpc,
            ProtocolFamily::BchnZmq,
        ]))
    }

    pub fn wallet_sync() -> Self {
        Self(BTreeSet::from([
            ProtocolFamily::Electrum,
            ProtocolFamily::Bip37,
            ProtocolFamily::Neutrino,
            ProtocolFamily::BchnRpc,
        ]))
    }

    pub fn only(protocol: ProtocolFamily) -> Self {
        Self(BTreeSet::from([protocol]))
    }

    pub fn contains(&self, protocol: ProtocolFamily) -> bool {
        self.0.contains(&protocol)
    }

    pub fn insert(&mut self, protocol: ProtocolFamily) {
        self.0.insert(protocol);
    }
}

/// What OPTN needs from chain/index infrastructure.
///
/// A capability is deliberately protocol-independent. For example, `RpaIndex`
/// may be supplied by a Fulcrum Electrum extension today and by a node RPC/P2P
/// extension later without changing application state or creating a new mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    ElectrumProtocol,
    FastHistory,
    ScriptSubscriptions,
    UtxoQuery,
    TransactionQuery,
    Broadcast,
    HeaderStream,
    HeaderMerkleProof,
    TransactionMerkleProof,
    Bip37BloomFiltering,
    CompactFilters,
    RpaIndex,
    /// Wallet-scoped CashToken fields are available on discovered transactions/UTXOs.
    /// This does not imply category-wide reverse indexing.
    CashTokenData,
    /// Generic reverse lookup: which transaction spends this exact outpoint.
    OutpointSpenderLookup,
    TokenCategoryUtxos,
    TokenCategorySupply,
    TokenCategoryHolders,
    TokenCategoryTopHolders,
    TokenNftEnumeration,
    TokenDiscovery,
    BcmrAuthchainEvidence,
    BcmrAuthhead,
    BcmrRegistryCandidate,
    /// Compatibility/diagnostic umbrella only. New routing must prefer the
    /// granular token capabilities above.
    CashTokenIndex,
    /// Compatibility/diagnostic umbrella only. Local BCMR composition uses
    /// granular chain evidence plus the metadata transport boundary.
    BcmrResolver,
    GraphQueries,
    RawMempoolEvents,
    RawBlockEvents,
    DoubleSpendProofs,
    FullNodeValidation,
    RpcQueries,
    ZmqEvents,
}

impl Capability {
    pub const fn label(self) -> &'static str {
        match self {
            Self::ElectrumProtocol => "Fulcrum/Electrum",
            Self::FastHistory => "Fast history",
            Self::ScriptSubscriptions => "Script subscriptions",
            Self::UtxoQuery => "UTXO query",
            Self::TransactionQuery => "Transaction query",
            Self::Broadcast => "Broadcast",
            Self::HeaderStream => "Headers",
            Self::HeaderMerkleProof => "Header proof",
            Self::TransactionMerkleProof => "Merkle proof",
            Self::Bip37BloomFiltering => "BIP37",
            Self::CompactFilters => "Neutrino",
            Self::RpaIndex => "RPA index",
            Self::CashTokenData => "CashToken wallet data",
            Self::OutpointSpenderLookup => "Outpoint spender lookup",
            Self::TokenCategoryUtxos => "Token category UTXOs",
            Self::TokenCategorySupply => "Token category supply",
            Self::TokenCategoryHolders => "Token category holders",
            Self::TokenCategoryTopHolders => "Top token holders",
            Self::TokenNftEnumeration => "Token NFT enumeration",
            Self::TokenDiscovery => "Token discovery",
            Self::BcmrAuthchainEvidence => "BCMR authchain evidence",
            Self::BcmrAuthhead => "BCMR authhead",
            Self::BcmrRegistryCandidate => "BCMR registry candidate",
            Self::CashTokenIndex => "CashToken index",
            Self::BcmrResolver => "BCMR resolver",
            Self::GraphQueries => "Indexed graph queries",
            Self::RawMempoolEvents => "Raw mempool events",
            Self::RawBlockEvents => "Raw block events",
            Self::DoubleSpendProofs => "DSProof",
            Self::FullNodeValidation => "Full-node validation",
            Self::RpcQueries => "RPC",
            Self::ZmqEvents => "ZMQ",
        }
    }
}

/// How strong the runtime's knowledge of a capability is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityConfidence {
    Unknown,
    /// Advertised by protocol metadata, but not yet exercised by OPTN.
    Advertised,
    /// Successfully exercised/probed by OPTN.
    Verified,
    /// Advertised or expected but an active probe failed.
    Rejected,
}

/// Where a capability claim came from. UI may show this in advanced details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityDiscovery {
    /// BCH P2P `version.services`, e.g. NODE_BLOOM/BIP111 or bchd SFNodeCF.
    P2pServiceBit {
        bit: u64,
        name: String,
    },
    ElectrumServerVersion,
    ElectrumServerFeatures,
    ElectrumPeerDiscovery,
    ExplicitConfiguration,
    BootstrapMetadata,
    ActiveProbe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityClaim {
    pub confidence: CapabilityConfidence,
    pub discovery: CapabilityDiscovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CapabilitySet(BTreeMap<Capability, CapabilityClaim>);

impl CapabilitySet {
    pub fn record(
        &mut self,
        capability: Capability,
        confidence: CapabilityConfidence,
        discovery: CapabilityDiscovery,
    ) {
        self.0.insert(
            capability,
            CapabilityClaim {
                confidence,
                discovery,
            },
        );
    }

    pub fn claim(&self, capability: Capability) -> Option<&CapabilityClaim> {
        self.0.get(&capability)
    }

    pub fn iter(&self) -> impl Iterator<Item = (Capability, &CapabilityClaim)> {
        self.0
            .iter()
            .map(|(capability, claim)| (*capability, claim))
    }

    pub fn is_usable(&self, capability: Capability) -> bool {
        self.claim(capability).is_some_and(|claim| {
            matches!(
                claim.confidence,
                CapabilityConfidence::Advertised | CapabilityConfidence::Verified
            )
        })
    }

    /// Protocol support is a route-level fact used by the current catalog
    /// scaffold. Feature capabilities such as RPA/BCMR/token indexing are not
    /// mapped here because they may be offered by more than one protocol.
    pub fn protocol_supported(&self, protocol: ProtocolFamily) -> bool {
        match protocol {
            ProtocolFamily::Electrum => self.is_usable(Capability::ElectrumProtocol),
            ProtocolFamily::Bip37 => self.is_usable(Capability::Bip37BloomFiltering),
            ProtocolFamily::Neutrino => self.is_usable(Capability::CompactFilters),
            ProtocolFamily::BchnRpc => self.is_usable(Capability::RpcQueries),
            ProtocolFamily::BchnZmq => self.is_usable(Capability::ZmqEvents),
        }
    }
}

// ---------------------------------------------------------------------------
// Source catalog and lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceId(String);

impl SourceId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for SourceId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    BchP2p,
    ElectrumTls,
    ElectrumTcp,
    BchnRpc,
    BchnZmq,
    ExplorerHttp,
    ExplorerHttps,
}

impl EndpointKind {
    pub const fn protocol_family(self) -> Option<ProtocolFamily> {
        match self {
            Self::BchP2p => None,
            Self::ElectrumTls | Self::ElectrumTcp => Some(ProtocolFamily::Electrum),
            Self::BchnRpc => Some(ProtocolFamily::BchnRpc),
            Self::BchnZmq => Some(ProtocolFamily::BchnZmq),
            Self::ExplorerHttp | Self::ExplorerHttps => None,
        }
    }

    /// Whether this configured endpoint can potentially carry a protocol.
    ///
    /// This is intentionally weaker than a capability claim: a BCH P2P socket
    /// is eligible to be probed for BIP37 or compact filters, but only a
    /// successful advertisement/probe makes either capability usable.
    pub const fn can_probe_protocol(self, protocol: ProtocolFamily) -> bool {
        match self {
            Self::BchP2p => matches!(protocol, ProtocolFamily::Bip37 | ProtocolFamily::Neutrino),
            Self::ElectrumTls | Self::ElectrumTcp => matches!(protocol, ProtocolFamily::Electrum),
            Self::BchnRpc => matches!(protocol, ProtocolFamily::BchnRpc),
            Self::BchnZmq => matches!(protocol, ProtocolFamily::BchnZmq),
            Self::ExplorerHttp | Self::ExplorerHttps => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: EndpointKind,
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BootstrapProject {
    Bchn,
    FloweeTheHub,
    Bchd,
    Knuth,
    ElectronCash,
    FulcrumPeerNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceOrigin {
    /// Shipped/discovered from an upstream-maintained bootstrap feed.
    /// These entries can be disabled/banned but not deleted from the base catalog.
    Bootstrap {
        project: BootstrapProject,
        provenance: String,
    },
    /// Public/custom endpoint manually entered by the user.
    UserAdded,
    /// Endpoint belonging to a user-declared infrastructure group.
    UserInfrastructure { group: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceDisposition {
    Enabled,
    Disabled,
    Banned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainSource {
    pub id: SourceId,
    /// User/bootstrap supplied label. Names such as "Home Server" are examples,
    /// never generic source names imposed by the runtime.
    pub label: String,
    pub origin: SourceOrigin,
    pub endpoints: Vec<Endpoint>,
    /// Combined catalog/UI summary of capability claims known for this source.
    /// Execution must still consult the selected provider/endpoint's own
    /// capability set; this field does not permanently assign a capability to a
    /// protocol or endpoint.
    pub capabilities: CapabilitySet,
    pub disposition: SourceDisposition,
    /// Lower values are tried first after explicit user preference.
    pub priority: u16,
}

impl ChainSource {
    pub fn can_remove(&self) -> bool {
        !matches!(self.origin, SourceOrigin::Bootstrap { .. })
    }

    pub fn is_enabled(&self) -> bool {
        self.disposition == SourceDisposition::Enabled
    }

    pub fn is_user_infrastructure(&self) -> bool {
        matches!(self.origin, SourceOrigin::UserInfrastructure { .. })
    }

    pub fn is_public(&self) -> bool {
        !self.is_user_infrastructure()
    }

    /// Candidate eligibility, not proof that the source supports the protocol.
    ///
    /// A restored/custom endpoint intentionally has no persisted capability
    /// claims until it is re-probed. It must still reach the probe stage, so an
    /// explicit compatible endpoint is enough to keep the source in the
    /// candidate pool. Execution later requires the provider's advertised or
    /// verified operation capability.
    pub fn supports_any(&self, protocols: &ProtocolSet) -> bool {
        [
            ProtocolFamily::Electrum,
            ProtocolFamily::Bip37,
            ProtocolFamily::Neutrino,
            ProtocolFamily::BchnRpc,
            ProtocolFamily::BchnZmq,
        ]
        .into_iter()
        .any(|protocol| {
            protocols.contains(protocol)
                && (self.capabilities.protocol_supported(protocol)
                    || self
                        .endpoints
                        .iter()
                        .any(|endpoint| endpoint.kind.can_probe_protocol(protocol)))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    DuplicateSource(SourceId),
    SourceNotFound(SourceId),
    BootstrapNotRemovable(SourceId),
}

#[derive(Debug, Clone, Default)]
pub struct SourceCatalog {
    sources: BTreeMap<SourceId, ChainSource>,
}

impl SourceCatalog {
    pub fn insert(&mut self, source: ChainSource) -> Result<(), CatalogError> {
        if self.sources.contains_key(&source.id) {
            return Err(CatalogError::DuplicateSource(source.id));
        }
        self.sources.insert(source.id.clone(), source);
        Ok(())
    }

    pub fn get(&self, id: &SourceId) -> Option<&ChainSource> {
        self.sources.get(id)
    }

    pub fn get_mut(&mut self, id: &SourceId) -> Option<&mut ChainSource> {
        self.sources.get_mut(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &ChainSource> {
        self.sources.values()
    }

    pub fn remove(&mut self, id: &SourceId) -> Result<ChainSource, CatalogError> {
        let source = self
            .sources
            .get(id)
            .ok_or_else(|| CatalogError::SourceNotFound(id.clone()))?;
        if !source.can_remove() {
            return Err(CatalogError::BootstrapNotRemovable(id.clone()));
        }
        Ok(self.sources.remove(id).expect("source checked above"))
    }

    pub fn set_disposition(
        &mut self,
        id: &SourceId,
        disposition: SourceDisposition,
    ) -> Result<(), CatalogError> {
        let source = self
            .sources
            .get_mut(id)
            .ok_or_else(|| CatalogError::SourceNotFound(id.clone()))?;
        source.disposition = disposition;
        Ok(())
    }

    pub fn reset_bootstrap_dispositions(&mut self) {
        for source in self.sources.values_mut() {
            if matches!(source.origin, SourceOrigin::Bootstrap { .. }) {
                source.disposition = SourceDisposition::Enabled;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Bootstrap feed provenance
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapFeedKind {
    NodeDnsOrDefaultPeerDiscovery,
    ElectrumServerCatalog,
    ElectrumPeerDiscovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootstrapFeed {
    pub project: BootstrapProject,
    pub kind: BootstrapFeedKind,
    pub reference: &'static str,
}

pub const DEFAULT_BOOTSTRAP_FEEDS: &[BootstrapFeed] = &[
    BootstrapFeed {
        project: BootstrapProject::Bchn,
        kind: BootstrapFeedKind::NodeDnsOrDefaultPeerDiscovery,
        reference: "bitcoin-cash-node/bitcoin-cash-node: src/chainparams.cpp",
    },
    BootstrapFeed {
        project: BootstrapProject::FloweeTheHub,
        kind: BootstrapFeedKind::NodeDnsOrDefaultPeerDiscovery,
        reference: "FloweeTheHub/thehub: upstream node peer discovery",
    },
    BootstrapFeed {
        project: BootstrapProject::Bchd,
        kind: BootstrapFeedKind::NodeDnsOrDefaultPeerDiscovery,
        reference: "gcash/bchd: chaincfg/params.go",
    },
    BootstrapFeed {
        project: BootstrapProject::Knuth,
        kind: BootstrapFeedKind::NodeDnsOrDefaultPeerDiscovery,
        reference: "k-nuth/kth: upstream node peer discovery",
    },
    BootstrapFeed {
        project: BootstrapProject::ElectronCash,
        kind: BootstrapFeedKind::ElectrumServerCatalog,
        reference: "Electron-Cash/Electron-Cash: electroncash/servers.json",
    },
    BootstrapFeed {
        project: BootstrapProject::FulcrumPeerNetwork,
        kind: BootstrapFeedKind::ElectrumPeerDiscovery,
        reference: "Electrum server.peers.subscribe / Fulcrum peering",
    },
];

// ---------------------------------------------------------------------------
// Connection policy: protocol filter x primary scope x optional fallback scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceScope {
    AllEnabled,
    PublicEnabled,
    UserInfrastructure,
    /// One entry means exact/manual; multiple entries mean a selected failover pool.
    Explicit(BTreeSet<SourceId>),
}

impl SourceScope {
    fn contains(&self, source: &ChainSource) -> bool {
        match self {
            Self::AllEnabled => true,
            Self::PublicEnabled => source.is_public(),
            Self::UserInfrastructure => source.is_user_infrastructure(),
            Self::Explicit(ids) => ids.contains(&source.id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionPolicy {
    pub protocols: ProtocolSet,
    pub primary_scope: SourceScope,
    pub fallback_scope: Option<SourceScope>,
    pub preferred: Vec<SourceId>,
}

impl ConnectionPolicy {
    pub fn auto() -> Self {
        Self {
            protocols: ProtocolSet::wallet_sync(),
            primary_scope: SourceScope::AllEnabled,
            fallback_scope: None,
            preferred: Vec::new(),
        }
    }

    pub fn own_infrastructure() -> Self {
        Self {
            protocols: ProtocolSet::wallet_sync(),
            primary_scope: SourceScope::UserInfrastructure,
            fallback_scope: None,
            preferred: Vec::new(),
        }
    }

    pub fn exact(source: SourceId, protocol: ProtocolFamily) -> Self {
        Self {
            protocols: ProtocolSet::only(protocol),
            primary_scope: SourceScope::Explicit(BTreeSet::from([source])),
            fallback_scope: None,
            preferred: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SelectionPlan {
    pub primary: Vec<SourceId>,
    pub fallback: Vec<SourceId>,
}

pub fn build_selection_plan(catalog: &SourceCatalog, policy: &ConnectionPolicy) -> SelectionPlan {
    fn ranked(
        catalog: &SourceCatalog,
        scope: &SourceScope,
        protocols: &ProtocolSet,
        preferred: &[SourceId],
        exclude: &BTreeSet<SourceId>,
    ) -> Vec<SourceId> {
        let mut sources = catalog
            .iter()
            .filter(|source| source.is_enabled())
            .filter(|source| scope.contains(source))
            .filter(|source| source.supports_any(protocols))
            .filter(|source| !exclude.contains(&source.id))
            .collect::<Vec<_>>();

        sources.sort_by_key(|source| {
            let preference = preferred
                .iter()
                .position(|id| id == &source.id)
                .unwrap_or(usize::MAX);
            (preference, source.priority, source.id.clone())
        });
        sources
            .into_iter()
            .map(|source| source.id.clone())
            .collect()
    }

    let primary = ranked(
        catalog,
        &policy.primary_scope,
        &policy.protocols,
        &policy.preferred,
        &BTreeSet::new(),
    );
    let primary_set = primary.iter().cloned().collect::<BTreeSet<_>>();
    let fallback = policy
        .fallback_scope
        .as_ref()
        .map(|scope| {
            ranked(
                catalog,
                scope,
                &policy.protocols,
                &policy.preferred,
                &primary_set,
            )
        })
        .unwrap_or_default();

    SelectionPlan { primary, fallback }
}

// ---------------------------------------------------------------------------
// Provider/event contracts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHealth {
    Unknown,
    Healthy,
    Degraded,
    Offline,
}

pub trait ChainProvider: Send + Sync {
    fn source_id(&self) -> &SourceId;
    fn protocol(&self) -> ProtocolFamily;
    fn endpoint(&self) -> Option<&Endpoint> {
        None
    }
    fn capabilities(&self) -> &CapabilitySet;
    fn health(&self) -> ProviderHealth;
}

pub trait ChainEventSource: Send + Sync {
    fn source_id(&self) -> &SourceId;
    fn endpoint(&self) -> Option<&Endpoint> {
        None
    }
    fn capabilities(&self) -> &CapabilitySet;
    fn health(&self) -> ProviderHealth;
}

pub trait CapabilityProbe: Send + Sync {
    fn advertised(&self) -> CapabilitySet;
}

// ---------------------------------------------------------------------------
// Evidence and synchronization state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Evidence {
    ServerAssertion,
    MempoolObservation,
    HeaderLinked {
        block_hash: Hash32,
        height: u32,
    },
    HeaderPowVerified {
        block_hash: Hash32,
        height: u32,
    },
    HeaderMmrProven {
        block_hash: Hash32,
        height: u32,
    },
    MerkleTransactionIncluded {
        txid: Hash32,
        block_hash: Hash32,
        height: u32,
    },
    FullNodeValidated {
        source: SourceId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainObservation<T> {
    pub value: T,
    pub source: SourceId,
    pub chain_tip: Option<(u32, Hash32)>,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationState {
    Unknown,
    Discovered,
    PartiallyVerified,
    Verified,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletSyncState {
    pub primary_source: Option<SourceId>,
    pub history_fresh: bool,
    pub utxos_fresh: bool,
    pub chain_tip: Option<(u32, Hash32)>,
    pub verification: VerificationState,
    pub degraded_reason: Option<String>,
}

impl Default for WalletSyncState {
    fn default() -> Self {
        Self {
            primary_source: None,
            history_fresh: false,
            utxos_fresh: false,
            chain_tip: None,
            verification: VerificationState::Unknown,
            degraded_reason: None,
        }
    }
}

// ---------------------------------------------------------------------------
// SHV/MMR header verification scaffold
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderVerificationMode {
    FullHeaders,
    ShvMmr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointProvenance {
    SelfDerived,
    ShippedReviewed,
    SampledIndependentSources,
    UserProvided,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderAccumulatorState {
    pub height: u32,
    pub peaks: Vec<Hash32>,
    pub commitment: Hash32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderCheckpoint {
    pub height: u32,
    pub commitment: Hash32,
    pub provenance: CheckpointProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockHeaderBytes(pub [u8; 80]);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalHeaderProof {
    pub height: u32,
    pub header: BlockHeaderBytes,
    pub proof: Vec<Hash32>,
    pub target: Hash32,
}

pub trait HeaderVerifier: Send + Sync {
    type Error;

    fn mode(&self) -> HeaderVerificationMode;
    fn extend(&mut self, headers: &[BlockHeaderBytes]) -> Result<(), Self::Error>;
    fn verify_historical(&self, proof: &HistoricalHeaderProof) -> Result<(), Self::Error>;
    fn checkpoint(&self) -> HeaderCheckpoint;
}

// ---------------------------------------------------------------------------
// Explorer routing remains separate from chain truth
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExplorerPolicy {
    PreferUserOwned,
    PublicAllowed,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerEndpoint {
    pub label: String,
    pub base_url: String,
    pub user_owned: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(protocols: &[ProtocolFamily]) -> CapabilitySet {
        let mut set = CapabilitySet::default();
        for protocol in protocols {
            let capability = match protocol {
                ProtocolFamily::Electrum => Capability::ElectrumProtocol,
                ProtocolFamily::Bip37 => Capability::Bip37BloomFiltering,
                ProtocolFamily::Neutrino => Capability::CompactFilters,
                ProtocolFamily::BchnRpc => Capability::RpcQueries,
                ProtocolFamily::BchnZmq => Capability::ZmqEvents,
            };
            set.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        set
    }

    fn source(
        id: &str,
        origin: SourceOrigin,
        protocols: &[ProtocolFamily],
        priority: u16,
    ) -> ChainSource {
        ChainSource {
            id: SourceId::from(id),
            label: id.to_owned(),
            origin,
            endpoints: Vec::new(),
            capabilities: caps(protocols),
            disposition: SourceDisposition::Enabled,
            priority,
        }
    }

    #[test]
    fn bootstrap_can_be_banned_but_not_removed() {
        let id = SourceId::from("bootstrap-a");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(source(
                id.as_str(),
                SourceOrigin::Bootstrap {
                    project: BootstrapProject::Bchn,
                    provenance: "dns seed".into(),
                },
                &[ProtocolFamily::Bip37],
                10,
            ))
            .unwrap();

        catalog
            .set_disposition(&id, SourceDisposition::Banned)
            .unwrap();
        assert_eq!(
            catalog.get(&id).unwrap().disposition,
            SourceDisposition::Banned
        );
        assert_eq!(
            catalog.remove(&id),
            Err(CatalogError::BootstrapNotRemovable(id.clone()))
        );
        catalog.reset_bootstrap_dispositions();
        assert_eq!(
            catalog.get(&id).unwrap().disposition,
            SourceDisposition::Enabled
        );
    }

    #[test]
    fn user_added_and_user_infrastructure_sources_are_removable() {
        let mut catalog = SourceCatalog::default();
        let custom = SourceId::from("custom");
        let mine = SourceId::from("mine");
        catalog
            .insert(source(
                custom.as_str(),
                SourceOrigin::UserAdded,
                &[ProtocolFamily::Electrum],
                10,
            ))
            .unwrap();
        catalog
            .insert(source(
                mine.as_str(),
                SourceOrigin::UserInfrastructure {
                    group: "home".into(),
                },
                &[ProtocolFamily::Bip37],
                10,
            ))
            .unwrap();

        assert_eq!(catalog.remove(&custom).unwrap().id, custom);
        assert_eq!(catalog.remove(&mine).unwrap().id, mine);
    }

    #[test]
    fn one_explicit_source_is_manual_without_inventing_manual_mode() {
        let id = SourceId::from("one");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(source(
                id.as_str(),
                SourceOrigin::UserAdded,
                &[ProtocolFamily::Bip37],
                10,
            ))
            .unwrap();

        let plan = build_selection_plan(
            &catalog,
            &ConnectionPolicy::exact(id.clone(), ProtocolFamily::Bip37),
        );
        assert_eq!(plan.primary, vec![id]);
        assert!(plan.fallback.is_empty());
    }

    #[test]
    fn explicit_multi_source_pool_auto_fails_over_inside_the_pool() {
        let a = SourceId::from("a");
        let b = SourceId::from("b");
        let mut catalog = SourceCatalog::default();
        for (id, priority) in [(&a, 20), (&b, 10)] {
            catalog
                .insert(source(
                    id.as_str(),
                    SourceOrigin::UserAdded,
                    &[ProtocolFamily::Bip37],
                    priority,
                ))
                .unwrap();
        }

        let policy = ConnectionPolicy {
            protocols: ProtocolSet::only(ProtocolFamily::Bip37),
            primary_scope: SourceScope::Explicit(BTreeSet::from([a.clone(), b.clone()])),
            fallback_scope: None,
            preferred: Vec::new(),
        };
        let plan = build_selection_plan(&catalog, &policy);
        assert_eq!(plan.primary, vec![b, a]);
        assert!(plan.fallback.is_empty());
    }

    #[test]
    fn own_infrastructure_can_be_multi_protocol_and_fail_closed() {
        let mine_electrum = SourceId::from("mine-electrum");
        let mine_neutrino = SourceId::from("mine-neutrino");
        let public = SourceId::from("public");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(source(
                mine_electrum.as_str(),
                SourceOrigin::UserInfrastructure {
                    group: "home".into(),
                },
                &[ProtocolFamily::Electrum],
                10,
            ))
            .unwrap();
        catalog
            .insert(source(
                mine_neutrino.as_str(),
                SourceOrigin::UserInfrastructure {
                    group: "vps".into(),
                },
                &[ProtocolFamily::Neutrino],
                20,
            ))
            .unwrap();
        catalog
            .insert(source(
                public.as_str(),
                SourceOrigin::UserAdded,
                &[ProtocolFamily::Electrum],
                1,
            ))
            .unwrap();

        let plan = build_selection_plan(&catalog, &ConnectionPolicy::own_infrastructure());
        assert_eq!(plan.primary, vec![mine_electrum, mine_neutrino]);
        assert!(!plan.primary.contains(&public));
        assert!(plan.fallback.is_empty());
    }

    #[test]
    fn selected_sources_can_fall_back_to_a_broader_allowed_pool() {
        let preferred = SourceId::from("preferred");
        let fallback = SourceId::from("fallback");
        let mut catalog = SourceCatalog::default();
        for id in [&preferred, &fallback] {
            catalog
                .insert(source(
                    id.as_str(),
                    SourceOrigin::UserAdded,
                    &[ProtocolFamily::Electrum],
                    10,
                ))
                .unwrap();
        }

        let policy = ConnectionPolicy {
            protocols: ProtocolSet::only(ProtocolFamily::Electrum),
            primary_scope: SourceScope::Explicit(BTreeSet::from([preferred.clone()])),
            fallback_scope: Some(SourceScope::PublicEnabled),
            preferred: vec![preferred.clone()],
        };
        let plan = build_selection_plan(&catalog, &policy);
        assert_eq!(plan.primary, vec![preferred]);
        assert_eq!(plan.fallback, vec![fallback]);
    }

    #[test]
    fn advertised_capability_can_be_promoted_to_verified() {
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::Bip37BloomFiltering,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::P2pServiceBit {
                bit: 1 << 2,
                name: "NODE_BLOOM".into(),
            },
        );
        assert!(capabilities.protocol_supported(ProtocolFamily::Bip37));

        capabilities.record(
            Capability::Bip37BloomFiltering,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        assert_eq!(
            capabilities
                .claim(Capability::Bip37BloomFiltering)
                .unwrap()
                .confidence,
            CapabilityConfidence::Verified
        );
    }

    #[test]
    fn indexed_capabilities_are_not_owned_by_one_protocol() {
        let mut electrum = CapabilitySet::default();
        electrum.record(
            Capability::RpaIndex,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ElectrumServerFeatures,
        );
        let mut rpc = CapabilitySet::default();
        rpc.record(
            Capability::RpaIndex,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ExplicitConfiguration,
        );

        assert!(electrum.is_usable(Capability::RpaIndex));
        assert!(rpc.is_usable(Capability::RpaIndex));
        assert_eq!(Capability::RpaIndex.label(), "RPA index");
        assert_eq!(
            Capability::OutpointSpenderLookup.label(),
            "Outpoint spender lookup"
        );
        assert_eq!(
            Capability::TokenCategoryUtxos.label(),
            "Token category UTXOs"
        );
        assert_eq!(Capability::CashTokenIndex.label(), "CashToken index");
        assert_eq!(Capability::BcmrResolver.label(), "BCMR resolver");
        assert_eq!(Capability::GraphQueries.label(), "Indexed graph queries");
    }

    #[test]
    fn endpoint_kind_only_describes_route_not_feature_ownership() {
        assert_eq!(
            EndpointKind::ElectrumTls.protocol_family(),
            Some(ProtocolFamily::Electrum)
        );
        assert_eq!(
            EndpointKind::BchnRpc.protocol_family(),
            Some(ProtocolFamily::BchnRpc)
        );
        assert_eq!(EndpointKind::BchP2p.protocol_family(), None);
        assert_eq!(EndpointKind::ExplorerHttps.protocol_family(), None);
    }

    #[test]
    fn restored_endpoint_is_candidate_before_capability_reprobe() {
        let id = SourceId::from("restored");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "My node".into(),
                origin: SourceOrigin::UserInfrastructure {
                    group: "lab".into(),
                },
                endpoints: vec![Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "node.example".into(),
                    port: Some(8333),
                }],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();

        let policy = ConnectionPolicy {
            protocols: ProtocolSet::only(ProtocolFamily::Bip37),
            primary_scope: SourceScope::Explicit(BTreeSet::from([id.clone()])),
            fallback_scope: None,
            preferred: Vec::new(),
        };
        let plan = build_selection_plan(&catalog, &policy);
        assert_eq!(plan.primary, vec![id]);
    }

    #[test]
    fn configured_endpoint_does_not_fake_verified_capability() {
        let source = ChainSource {
            id: SourceId::from("probe-me"),
            label: "Probe me".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "fulcrum.example".into(),
                port: Some(50002),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        assert!(source.supports_any(&ProtocolSet::only(ProtocolFamily::Electrum)));
        assert!(!source.capabilities.is_usable(Capability::RpaIndex));
        assert!(!source.capabilities.is_usable(Capability::ElectrumProtocol));
    }
}
