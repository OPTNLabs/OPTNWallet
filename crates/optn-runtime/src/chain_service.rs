//! Runtime-owned capability routing and bounded failover for issue #75.
//!
//! Sources are selected by user policy. Capabilities are protocol-independent;
//! protocols/endpoints are delivery routes, never permanent capability owners.

use crate::chain::{
    build_selection_plan, Capability, CapabilityConfidence, CapabilitySet, ChainObservation,
    ConnectionPolicy, Endpoint, Evidence, Hash32, ProtocolFamily, ProviderHealth, SourceCatalog,
    SourceId,
};
use std::{future::Future, pin::Pin, sync::Arc};

pub type ChainFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ChainBackendError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainOperation { WalletRefresh, TransactionLookup, Broadcast, HeaderSync, HistoricalHeaderProof }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainRequest {
    WalletRefresh { interests: Vec<Vec<u8>>, from_height: Option<u32> },
    TransactionLookup { txid: Hash32 },
    Broadcast { raw_tx: Vec<u8>, txid: Hash32 },
    HeaderSync { start_height: u32, count: u32 },
    HistoricalHeaderProof { height: u32, checkpoint_height: u32 },
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
pub struct ChainTip { pub height: u32, pub hash: Hash32 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedTransaction { pub txid: Hash32, pub raw: Vec<u8>, pub block_height: Option<u32> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainPayload {
    WalletRefresh { transactions: Vec<ObservedTransaction>, tip: Option<ChainTip> },
    Transaction(ObservedTransaction),
    BroadcastObserved { txid: Hash32 },
    Headers { start_height: u32, headers: Vec<[u8; 80]> },
    HistoricalHeaderProof { height: u32, checkpoint_height: u32, header: [u8; 80], siblings: Vec<Hash32>, root: Hash32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendObservation { pub payload: ChainPayload, pub evidence: Evidence, pub chain_tip: Option<(u32, Hash32)> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainBackendError { Unsupported, Offline, Timeout, Protocol(String), InvalidResponse(String), Rejected(String) }

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
    fn endpoint(&self) -> Option<&Endpoint> { None }
    fn capabilities(&self) -> &CapabilitySet;
    fn health(&self) -> ProviderHealth;
    fn supports(&self, operation: ChainOperation) -> bool;
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptFailure { pub source: SourceId, pub protocol: ProtocolFamily, pub error: ChainBackendError }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainServiceError { NoEligibleProvider, RouteUnavailable, Exhausted { attempts: Vec<AttemptFailure> } }

#[derive(Default)]
pub struct ProviderRegistry { providers: Vec<Arc<dyn ChainBackend>> }

impl ProviderRegistry {
    pub fn register(&mut self, provider: Arc<dyn ChainBackend>) { self.providers.push(provider); }

    fn provider_routes<'a>(&'a self, source: &SourceId, policy: &ConnectionPolicy, capability: Capability, operation: Option<ChainOperation>) -> Vec<(&'a Arc<dyn ChainBackend>, CapabilityRoute)> {
        let mut routes = self.providers.iter().filter_map(|provider| {
            if provider.source_id() != source || !policy.protocols.contains(provider.protocol()) || matches!(provider.health(), ProviderHealth::Offline) { return None; }
            if operation.is_some_and(|op| !provider.supports(op)) { return None; }
            let claim = provider.capabilities().claim(capability)?;
            if !matches!(claim.confidence, CapabilityConfidence::Advertised | CapabilityConfidence::Verified) { return None; }
            Some((provider, CapabilityRoute {
                source: source.clone(), protocol: provider.protocol(), endpoint: provider.endpoint().cloned(), capability,
                confidence: claim.confidence, health: provider.health(),
            }))
        }).collect::<Vec<_>>();
        // Never encode semantic ownership through protocol order. Protocol is
        // only a deterministic final tie-breaker after evidence and health.
        routes.sort_by_key(|(_, route)| (confidence_rank(route.confidence), health_rank(route.health), route.protocol));
        routes
    }

    pub fn routes_for_capability(&self, source: &SourceId, policy: &ConnectionPolicy, capability: Capability) -> Vec<CapabilityRoute> {
        self.provider_routes(source, policy, capability, None).into_iter().map(|(_, route)| route).collect()
    }

    fn routes_for_operation<'a>(&'a self, source: &SourceId, policy: &ConnectionPolicy, operation: ChainOperation) -> Vec<(&'a Arc<dyn ChainBackend>, CapabilityRoute)> {
        self.provider_routes(source, policy, operation_capability(operation), Some(operation))
    }

    fn provider_for_route(&self, route: &CapabilityRoute, operation: ChainOperation) -> Option<Arc<dyn ChainBackend>> {
        self.providers.iter().find(|provider| {
            provider.source_id() == &route.source && provider.protocol() == route.protocol
                && provider.endpoint() == route.endpoint.as_ref() && provider.supports(operation)
                && provider.capabilities().is_usable(route.capability)
        }).cloned()
    }
}

#[derive(Debug, Clone)]
struct HealthOverride { source: SourceId, protocol: ProtocolFamily, endpoint: Option<Endpoint>, health: ProviderHealth }

pub struct ChainService {
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    registry: ProviderRegistry,
    health_overrides: Vec<HealthOverride>,
}

impl ChainService {
    pub fn new(catalog: SourceCatalog, policy: ConnectionPolicy) -> Self {
        Self { catalog, policy, registry: ProviderRegistry::default(), health_overrides: Vec::new() }
    }
    pub fn catalog(&self) -> &SourceCatalog { &self.catalog }
    pub fn catalog_mut(&mut self) -> &mut SourceCatalog { &mut self.catalog }
    pub fn policy(&self) -> &ConnectionPolicy { &self.policy }
    pub fn set_policy(&mut self, policy: ConnectionPolicy) { self.policy = policy; }
    pub fn register(&mut self, provider: Arc<dyn ChainBackend>) { self.registry.register(provider); }

    pub fn clear_health_override(&mut self, source: &SourceId, protocol: ProtocolFamily) {
        self.health_overrides.retain(|entry| entry.source != *source || entry.protocol != protocol);
    }

    fn route_unhealthy(&self, route: &CapabilityRoute) -> bool {
        self.health_overrides.iter().find(|entry| entry.source == route.source && entry.protocol == route.protocol && entry.endpoint == route.endpoint)
            .is_some_and(|entry| matches!(entry.health, ProviderHealth::Offline | ProviderHealth::Degraded))
    }

    fn set_route_health(&mut self, route: &CapabilityRoute, health: ProviderHealth) {
        if let Some(entry) = self.health_overrides.iter_mut().find(|entry| entry.source == route.source && entry.protocol == route.protocol && entry.endpoint == route.endpoint) {
            entry.health = health;
        } else {
            self.health_overrides.push(HealthOverride { source: route.source.clone(), protocol: route.protocol, endpoint: route.endpoint.clone(), health });
        }
    }

    pub fn routes_for_capability(&self, capability: Capability) -> Vec<CapabilityRoute> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        plan.primary.iter().chain(plan.fallback.iter())
            .flat_map(|source| self.registry.routes_for_capability(source, &self.policy, capability))
            .filter(|route| !self.route_unhealthy(route)).collect()
    }

    pub fn routes_for_operation(&self, operation: ChainOperation) -> Vec<CapabilityRoute> {
        let plan = build_selection_plan(&self.catalog, &self.policy);
        plan.primary.iter().chain(plan.fallback.iter())
            .flat_map(|source| self.registry.routes_for_operation(source, &self.policy, operation).into_iter().map(|(_, route)| route))
            .filter(|route| !self.route_unhealthy(route)).collect()
    }

    /// Execute on one exact route. Multi-step workflows use this to keep
    /// provider-local prerequisites (for example a BIP37 header cursor) on the
    /// same provider instead of silently changing transport halfway through.
    pub async fn execute_on_route(&mut self, route: &CapabilityRoute, request: &ChainRequest) -> Result<ChainObservation<ChainPayload>, ChainServiceError> {
        if route.capability != operation_capability(request.operation()) || self.route_unhealthy(route) { return Err(ChainServiceError::RouteUnavailable); }
        let provider = self.registry.provider_for_route(route, request.operation()).ok_or(ChainServiceError::RouteUnavailable)?;
        match provider.execute(request).await {
            Ok(observation) => {
                self.set_route_health(route, ProviderHealth::Healthy);
                Ok(ChainObservation { value: observation.payload, source: route.source.clone(), chain_tip: observation.chain_tip, evidence: observation.evidence })
            }
            Err(error) => {
                self.set_route_health(route, health_for_error(&error));
                Err(ChainServiceError::Exhausted { attempts: vec![AttemptFailure { source: route.source.clone(), protocol: route.protocol, error }] })
            }
        }
    }

    pub async fn execute(&mut self, request: &ChainRequest) -> Result<ChainObservation<ChainPayload>, ChainServiceError> {
        let routes = self.routes_for_operation(request.operation());
        if routes.is_empty() { return Err(ChainServiceError::NoEligibleProvider); }
        let mut attempts = Vec::new();
        for route in routes {
            match self.execute_on_route(&route, request).await {
                Ok(value) => return Ok(value),
                Err(ChainServiceError::Exhausted { attempts: mut failed }) => attempts.append(&mut failed),
                Err(ChainServiceError::NoEligibleProvider | ChainServiceError::RouteUnavailable) => {}
            }
        }
        if attempts.is_empty() { Err(ChainServiceError::NoEligibleProvider) } else { Err(ChainServiceError::Exhausted { attempts }) }
    }
}

const fn confidence_rank(value: CapabilityConfidence) -> u8 {
    match value { CapabilityConfidence::Verified => 0, CapabilityConfidence::Advertised => 1, CapabilityConfidence::Unknown => 2, CapabilityConfidence::Rejected => 3 }
}
const fn health_rank(value: ProviderHealth) -> u8 {
    match value { ProviderHealth::Healthy => 0, ProviderHealth::Unknown => 1, ProviderHealth::Degraded => 2, ProviderHealth::Offline => 3 }
}
fn health_for_error(error: &ChainBackendError) -> ProviderHealth {
    match error { ChainBackendError::Offline | ChainBackendError::Timeout => ProviderHealth::Offline, _ => ProviderHealth::Degraded }
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
    use crate::chain::{CapabilityDiscovery, ChainSource, EndpointKind, SourceDisposition, SourceOrigin};

    struct Mock { id: SourceId, protocol: ProtocolFamily, endpoint: Endpoint, caps: CapabilitySet, result: Result<BackendObservation, ChainBackendError> }
    impl ChainBackend for Mock {
        fn source_id(&self)->&SourceId{&self.id} fn protocol(&self)->ProtocolFamily{self.protocol} fn endpoint(&self)->Option<&Endpoint>{Some(&self.endpoint)}
        fn capabilities(&self)->&CapabilitySet{&self.caps} fn health(&self)->ProviderHealth{ProviderHealth::Healthy}
        fn supports(&self,op:ChainOperation)->bool{self.caps.is_usable(operation_capability(op))}
        fn execute<'a>(&'a self,_:&'a ChainRequest)->ChainFuture<'a,BackendObservation>{let result=self.result.clone();Box::pin(async move{result})}
    }
    fn source(id:&str,priority:u16)->ChainSource{ChainSource{id:SourceId::new(id),label:id.into(),origin:SourceOrigin::UserAdded,endpoints:vec![Endpoint{kind:EndpointKind::BchP2p,host:id.into(),port:Some(8333)}],capabilities:CapabilitySet::default(),disposition:SourceDisposition::Enabled,priority}}
    fn backend(id:&str,protocol:ProtocolFamily,confidence:CapabilityConfidence,result:Result<BackendObservation,ChainBackendError>)->Arc<Mock>{let mut caps=CapabilitySet::default();for c in [Capability::UtxoQuery,Capability::TransactionQuery,Capability::Broadcast,Capability::HeaderStream,Capability::HeaderMerkleProof]{caps.record(c,confidence,CapabilityDiscovery::ActiveProbe);}let kind=match protocol{ProtocolFamily::Electrum=>EndpointKind::ElectrumTcp,ProtocolFamily::Bip37|ProtocolFamily::Neutrino=>EndpointKind::BchP2p,ProtocolFamily::BchnRpc=>EndpointKind::BchnRpc,ProtocolFamily::BchnZmq=>EndpointKind::BchnZmq};Arc::new(Mock{id:SourceId::new(id),protocol,endpoint:Endpoint{kind,host:id.into(),port:Some(1)},caps,result})}
    fn obs(tag:u8)->BackendObservation{BackendObservation{payload:ChainPayload::Headers{start_height:1,headers:vec![[tag;80]]},evidence:Evidence::ServerAssertion,chain_tip:None}}

    #[tokio::test]
    async fn source_failover_is_bounded_by_policy(){let mut catalog=SourceCatalog::default();catalog.insert(source("a",0)).unwrap();catalog.insert(source("b",1)).unwrap();let mut service=ChainService::new(catalog,ConnectionPolicy::auto());service.register(backend("a",ProtocolFamily::Electrum,CapabilityConfidence::Verified,Err(ChainBackendError::Timeout)));service.register(backend("b",ProtocolFamily::Electrum,CapabilityConfidence::Verified,Ok(obs(2))));let got=service.execute(&ChainRequest::HeaderSync{start_height:1,count:1}).await.unwrap();assert_eq!(got.source,SourceId::new("b"));}

    #[test]
    fn verified_route_outranks_advertised_without_protocol_ownership(){let mut catalog=SourceCatalog::default();catalog.insert(source("a",0)).unwrap();let mut service=ChainService::new(catalog,ConnectionPolicy::auto());service.register(backend("a",ProtocolFamily::Electrum,CapabilityConfidence::Advertised,Ok(obs(1))));service.register(backend("a",ProtocolFamily::Bip37,CapabilityConfidence::Verified,Ok(obs(2))));let routes=service.routes_for_operation(ChainOperation::HeaderSync);assert_eq!(routes[0].protocol,ProtocolFamily::Bip37);}

    #[tokio::test]
    async fn explicit_route_does_not_switch_protocol(){let mut catalog=SourceCatalog::default();catalog.insert(source("a",0)).unwrap();let mut service=ChainService::new(catalog,ConnectionPolicy::auto());service.register(backend("a",ProtocolFamily::Electrum,CapabilityConfidence::Verified,Ok(obs(1))));service.register(backend("a",ProtocolFamily::Bip37,CapabilityConfidence::Verified,Ok(obs(2))));let route=service.routes_for_operation(ChainOperation::HeaderSync).into_iter().find(|r|r.protocol==ProtocolFamily::Bip37).unwrap();let got=service.execute_on_route(&route,&ChainRequest::HeaderSync{start_height:1,count:1}).await.unwrap();match got.value{ChainPayload::Headers{headers,..}=>assert_eq!(headers[0],[2;80]),_=>panic!("wrong payload")}}
}
