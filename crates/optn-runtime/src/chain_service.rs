//! Runtime-owned BCH provider orchestration for issue #75.
//!
//! Concrete network adapters implement [`ChainBackend`]. This service applies
//! the persisted connection policy, performs bounded failover, and returns
//! typed observations/evidence. A backend never receives mutable wallet state.

use crate::chain::{
    build_selection_plan, Capability, CapabilitySet, ChainObservation, ConnectionPolicy, Evidence,
    Hash32, ProtocolFamily, ProviderHealth, SourceCatalog, SourceId,
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
        /// Script pubkeys or other provider-neutral wallet interests. Providers
        /// may internally transform these into bloom items, compact-filter
        /// matches, or Electrum script hashes.
        interests: Vec<Vec<u8>>,
        from_height: Option<u32>,
    },
    TransactionLookup { txid: Hash32 },
    Broadcast { raw_tx: Vec<u8>, txid: Hash32 },
    HeaderSync { start_height: u32, count: u32 },
    HistoricalHeaderProof { height: u32 },
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
    /// Raw transaction bytes are retained so parsing/validation remains in the
    /// Rust domain/core rather than trusting provider-normalized balances.
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
        /// Serialized 80-byte BCH headers.
        headers: Vec<[u8; 80]>,
    },
    HistoricalHeaderProof {
        height: u32,
        header: [u8; 80],
        siblings: Vec<Hash32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendObservation {
    pub payload: ChainPayload,
    pub evidence: Vec<Evidence>,
    pub chain_tip: Option<Hash32>,
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

/// Concrete Electrum, BIP37, Neutrino, and trusted BCHN RPC adapters implement
/// this trait. ZMQ remains a separate event source and wakes this service to
/// retrieve/verify data rather than directly mutating state.
pub trait ChainBackend: Send + Sync {
    fn source_id(&self) -> &SourceId;
    fn protocol(&self) -> ProtocolFamily;
    fn capabilities(&self) -> &CapabilitySet;
    fn health(&self) -> ProviderHealth;
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
        let mut providers = self
            .providers
            .iter()
            .filter(|provider| provider.source_id() == source)
            .filter(|provider| policy.protocols.contains(provider.protocol()))
            .filter(|provider| provider.supports(operation))
            .filter(|provider| !matches!(provider.health(), ProviderHealth::Offline))
            .collect::<Vec<_>>();

        providers.sort_by_key(|provider| operation_protocol_rank(operation, provider.protocol()));
        providers
    }
}

/// Owns provider selection/failover. Authoritative wallet reconciliation lives
/// above the returned `ChainObservation`; provider data is never applied here
/// as a balance overwrite.
pub struct ChainService {
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    registry: ProviderRegistry,
    /// Runtime-local health overrides after failed attempts. This prevents a
    /// failing backend from being retried repeatedly during the same session;
    /// a health worker may later clear/update it after a successful probe.
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
            for provider in self
                .registry
                .providers_for(&source, &self.policy, request.operation())
            {
                let key = (source.clone(), provider.protocol());
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
                            evidence: observation.evidence,
                            chain_tip: observation.chain_tip,
                        });
                    }
                    Err(error) => {
                        let health = match error {
                            ChainBackendError::Offline | ChainBackendError::Timeout => {
                                ProviderHealth::Offline
                            }
                            _ => ProviderHealth::Degraded,
                        };
                        self.health_overrides.insert(key, health);
                        attempts.push(AttemptFailure {
                            source: source.clone(),
                            protocol: provider.protocol(),
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

fn operation_protocol_rank(operation: ChainOperation, protocol: ProtocolFamily) -> u8 {
    match operation {
        // Auto favors fast indexed history where policy permits it; Privacy or
        // single-protocol policies remove Electrum before this rank is applied.
        ChainOperation::WalletRefresh => match protocol {
            ProtocolFamily::Electrum => 0,
            ProtocolFamily::BchnRpc => 1,
            ProtocolFamily::Neutrino => 2,
            ProtocolFamily::Bip37 => 3,
            ProtocolFamily::BchnZmq => 9,
        },
        ChainOperation::TransactionLookup => match protocol {
            ProtocolFamily::BchnRpc => 0,
            ProtocolFamily::Electrum => 1,
            ProtocolFamily::Bip37 => 2,
            ProtocolFamily::Neutrino => 3,
            ProtocolFamily::BchnZmq => 9,
        },
        ChainOperation::Broadcast => match protocol {
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

/// Required capabilities for the common operations. Adapters may additionally
/// gate `supports()` on protocol-specific state (for example a successful
/// compact-filter probe before enabling Neutrino).
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
        CapabilityConfidence, CapabilityDiscovery, ChainSource, Endpoint, EndpointKind,
        SourceDisposition, SourceOrigin, SourceScope,
    };
    use std::collections::BTreeSet;

    struct MockBackend {
        id: SourceId,
        protocol: ProtocolFamily,
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
        let mut capabilities = CapabilitySet::default();
        for capability in [
            Capability::UtxoQuery,
            Capability::TransactionQuery,
            Capability::Broadcast,
            Capability::HeaderStream,
            Capability::HeaderMerkleProof,
            Capability::ElectrumProtocol,
        ] {
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
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: id.into(),
                port: Some(50002),
            }],
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
            capabilities,
            health: ProviderHealth::Healthy,
            result,
        })
    }

    fn success(txid: Hash32) -> BackendObservation {
        BackendObservation {
            payload: ChainPayload::BroadcastObserved { txid },
            evidence: vec![Evidence::MempoolObservation],
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
        assert_eq!(observation.value, ChainPayload::BroadcastObserved { txid: [7; 32] });
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
}
