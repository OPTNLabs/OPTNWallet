//! Runtime-owned capability routing and bounded failover for issue #75.
//!
//! Sources are selected by user policy. Capabilities and wallet intent are
//! protocol-independent; providers translate typed requests to their wire format.

use crate::chain::{
    build_selection_plan, Capability, CapabilityConfidence, CapabilitySet, ChainObservation,
    ConnectionPolicy, Endpoint, Evidence, Hash32, ProtocolFamily, ProviderHealth, SourceCatalog,
    SourceId,
};
use std::{future::Future, pin::Pin, sync::Arc};

pub type ChainFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ChainBackendError>> + Send + 'a>>;

/// Wallet discovery intent, independent of the selected chain protocol.
///
/// Electrum derives scripthashes from `Script`; bchd compact filters query raw
/// scripts and serialized `Outpoint`s; BIP37 derives the corresponding bloom
/// items. RPA keeps its hexadecimal bit-prefix intact, including odd nibbles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletInterest {
    Script(Vec<u8>),
    Outpoint { txid: Hash32, vout: u32 },
    RpaPrefix(String),
}

impl WalletInterest {
    pub fn script(value: impl Into<Vec<u8>>) -> Self {
        Self::Script(value.into())
    }
    pub const fn outpoint(txid: Hash32, vout: u32) -> Self {
        Self::Outpoint { txid, vout }
    }

    pub fn rpa_prefix(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into().to_ascii_lowercase();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("RPA prefix must be non-empty hexadecimal text".into());
        }
        Ok(Self::RpaPrefix(value))
    }

    /// BCH wire serialization used by bchd committed filters and BIP37 outpoint
    /// matching: internal-order txid followed by little-endian vout.
    pub fn serialized_outpoint(&self) -> Option<[u8; 36]> {
        let Self::Outpoint { txid, vout } = self else {
            return None;
        };
        let mut out = [0u8; 36];
        out[..32].copy_from_slice(txid);
        out[32..].copy_from_slice(&vout.to_le_bytes());
        Some(out)
    }
}

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
        interests: Vec<WalletInterest>,
        from_height: Option<u32>,
    },
    TransactionLookup {
        txid: Hash32,
    },
    Broadcast {
        raw_tx: Vec<u8>,
        txid: Hash32,
    },
    HeaderSync {
        start_height: u32,
        count: u32,
    },
    HistoricalHeaderProof {
        height: u32,
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
    BroadcastObserved {
        txid: Hash32,
    },
    Headers {
        start_height: u32,
        headers: Vec<[u8; 80]>,
    },
    HistoricalHeaderProof {
        height: u32,
        checkpoint_height: u32,
        header: [u8; 80],
        siblings: Vec<Hash32>,
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
    /// Execution requires an endpoint currently owned by this source in the catalog.
    /// Backends without an endpoint are not eligible for routed I/O.
    fn endpoint(&self) -> Option<&Endpoint> {
        None
    }
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
    RouteUnavailable,
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

    fn provider_routes<'a>(
        &'a self,
        source: &SourceId,
        policy: &ConnectionPolicy,
        capability: Capability,
        operation: Option<ChainOperation>,
    ) -> Vec<(&'a Arc<dyn ChainBackend>, CapabilityRoute)> {
        let mut routes = self
            .providers
            .iter()
            .filter_map(|provider| {
                if provider.source_id() != source
                    || !policy.protocols.contains(provider.protocol())
                    || matches!(provider.health(), ProviderHealth::Offline)
                {
                    return None;
                }
                if operation.is_some_and(|op| !provider.supports(op)) {
                    return None;
                }
                let claim = provider.capabilities().claim(capability)?;
                if !matches!(
                    claim.confidence,
                    CapabilityConfidence::Advertised | CapabilityConfidence::Verified
                ) {
                    return None;
                }
                Some((
                    provider,
                    CapabilityRoute {
                        source: source.clone(),
                        protocol: provider.protocol(),
                        endpoint: provider.endpoint().cloned(),
                        capability,
                        confidence: claim.confidence,
                        health: provider.health(),
                    },
                ))
            })
            .collect::<Vec<_>>();
        // Capability confidence and health outrank transport identity. Protocol
        // is only a deterministic final tie-breaker.
        routes.sort_by_key(|(_, route)| {
            (
                confidence_rank(route.confidence),
                health_rank(route.health),
                route.protocol,
            )
        });
        routes
    }

    pub fn routes_for_capability(
        &self,
        source: &SourceId,
        policy: &ConnectionPolicy,
        capability: Capability,
    ) -> Vec<CapabilityRoute> {
        self.provider_routes(source, policy, capability, None)
            .into_iter()
            .map(|(_, route)| route)
            .collect()
    }

    fn routes_for_operation<'a>(
        &'a self,
        source: &SourceId,
        policy: &ConnectionPolicy,
        operation: ChainOperation,
    ) -> Vec<(&'a Arc<dyn ChainBackend>, CapabilityRoute)> {
        self.provider_routes(
            source,
            policy,
            operation_capability(operation),
            Some(operation),
        )
    }

    fn provider_for_route(
        &self,
        route: &CapabilityRoute,
        operation: ChainOperation,
    ) -> Option<Arc<dyn ChainBackend>> {
        self.providers
            .iter()
            .find(|provider| {
                provider.source_id() == &route.source
                    && provider.protocol() == route.protocol
                    && provider.endpoint() == route.endpoint.as_ref()
                    && !matches!(provider.health(), ProviderHealth::Offline)
                    && provider.supports(operation)
                    && provider.capabilities().is_usable(route.capability)
            })
            .cloned()
    }
}

#[derive(Debug, Clone)]
struct HealthOverride {
    source: SourceId,
    protocol: ProtocolFamily,
    endpoint: Option<Endpoint>,
    health: ProviderHealth,
}

pub struct ChainService {
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    registry: ProviderRegistry,
    health_overrides: Vec<HealthOverride>,
}

impl ChainService {
    pub fn new(catalog: SourceCatalog, policy: ConnectionPolicy) -> Self {
        Self {
            catalog,
            policy,
            registry: ProviderRegistry::default(),
            health_overrides: Vec::new(),
        }
    }
    pub fn catalog(&self) -> &SourceCatalog {
        &self.catalog
    }
    pub fn catalog_mut(&mut self) -> &mut SourceCatalog {
        &mut self.catalog
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
        self.health_overrides
            .retain(|entry| entry.source != *source || entry.protocol != protocol);
    }

    fn route_unavailable(&self, route: &CapabilityRoute) -> bool {
        if !self.catalog.get(&route.source).is_some_and(|source| {
            route.endpoint.as_ref().is_some_and(|endpoint| {
                endpoint.kind.can_probe_protocol(route.protocol)
                    && source.endpoints.contains(endpoint)
            })
        }) {
            return true;
        }
        self.health_overrides
            .iter()
            .find(|entry| {
                entry.source == route.source
                    && entry.protocol == route.protocol
                    && entry.endpoint == route.endpoint
            })
            .is_some_and(|entry| {
                matches!(
                    entry.health,
                    ProviderHealth::Offline | ProviderHealth::Degraded
                )
            })
    }

    fn set_route_health(&mut self, route: &CapabilityRoute, health: ProviderHealth) {
        if let Some(entry) = self.health_overrides.iter_mut().find(|entry| {
            entry.source == route.source
                && entry.protocol == route.protocol
                && entry.endpoint == route.endpoint
        }) {
            entry.health = health;
        } else {
            self.health_overrides.push(HealthOverride {
                source: route.source.clone(),
                protocol: route.protocol,
                endpoint: route.endpoint.clone(),
                health,
            });
        }
    }

    pub fn routes_for_capability(&self, capability: Capability) -> Vec<CapabilityRoute> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        plan.primary
            .iter()
            .chain(plan.fallback.iter())
            .flat_map(|source| {
                self.registry
                    .routes_for_capability(source, &self.policy, capability)
            })
            .filter(|route| !self.route_unavailable(route))
            .collect()
    }

    /// Whether the current source/protocol/privacy policy has at least one
    /// healthy route for this exact capability. Higher-level planners use this
    /// rather than branching on provider brands.
    pub fn has_route_for_capability(&self, capability: Capability) -> bool {
        !self.routes_for_capability(capability).is_empty()
    }

    pub fn routes_for_operation(&self, operation: ChainOperation) -> Vec<CapabilityRoute> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        plan.primary
            .iter()
            .chain(plan.fallback.iter())
            .flat_map(|source| {
                self.registry
                    .routes_for_operation(source, &self.policy, operation)
                    .into_iter()
                    .map(|(_, route)| route)
            })
            .filter(|route| !self.route_unavailable(route))
            .collect()
    }

    pub async fn execute_on_route(
        &mut self,
        route: &CapabilityRoute,
        request: &ChainRequest,
    ) -> Result<ChainObservation<ChainPayload>, ChainServiceError> {
        // Routes are public snapshots, not authorization to bypass current policy.
        if !self
            .routes_for_operation(request.operation())
            .iter()
            .any(|current| {
                current.source == route.source
                    && current.protocol == route.protocol
                    && current.endpoint == route.endpoint
                    && current.capability == route.capability
            })
        {
            return Err(ChainServiceError::RouteUnavailable);
        }
        let provider = self
            .registry
            .provider_for_route(route, request.operation())
            .ok_or(ChainServiceError::RouteUnavailable)?;
        match provider.execute(request).await {
            Ok(observation) => {
                self.set_route_health(route, ProviderHealth::Healthy);
                Ok(ChainObservation {
                    value: observation.payload,
                    source: route.source.clone(),
                    chain_tip: observation.chain_tip,
                    evidence: observation.evidence,
                })
            }
            Err(error) => {
                self.set_route_health(route, health_for_error(&error));
                Err(ChainServiceError::Exhausted {
                    attempts: vec![AttemptFailure {
                        source: route.source.clone(),
                        protocol: route.protocol,
                        error,
                    }],
                })
            }
        }
    }

    pub async fn execute(
        &mut self,
        request: &ChainRequest,
    ) -> Result<ChainObservation<ChainPayload>, ChainServiceError> {
        let routes = self.routes_for_operation(request.operation());
        if routes.is_empty() {
            return Err(ChainServiceError::NoEligibleProvider);
        }
        let mut attempts = Vec::new();
        for route in routes {
            match self.execute_on_route(&route, request).await {
                Ok(value) => return Ok(value),
                Err(ChainServiceError::Exhausted {
                    attempts: mut failed,
                }) => attempts.append(&mut failed),
                Err(
                    ChainServiceError::NoEligibleProvider | ChainServiceError::RouteUnavailable,
                ) => {}
            }
        }
        if attempts.is_empty() {
            Err(ChainServiceError::NoEligibleProvider)
        } else {
            Err(ChainServiceError::Exhausted { attempts })
        }
    }
}

const fn confidence_rank(value: CapabilityConfidence) -> u8 {
    match value {
        CapabilityConfidence::Verified => 0,
        CapabilityConfidence::Advertised => 1,
        CapabilityConfidence::Unknown => 2,
        CapabilityConfidence::Rejected => 3,
    }
}
const fn health_rank(value: ProviderHealth) -> u8 {
    match value {
        ProviderHealth::Healthy => 0,
        ProviderHealth::Unknown => 1,
        ProviderHealth::Degraded => 2,
        ProviderHealth::Offline => 3,
    }
}
fn health_for_error(error: &ChainBackendError) -> ProviderHealth {
    match error {
        ChainBackendError::Offline | ChainBackendError::Timeout => ProviderHealth::Offline,
        _ => ProviderHealth::Degraded,
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct CountingBackend {
        source: SourceId,
        endpoint: Endpoint,
        capabilities: CapabilitySet,
        calls: AtomicUsize,
        offline: AtomicBool,
    }

    impl ChainBackend for CountingBackend {
        fn source_id(&self) -> &SourceId {
            &self.source
        }
        fn protocol(&self) -> ProtocolFamily {
            ProtocolFamily::Electrum
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }
        fn health(&self) -> ProviderHealth {
            if self.offline.load(Ordering::SeqCst) {
                ProviderHealth::Offline
            } else {
                ProviderHealth::Healthy
            }
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            operation == ChainOperation::HeaderSync
        }
        fn execute<'a>(&'a self, _: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(BackendObservation {
                    payload: ChainPayload::Headers {
                        start_height: 1,
                        headers: vec![],
                    },
                    evidence: Evidence::ServerAssertion,
                    chain_tip: None,
                })
            })
        }
    }

    fn routed_service() -> (ChainService, Arc<CountingBackend>, CapabilityRoute) {
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::HeaderStream,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        let backend = Arc::new(CountingBackend {
            source: SourceId::new("server"),
            endpoint: Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "server.invalid".into(),
                port: Some(50001),
            },
            capabilities,
            calls: AtomicUsize::new(0),
            offline: AtomicBool::new(false),
        });
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: backend.source.clone(),
                label: "server".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![backend.endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(backend.clone());
        let route = service
            .routes_for_operation(ChainOperation::HeaderSync)
            .remove(0);
        (service, backend, route)
    }

    const HEADER_REQUEST: ChainRequest = ChainRequest::HeaderSync {
        start_height: 1,
        count: 1,
    };

    #[tokio::test]
    async fn stale_route_rechecks_source_disposition_before_io() {
        for disposition in [SourceDisposition::Banned, SourceDisposition::Disabled] {
            let (mut service, backend, route) = routed_service();
            service
                .catalog_mut()
                .set_disposition(&route.source, disposition)
                .unwrap();
            assert_eq!(
                service.execute_on_route(&route, &HEADER_REQUEST).await,
                Err(ChainServiceError::RouteUnavailable),
                "{disposition:?}"
            );
            assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn stale_route_rechecks_policy_before_io() {
        for policy in [
            ConnectionPolicy::own_infrastructure(),
            ConnectionPolicy::exact(SourceId::new("other"), ProtocolFamily::Electrum),
            ConnectionPolicy::exact(SourceId::new("server"), ProtocolFamily::Bip37),
        ] {
            let (mut service, backend, route) = routed_service();
            service.set_policy(policy);
            assert_eq!(
                service.execute_on_route(&route, &HEADER_REQUEST).await,
                Err(ChainServiceError::RouteUnavailable)
            );
            assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn stale_route_rechecks_configured_endpoint_before_io() {
        let (mut service, backend, route) = routed_service();
        service
            .catalog_mut()
            .get_mut(&route.source)
            .unwrap()
            .endpoints[0]
            .host = "replacement.invalid".into();
        assert!(service
            .routes_for_operation(ChainOperation::HeaderSync)
            .is_empty());
        assert!(service
            .routes_for_capability(Capability::HeaderStream)
            .is_empty());
        assert_eq!(
            service.execute_on_route(&route, &HEADER_REQUEST).await,
            Err(ChainServiceError::RouteUnavailable)
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn removed_source_or_changed_endpoint_rejects_before_io() {
        for change in 0..4 {
            let (mut service, backend, route) = routed_service();
            match change {
                0 => {
                    service.catalog_mut().remove(&route.source).unwrap();
                }
                1 => service
                    .catalog_mut()
                    .get_mut(&route.source)
                    .unwrap()
                    .endpoints
                    .clear(),
                2 => {
                    service
                        .catalog_mut()
                        .get_mut(&route.source)
                        .unwrap()
                        .endpoints[0]
                        .port = Some(50002)
                }
                _ => {
                    service
                        .catalog_mut()
                        .get_mut(&route.source)
                        .unwrap()
                        .endpoints[0]
                        .kind = EndpointKind::BchP2p
                }
            }
            assert!(service
                .routes_for_capability(Capability::HeaderStream)
                .is_empty());
            assert_eq!(
                service.execute_on_route(&route, &HEADER_REQUEST).await,
                Err(ChainServiceError::RouteUnavailable)
            );
            assert_eq!(
                service.execute(&HEADER_REQUEST).await,
                Err(ChainServiceError::NoEligibleProvider)
            );
            assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn forged_route_rejects_before_io() {
        for change in 0..5 {
            let (mut service, backend, mut route) = routed_service();
            match change {
                0 => route.source = SourceId::new("other"),
                1 => route.endpoint = None,
                2 => route.endpoint.as_mut().unwrap().host = "other.invalid".into(),
                3 => route.protocol = ProtocolFamily::Bip37,
                _ => route.capability = Capability::Broadcast,
            }
            assert_eq!(
                service.execute_on_route(&route, &HEADER_REQUEST).await,
                Err(ChainServiceError::RouteUnavailable)
            );
            assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn stale_route_rechecks_health_before_io() {
        let (mut service, backend, route) = routed_service();
        backend.offline.store(true, Ordering::SeqCst);
        assert_eq!(
            service.execute_on_route(&route, &HEADER_REQUEST).await,
            Err(ChainServiceError::RouteUnavailable)
        );
        backend.offline.store(false, Ordering::SeqCst);
        for health in [ProviderHealth::Offline, ProviderHealth::Degraded] {
            service.set_route_health(&route, health);
            assert_eq!(
                service.execute_on_route(&route, &HEADER_REQUEST).await,
                Err(ChainServiceError::RouteUnavailable)
            );
        }
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        service.clear_health_override(&route.source, route.protocol);
        assert!(service
            .execute_on_route(&route, &HEADER_REQUEST)
            .await
            .is_ok());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn allowed_fallback_route_ignores_cached_confidence_and_health() {
        let (mut service, backend, mut route) = routed_service();
        let mut policy = ConnectionPolicy::own_infrastructure();
        policy.fallback_scope = Some(SourceScope::PublicEnabled);
        service.set_policy(policy);
        route.confidence = CapabilityConfidence::Advertised;
        route.health = ProviderHealth::Unknown;
        assert!(service
            .execute_on_route(&route, &HEADER_REQUEST)
            .await
            .is_ok());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        service.set_policy(ConnectionPolicy::own_infrastructure());
        assert_eq!(
            service.execute_on_route(&route, &HEADER_REQUEST).await,
            Err(ChainServiceError::RouteUnavailable)
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn outpoint_wire_encoding_is_stable() {
        let interest = WalletInterest::outpoint([7; 32], 0x1122_3344);
        let encoded = interest.serialized_outpoint().unwrap();
        assert_eq!(&encoded[..32], &[7; 32]);
        assert_eq!(&encoded[32..], &0x1122_3344u32.to_le_bytes());
    }

    #[test]
    fn rpa_prefix_preserves_nibble_precision() {
        assert_eq!(
            WalletInterest::rpa_prefix("AbC").unwrap(),
            WalletInterest::RpaPrefix("abc".into())
        );
        assert!(WalletInterest::rpa_prefix("xyz").is_err());
    }
}
