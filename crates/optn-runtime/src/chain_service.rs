//! Runtime-owned BCH provider orchestration for issue #75.
//!
//! Concrete network adapters implement [`ChainBackend`]. The user selects
//! sources/protocol policy; the runtime resolves the capability needed for each
//! operation to an eligible provider route. A backend never receives mutable
//! wallet state.

use crate::chain::{
    build_selection_plan, Capability, CapabilityConfidence, CapabilitySet, ChainObservation,
    ConnectionPolicy, Endpoint, Evidence, Hash32, ProtocolFamily, ProviderHealth, SourceCatalog,
    SourceId,
};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

pub type ChainFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ChainBackendError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainOperation {
    WalletRefresh,
    TransactionLookup,
    Broadcast,
    HeaderSync,
    HistoricalHeaderProof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainRequest {
    WalletRefresh {
        interests: Vec<Vec<u8>>,
        from_height: Option<u32>,
    },
    TransactionLookup { txid: Hash32 },
    Broadcast { raw_tx: Vec<u8>, txid: Hash32 },
    HeaderSync { start_height: u32, count: u32 },
    HistoricalHeaderProof {
        height: u32,
        /// The checkpoint/root height the proof must target.
        checkpoint_height: u32,
    },
}

impl ChainRequest {
    pub const fn operation(&self) -> ChainOperation {
        match self {
            Self::WalletRefresh { .. } => ChainOperation::WalletRefresh,
            Self::TransactionLookup { .. } => ChainOperation::TransactionLookup,
            Self::Broadcast { .. } => ChainOperation::Broadcast,
            Self::HeaderSync { .. } => ChainOperation::HeaderSync,
            Self::HistoricalHeaderProof { .. } => ChainOperation::HistoricalHeaderProof,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainTip {
    pub height: u32,
    pub hash: Hash32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedTransaction {
    pub txid: Hash32,
    pub raw: Vec<u8>,
    pub block_height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainPayload {
    WalletRefresh {
        transactions: Vec<ObservedTransaction>,
        tip: Option<ChainTip>,
    },
    Transaction(ObservedTransaction),
    BroadcastObserved { txid: Hash32 },
    Headers {
        start_height: u32,
        headers: Vec<[u8; 80]>,
    },
    HistoricalHeaderProof {
        height: u32,
        checkpoint_height: u32,
        header: [u8; 80],
        siblings: Vec<Hash32>,
        /// Internal digest-byte order used by the MMR verifier.
        root: Hash32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendObservation {
    pub payload: ChainPayload,
    pub evidence: Evidence,
    pub chain_tip: Option<(u32, Hash32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainBackendError {
    Unsupported,
    Offline,
    Timeout,
    Protocol(String),
    InvalidResponse(String),
    Rejected(String),
}

/// One concrete way an allowed source can supply a capability.
///
/// This is the future-proof seam: `RpaIndex`, `CashTokenIndex`, `BcmrResolver`
/// or `GraphQueries` can gain an Electrum, RPC, P2P, or other adapter without
/// changing the source-selection UI or authoritative wallet state model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityRoute {
    pub source: SourceId,
    pub protocol: ProtocolFamily,
    pub endpoint: Option<Endpoint>,
    pub capability: Capability,
    pub confidence: CapabilityConfidence,
    pub health: ProviderHealth,
}

pub trait ChainBackend: Send + Sync {
    fn source_id(&self) -> &SourceId;
    fn protocol(&self) -> ProtocolFamily;

    /// The concrete endpoint used by this adapter when one exists. Kept
    /// optional so existing adapters remain source/protocol compatible while
    /// they migrate to endpoint-aware diagnostics.
    fn endpoint(&self) -> Option<&Endpoint> {
        None
    }

    fn capabilities(&self) -> &CapabilitySet;
    fn health(&self) -> ProviderHealth;

    /// Request-shape support in addition to the advertised capability. This can
    /// reject a specific operation while the same provider still advertises
    /// other useful capabilities.
    fn supports(&self, operation: ChainOperation) -> bool;
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptFailure {
    pub source: SourceId,
    pub protocol: ProtocolFamily,
    pub error: ChainBackendError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainServiceError {
    NoEligibleProvider,
    Exhausted { attempts: Vec<AttemptFailure> },
}

#[derive(Default)]
pub struct ProviderRegistry {
    providers: Vec<Arc<dyn ChainBackend>>,
}

impl ProviderRegistry {
    pub fn register(&mut self, provider: Arc<dyn ChainBackend>) {
        self.providers.push(provider);
    }

    pub fn providers_for<'a>(
        &'a self,
        source: &'a SourceId,
        policy: &'a ConnectionPolicy,
        operation: ChainOperation,
    ) -> Vec<&'a Arc<dyn ChainBackend>> {
        let capability = operation_capability(operation);
        let mut providers = self
            .providers
            .iter()
            .filter(|provider| provider.source_id() == source)
            .filter(|provider| policy.protocols.contains(provider.protocol()))
            .filter(|provider| provider.capabilities().is_usable(capability))
            .filter(|provider| provider.supports(operation))
            .filter(|provider| !matches!(provider.health(), ProviderHealth::Offline))
            .collect::<Vec<_>>();
        providers.sort_by_key(|provider| operation_protocol_rank(operation, provider.protocol()));
        providers
    }

    pub fn routes_for_capability(
        &self,
        source: &SourceId,
        policy: &ConnectionPolicy,
        capability: Capability,
    ) -> Vec<CapabilityRoute> {
        let mut routes = self
            .providers
            .iter()
            .filter(|provider| provider.source_id() == source)
            .filter(|provider| policy.protocols.contains(provider.protocol()))
            .filter(|provider| !matches!(provider.health(), ProviderHealth::Offline))
            .filter_map(|provider| {
                let claim = provider.capabilities().claim(capability)?;
                if !matches!(
                    claim.confidence,
                    CapabilityConfidence::Advertised | CapabilityConfidence::Verified
                ) {
                    return None;
                }
                Some(CapabilityRoute {
                    source: source.clone(),
                    protocol: provider.protocol(),
                    endpoint: provider.endpoint().cloned(),
                    capability,
                    confidence: claim.confidence,
                    health: provider.health(),
                })
            })
            .collect::<Vec<_>>();

        // Prefer actually exercised routes over merely advertised ones, then a
        // healthy route over degraded/unknown. Protocol itself does not own or
        // automatically outrank another protocol for a generic capability.
        routes.sort_by_key(|route| {
            (
                confidence_rank(route.confidence),
                health_rank(route.health),
                route.protocol,
            )
        });
        routes
    }
}

pub struct ChainService {
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    registry: ProviderRegistry,
    health_overrides: BTreeMap<(SourceId, ProtocolFamily), ProviderHealth>,
}

impl ChainService {
    pub fn new(catalog: SourceCatalog, policy: ConnectionPolicy) -> Self {
        Self {
            catalog,
            policy,
            registry: ProviderRegistry::default(),
            health_overrides: BTreeMap::new(),
        }
    }

    pub fn catalog(&self) -> &SourceCatalog {
        &self.catalog
    }

    pub fn policy(&self) -> &ConnectionPolicy {
        &self.policy
    }

    pub fn set_policy(&mut self, policy: ConnectionPolicy) {
        self.policy = policy;
    }

    pub fn register(&mut self, provider: Arc<dyn ChainBackend>) {
        self.registry.register(provider);
    }

    pub fn clear_health_override(&mut self, source: &SourceId, protocol: ProtocolFamily) {
        self.health_overrides.remove(&(source.clone(), protocol));
    }

    /// Return all currently eligible routes for a capability in exactly the
    /// source order selected by the existing UI/policy model.
    ///
    /// This is intentionally usable for capabilities that do not yet have a
    /// first-class `ChainRequest` (e.g. BCMR/token/graph indexing). Adding a
    /// provider implementation later does not require a new source mode.
    pub fn routes_for_capability(&self, capability: Capability) -> Vec<CapabilityRoute> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        plan.primary
            .iter()
            .chain(plan.fallback.iter())
            .flat_map(|source| {
                self.registry
                    .routes_for_capability(source, &self.policy, capability)
            })
            .filter(|route| {
                !matches!(
                    self.health_overrides
                        .get(&(route.source.clone(), route.protocol)),
                    Some(ProviderHealth::Offline | ProviderHealth::Degraded)
                )
            })
            .collect()
    }

    pub async fn execute(
        &mut self,
        request: &ChainRequest,
    ) -> Result<ChainObservation<ChainPayload>, ChainServiceError> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        let candidates = plan
            .primary
            .iter()
            .chain(plan.fallback.iter())
            .cloned()
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Err(ChainServiceError::NoEligibleProvider);
        }

        let mut attempts = Vec::new();
        for source in candidates {
            let providers = self
                .registry
                .providers_for(&source, &self.policy, request.operation());
            for provider in providers {
                let protocol = provider.protocol();
                let key = (source.clone(), protocol);
                if matches!(
                    self.health_overrides.get(&key),
                    Some(ProviderHealth::Offline | ProviderHealth::Degraded)
                ) {
                    continue;
                }
                match provider.execute(request).await {
                    Ok(observation) => {
                        self.health_overrides.insert(key, ProviderHealth::Healthy);
                        return Ok(ChainObservation {
                            value: observation.payload,
                            source: source.clone(),
                            chain_tip: observation.chain_tip,
                            evidence: observation.evidence,
                        });
                    }
                    Err(error) => {
                        let health = match &error {
                            ChainBackendError::Offline | ChainBackendError::Timeout => {
                                ProviderHealth::Offline
                            }
                            _ => ProviderHealth::Degraded,
                        };
                        self.health_overrides.insert(key, health);
                        attempts.push(AttemptFailure {
                            source: source.clone(),
                            protocol,
                            error,
                        });
                    }
                }
            }
        }

        if attempts.is_empty() {
            Err(ChainServiceError::NoEligibleProvider)
        } else {
            Err(ChainServiceError::Exhausted { attempts })
        }
    }
}

const fn confidence_rank(confidence: CapabilityConfidence) -> u8 {
    match confidence {
        CapabilityConfidence::Verified => 0,
        CapabilityConfidence::Advertised => 1,
        CapabilityConfidence::Unknown => 2,
        CapabilityConfidence::Rejected => 3,
    }
}

const fn health_rank(health: ProviderHealth) -> u8 {
    match health {
        ProviderHealth::Healthy => 0,
        ProviderHealth::Unknown => 1,
        ProviderHealth::Degraded => 2,
        ProviderHealth::Offline => 3,
    }
}

fn operation_protocol_rank(operation: ChainOperation, protocol: ProtocolFamily) -> u8 {
    match operation {
        ChainOperation::WalletRefresh => match protocol {
            ProtocolFamily::Electrum => 0,
            ProtocolFamily::BchnRpc => 1,
            ProtocolFamily::Neutrino => 2,
            ProtocolFamily::Bip37 => 3,
            ProtocolFamily::BchnZmq => 9,
        },
        ChainOperation::TransactionLookup | ChainOperation::Broadcast => match protocol {
            ProtocolFamily::BchnRpc => 0,
            ProtocolFamily::Electrum => 1,
            ProtocolFamily::Bip37 => 2,
            ProtocolFamily::Neutrino => 3,
            ProtocolFamily::BchnZmq => 9,
        },
        ChainOperation::HeaderSync | ChainOperation::HistoricalHeaderProof => match protocol {
            ProtocolFamily::BchnRpc => 0,
            ProtocolFamily::Neutrino => 1,
            ProtocolFamily::Bip37 => 2,
            ProtocolFamily::Electrum => 3,
            ProtocolFamily::BchnZmq => 9,
        },
    }
}

pub const fn operation_capability(operation: ChainOperation) -> Capability {
    match operation {
        ChainOperation::WalletRefresh => Capability::UtxoQuery,
        ChainOperation::TransactionLookup => Capability::TransactionQuery,
        ChainOperation::Broadcast => Capability::Broadcast,
        ChainOperation::HeaderSync => Capability::HeaderStream,
        ChainOperation::HistoricalHeaderProof => Capability::HeaderMerkleProof,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{
        CapabilityDiscovery, ChainSource, EndpointKind, SourceDisposition, SourceOrigin,
        SourceScope,
    };
    use std::collections::BTreeSet;

    struct MockBackend {
        id: SourceId,
        protocol: ProtocolFamily,
        endpoint: Option<Endpoint>,
        capabilities: CapabilitySet,
        health: ProviderHealth,
        result: Result<BackendObservation, ChainBackendError>,
    }

    impl ChainBackend for MockBackend {
        fn source_id(&self) -> &SourceId {
            &self.id
        }
        fn protocol(&self) -> ProtocolFamily {
            self.protocol
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            self.endpoint.as_ref()
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }
        fn health(&self) -> ProviderHealth {
            self.health
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            self.capabilities.is_usable(operation_capability(operation))
        }
        fn execute<'a>(&'a self, _request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            let result = self.result.clone();
            Box::pin(async move { result })
        }
    }

    fn source(id: &str, priority: u16) -> ChainSource {
        source_with_protocols(id, priority, &[ProtocolFamily::Electrum])
    }

    fn source_with_protocols(
        id: &str,
        priority: u16,
        protocols: &[ProtocolFamily],
    ) -> ChainSource {
        let mut capabilities = CapabilitySet::default();
        for protocol in protocols {
            let capability = match protocol {
                ProtocolFamily::Electrum => Capability::ElectrumProtocol,
                ProtocolFamily::Bip37 => Capability::Bip37BloomFiltering,
                ProtocolFamily::Neutrino => Capability::CompactFilters,
                ProtocolFamily::BchnRpc => Capability::RpcQueries,
                ProtocolFamily::BchnZmq => Capability::ZmqEvents,
            };
            capabilities.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        ChainSource {
            id: SourceId::new(id),
            label: id.into(),
            origin: SourceOrigin::UserAdded,
            endpoints: Vec::new(),
            capabilities,
            disposition: SourceDisposition::Enabled,
            priority,
        }
    }

    fn backend(id: &str, result: Result<BackendObservation, ChainBackendError>) -> Arc<MockBackend> {
        let mut capabilities = CapabilitySet::default();
        for capability in [
            Capability::UtxoQuery,
            Capability::TransactionQuery,
            Capability::Broadcast,
            Capability::HeaderStream,
            Capability::HeaderMerkleProof,
        ] {
            capabilities.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        Arc::new(MockBackend {
            id: SourceId::new(id),
            protocol: ProtocolFamily::Electrum,
            endpoint: Some(Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: id.into(),
                port: Some(50002),
            }),
            capabilities,
            health: ProviderHealth::Healthy,
            result,
        })
    }

    fn capability_backend(
        id: &str,
        protocol: ProtocolFamily,
        capability: Capability,
        confidence: CapabilityConfidence,
    ) -> Arc<MockBackend> {
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            capability,
            confidence,
            match protocol {
                ProtocolFamily::Electrum => CapabilityDiscovery::ElectrumServerFeatures,
                _ => CapabilityDiscovery::ExplicitConfiguration,
            },
        );
        let endpoint = Some(Endpoint {
            kind: match protocol {
                ProtocolFamily::Electrum => EndpointKind::ElectrumTls,
                ProtocolFamily::BchnRpc => EndpointKind::BchnRpc,
                ProtocolFamily::BchnZmq => EndpointKind::BchnZmq,
                ProtocolFamily::Bip37 | ProtocolFamily::Neutrino => EndpointKind::BchP2p,
            },
            host: id.into(),
            port: None,
        });
        Arc::new(MockBackend {
            id: SourceId::new(id),
            protocol,
            endpoint,
            capabilities,
            health: ProviderHealth::Healthy,
            result: Err(ChainBackendError::Unsupported),
        })
    }

    fn success(txid: Hash32) -> BackendObservation {
        BackendObservation {
            payload: ChainPayload::BroadcastObserved { txid },
            evidence: Evidence::MempoolObservation,
            chain_tip: None,
        }
    }

    #[tokio::test]
    async fn bounded_failover_uses_second_selected_source() {
        let mut catalog = SourceCatalog::default();
        catalog.insert(source("a", 0)).unwrap();
        catalog.insert(source("b", 1)).unwrap();
        let policy = ConnectionPolicy {
            protocols: crate::chain::ProtocolSet::only(ProtocolFamily::Electrum),
            primary_scope: SourceScope::Explicit(BTreeSet::from([
                SourceId::new("a"),
                SourceId::new("b"),
            ])),
            fallback_scope: None,
            preferred: vec![SourceId::new("a"), SourceId::new("b")],
        };
        let mut service = ChainService::new(catalog, policy);
        service.register(backend("a", Err(ChainBackendError::Timeout)));
        service.register(backend("b", Ok(success([7; 32]))));
        let observation = service
            .execute(&ChainRequest::Broadcast {
                raw_tx: vec![1, 2, 3],
                txid: [7; 32],
            })
            .await
            .unwrap();
        assert_eq!(observation.source, SourceId::new("b"));
        assert_eq!(
            observation.value,
            ChainPayload::BroadcastObserved { txid: [7; 32] }
        );
    }

    #[tokio::test]
    async fn no_fallback_never_escapes_selected_pool() {
        let mut catalog = SourceCatalog::default();
        catalog.insert(source("selected", 0)).unwrap();
        catalog.insert(source("outside", 0)).unwrap();
        let policy = ConnectionPolicy::exact(SourceId::new("selected"), ProtocolFamily::Electrum);
        let mut service = ChainService::new(catalog, policy);
        service.register(backend("selected", Err(ChainBackendError::Offline)));
        service.register(backend("outside", Ok(success([9; 32]))));
        let error = service
            .execute(&ChainRequest::Broadcast {
                raw_tx: vec![1],
                txid: [9; 32],
            })
            .await
            .unwrap_err();
        match error {
            ChainServiceError::Exhausted { attempts } => {
                assert_eq!(attempts.len(), 1);
                assert_eq!(attempts[0].source, SourceId::new("selected"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn one_source_can_offer_the_same_future_capability_over_multiple_routes() {
        let id = SourceId::new("my-infrastructure");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(source_with_protocols(
                id.as_str(),
                0,
                &[ProtocolFamily::Electrum, ProtocolFamily::BchnRpc],
            ))
            .unwrap();
        let policy = ConnectionPolicy {
            protocols: crate::chain::ProtocolSet::all(),
            primary_scope: SourceScope::Explicit(BTreeSet::from([id.clone()])),
            fallback_scope: None,
            preferred: vec![id.clone()],
        };
        let mut service = ChainService::new(catalog, policy);
        service.register(capability_backend(
            id.as_str(),
            ProtocolFamily::Electrum,
            Capability::RpaIndex,
            CapabilityConfidence::Verified,
        ));
        service.register(capability_backend(
            id.as_str(),
            ProtocolFamily::BchnRpc,
            Capability::RpaIndex,
            CapabilityConfidence::Advertised,
        ));

        let routes = service.routes_for_capability(Capability::RpaIndex);
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].source, id);
        assert_eq!(routes[0].protocol, ProtocolFamily::Electrum);
        assert_eq!(routes[0].confidence, CapabilityConfidence::Verified);
        assert_eq!(routes[1].protocol, ProtocolFamily::BchnRpc);
    }

    #[test]
    fn optional_index_capabilities_need_no_new_source_mode() {
        let id = SourceId::new("index-capable-source");
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(source_with_protocols(
                id.as_str(),
                0,
                &[ProtocolFamily::Electrum],
            ))
            .unwrap();
        let policy = ConnectionPolicy {
            protocols: crate::chain::ProtocolSet::only(ProtocolFamily::Electrum),
            primary_scope: SourceScope::Explicit(BTreeSet::from([id.clone()])),
            fallback_scope: None,
            preferred: Vec::new(),
        };
        let mut service = ChainService::new(catalog, policy);
        for capability in [
            Capability::CashTokenIndex,
            Capability::BcmrResolver,
            Capability::GraphQueries,
        ] {
            service.register(capability_backend(
                id.as_str(),
                ProtocolFamily::Electrum,
                capability,
                CapabilityConfidence::Advertised,
            ));
            assert_eq!(service.routes_for_capability(capability).len(), 1);
        }
    }
}
