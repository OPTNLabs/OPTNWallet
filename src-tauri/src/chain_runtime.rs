#![forbid(unsafe_code)]

//! Native shell adapter for issue #75's provider-neutral chain runtime.
//!
//! The shell owns concrete network transports and secrets; `optn-runtime` owns
//! routing, policy, evidence, and authoritative wallet state. A configured
//! endpoint is never probed unless it is inside the active source/protocol
//! policy. BCH P2P endpoints are independently probed for BIP37 and Neutrino so
//! a node can gain or lose either capability without changing the UI/source
//! model.

use optn_app::{AppEvent, AppState};
use optn_chain_bchn::{BchnRpcBackend, BchnRpcConfig, RpcAuth};
use optn_chain_bip37::{Bip37Backend, Bip37Config, Bip37Transport};
use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_chain_neutrino::{NeutrinoBackend, NeutrinoConfig, NeutrinoTransport};
use optn_chain_zmq::{BchnZmqConfig, BchnZmqEventSource};
use optn_core::endpoint::{
    is_loopback_host, parse_electrum_endpoint, parse_peer_endpoint, DEFAULT_WSS_PORT,
    NODE_HINT_PORT,
};
use optn_core::tor::{route as tor_route, Route as TorRoute, TorStatus};
use optn_runtime::chain::{
    build_selection_plan, CapabilitySet, ChainEventSource, ChainSource, ConnectionPolicy, Endpoint,
    EndpointKind, ProtocolFamily, SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
};
use optn_runtime::chain_service::ChainService;
use optn_runtime::events::ChainEventStream;
use optn_runtime::AppRuntime;
use rand_core::{OsRng, RngCore};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// Shell-only full-node RPC settings for the currently supported wire adapter.
/// Credentials deliberately never enter portable network configuration or
/// renderer state.
#[derive(Clone, Default)]
pub struct NativeChainSecrets {
    rpc_auth: BTreeMap<String, RpcAuth>,
    rpc_txindex: BTreeSet<String>,
    rpc_https: BTreeSet<String>,
}

impl NativeChainSecrets {
    pub fn set_rpc_basic_auth(
        &mut self,
        source: &SourceId,
        username: impl Into<String>,
        password: impl Into<String>,
    ) {
        self.rpc_auth.insert(
            source.as_str().to_owned(),
            RpcAuth::Basic {
                username: username.into(),
                password: password.into(),
            },
        );
    }

    pub fn set_rpc_txindex(&mut self, source: &SourceId, enabled: bool) {
        set_membership(&mut self.rpc_txindex, source.as_str(), enabled);
    }

    pub fn set_rpc_https(&mut self, source: &SourceId, enabled: bool) {
        set_membership(&mut self.rpc_https, source.as_str(), enabled);
    }

    fn rpc_auth(&self, source: &SourceId) -> RpcAuth {
        self.rpc_auth
            .get(source.as_str())
            .cloned()
            .unwrap_or(RpcAuth::None)
    }
}

fn set_membership(set: &mut BTreeSet<String>, value: &str, enabled: bool) {
    if enabled {
        set.insert(value.to_owned());
    } else {
        set.remove(value);
    }
}

pub trait NativeChainEventSource: ChainEventSource + ChainEventStream {}
impl<T> NativeChainEventSource for T where T: ChainEventSource + ChainEventStream {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeChainProbeFailure {
    pub source: SourceId,
    pub protocol: ProtocolFamily,
    pub endpoint: Endpoint,
    pub error: String,
}

pub struct NativeChainStack {
    pub service: Arc<Mutex<ChainService>>,
    pub event_sources: Vec<Arc<dyn NativeChainEventSource>>,
    pub failures: Vec<NativeChainProbeFailure>,
}

const REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE: &str =
    "remote native chain route requires a verified Tor SOCKS proxy";
const REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE: &str =
    "remote native chain route has no verified Tor-capable native adapter";

fn selected_source_ids(catalog: &SourceCatalog, policy: &ConnectionPolicy) -> BTreeSet<SourceId> {
    let selection = build_selection_plan(catalog, policy);
    selection
        .primary
        .iter()
        .chain(selection.fallback.iter())
        .cloned()
        .collect()
}

fn endpoint_can_use_native_tor(endpoint: &Endpoint, policy: &ConnectionPolicy) -> bool {
    match endpoint.kind {
        EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp => {
            policy.protocols.contains(ProtocolFamily::Electrum)
        }
        EndpointKind::BchP2p => {
            policy.protocols.contains(ProtocolFamily::Bip37)
                || policy.protocols.contains(ProtocolFamily::Neutrino)
        }
        _ => false,
    }
}

fn needs_default_tor_proxy(catalog: &SourceCatalog, policy: &ConnectionPolicy) -> bool {
    let selected = selected_source_ids(catalog, policy);
    catalog.iter().any(|source| {
        source.is_enabled()
            && selected.contains(&source.id)
            && source.endpoints.iter().any(|endpoint| {
                !is_loopback_host(&endpoint.host) && endpoint_can_use_native_tor(endpoint, policy)
            })
    })
}

async fn default_tor_status(catalog: &SourceCatalog, policy: &ConnectionPolicy) -> TorStatus {
    if !needs_default_tor_proxy(catalog, policy) {
        return TorStatus::Absent;
    }

    // ponytail: default Tor ports only; add a typed persisted proxy route when
    // AppState owns that transport policy.
    crate::fusion::tor::scan_tor_port(crate::fusion::tor::DEFAULT_TOR_HOST)
        .await
        .map(|socks_port| TorStatus::Verified { socks_port })
        .unwrap_or(TorStatus::Absent)
}

fn native_chain_route(endpoint: &Endpoint, tor_status: TorStatus) -> TorRoute {
    tor_route(&endpoint.host, tor_status)
}

fn record_remote_route_failure(
    failures: &mut Vec<NativeChainProbeFailure>,
    source: &ChainSource,
    endpoint: &Endpoint,
    policy: &ConnectionPolicy,
    error: &str,
) {
    match endpoint.kind {
        EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp
            if policy.protocols.contains(ProtocolFamily::Electrum) =>
        {
            failures.push(failure(
                source,
                ProtocolFamily::Electrum,
                endpoint,
                error.to_owned(),
            ));
        }
        EndpointKind::BchP2p => {
            for protocol in [ProtocolFamily::Bip37, ProtocolFamily::Neutrino] {
                if policy.protocols.contains(protocol) {
                    failures.push(failure(source, protocol, endpoint, error.to_owned()));
                }
            }
        }
        EndpointKind::BchnRpc if policy.protocols.contains(ProtocolFamily::BchnRpc) => {
            failures.push(failure(
                source,
                ProtocolFamily::BchnRpc,
                endpoint,
                error.to_owned(),
            ));
        }
        EndpointKind::BchnZmq if policy.protocols.contains(ProtocolFamily::BchnZmq) => {
            failures.push(failure(
                source,
                ProtocolFamily::BchnZmq,
                endpoint,
                error.to_owned(),
            ));
        }
        _ => {}
    }
}

fn electrum_transport(endpoint: &Endpoint, route: TorRoute) -> Option<ElectrumTransport> {
    let tls = endpoint.kind == EndpointKind::ElectrumTls;
    match route {
        TorRoute::Direct => Some(if tls {
            ElectrumTransport::Tls
        } else {
            ElectrumTransport::Tcp
        }),
        TorRoute::Through { socks_port } => {
            let token = fresh_tor_isolation_token();
            Some(ElectrumTransport::Tor {
                proxy_host: crate::fusion::tor::DEFAULT_TOR_HOST.to_owned(),
                proxy_port: socks_port,
                username: token.clone(),
                password: token,
                tls,
            })
        }
        TorRoute::Refused(_) => None,
    }
}

fn fresh_tor_isolation_token() -> String {
    let mut token = [0u8; 32];
    let mut rng = OsRng;
    rng.fill_bytes(&mut token);
    format!("optn-chain-{}", hex::encode(token))
}

/// Process-owned live chain stack. Reconfiguration is atomic from consumers'
/// perspective: the old stack remains usable until all permitted new routes
/// have been probed and the replacement is ready.
pub struct NativeChainRuntime {
    stack: RwLock<Option<NativeChainStack>>,
    secrets: RwLock<NativeChainSecrets>,
}

impl Default for NativeChainRuntime {
    fn default() -> Self {
        Self {
            stack: RwLock::new(None),
            secrets: RwLock::new(NativeChainSecrets::default()),
        }
    }
}

impl NativeChainRuntime {
    pub fn spawn(app_runtime: AppRuntime) -> Arc<Self> {
        let native = Arc::new(Self::default());
        let worker = native.clone();
        tauri::async_runtime::spawn(async move {
            let mut events = app_runtime.subscribe_events();
            worker.rebuild_from_app_state(&app_runtime.state()).await;
            loop {
                match events.recv().await {
                    Ok(AppEvent::NetworkChanged(_)) | Ok(AppEvent::ServersChanged) => {
                        worker.rebuild_from_app_state(&app_runtime.state()).await;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // A lag means we may have missed a network/source change;
                        // rebuild from the authoritative snapshot rather than
                        // guessing which event was lost.
                        worker.rebuild_from_app_state(&app_runtime.state()).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        native
    }

    pub async fn replace_secrets(&self, secrets: NativeChainSecrets, state: &AppState) {
        *self.secrets.write().await = secrets;
        self.rebuild_from_app_state(state).await;
    }

    pub async fn rebuild_from_app_state(&self, state: &AppState) {
        let (catalog, policy) = catalog_and_policy_from_app_state(state);
        let secrets = self.secrets.read().await.clone();
        let replacement =
            build_native_chain_stack(catalog, policy, &state.network.to_string(), &secrets).await;
        *self.stack.write().await = Some(replacement);
    }

    pub async fn with_service<T>(
        &self,
        f: impl FnOnce(&Arc<Mutex<ChainService>>) -> T,
    ) -> Option<T> {
        let guard = self.stack.read().await;
        guard.as_ref().map(|stack| f(&stack.service))
    }

    pub async fn failures(&self) -> Vec<NativeChainProbeFailure> {
        self.stack
            .read()
            .await
            .as_ref()
            .map(|stack| stack.failures.clone())
            .unwrap_or_default()
    }
}

/// Build concrete transports only for sources/routes permitted by policy.
/// Remote routes fail closed until a verified Tor-capable adapter is registered.
pub async fn build_native_chain_stack(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
) -> NativeChainStack {
    let tor_status = default_tor_status(&catalog, &policy).await;
    build_native_chain_stack_with_tor_status(catalog, policy, network, secrets, tor_status).await
}

async fn build_native_chain_stack_with_tor_status(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
    tor_status: TorStatus,
) -> NativeChainStack {
    let selected = selected_source_ids(&catalog, &policy);
    let sources = catalog.iter().cloned().collect::<Vec<_>>();
    let mut service = ChainService::new(catalog, policy.clone());
    let mut event_sources: Vec<Arc<dyn NativeChainEventSource>> = Vec::new();
    let mut failures = Vec::new();

    for source in sources {
        if !source.is_enabled() || !selected.contains(&source.id) {
            continue;
        }
        for endpoint in &source.endpoints {
            // Keep the chain runtime on the shared core privacy boundary:
            // loopback endpoints may dial directly. Existing
            // Electrum/BIP37/Neutrino adapters consume a verified SOCKS route;
            // the current full-node RPC/event adapters do not.
            if !is_loopback_host(&endpoint.host)
                && matches!(endpoint.kind, EndpointKind::BchnRpc | EndpointKind::BchnZmq)
            {
                record_remote_route_failure(
                    &mut failures,
                    &source,
                    endpoint,
                    &policy,
                    REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE,
                );
                continue;
            }

            let route = native_chain_route(endpoint, tor_status);
            if route.is_refused() {
                record_remote_route_failure(
                    &mut failures,
                    &source,
                    endpoint,
                    &policy,
                    REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE,
                );
                continue;
            }

            match endpoint.kind {
                EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp
                    if policy.protocols.contains(ProtocolFamily::Electrum) =>
                {
                    let Some(transport) = electrum_transport(endpoint, route) else {
                        record_remote_route_failure(
                            &mut failures,
                            &source,
                            endpoint,
                            &policy,
                            REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE,
                        );
                        continue;
                    };
                    match ElectrumBackend::connect(ElectrumConfig::new(
                        source.id.clone(),
                        endpoint.clone(),
                        transport,
                    ))
                    .await
                    {
                        Ok(provider) => service.register(Arc::new(provider)),
                        Err(error) => failures.push(failure(
                            &source,
                            ProtocolFamily::Electrum,
                            endpoint,
                            format!("{error:?}"),
                        )),
                    }
                }
                EndpointKind::BchP2p => {
                    if policy.protocols.contains(ProtocolFamily::Bip37) {
                        let mut config =
                            Bip37Config::new(source.id.clone(), endpoint.clone(), network);
                        if let TorRoute::Through { socks_port } = route {
                            config.transport = Bip37Transport::Tor {
                                proxy_host: crate::fusion::tor::DEFAULT_TOR_HOST.to_owned(),
                                proxy_port: socks_port,
                            };
                        }
                        match Bip37Backend::connect(config).await {
                            Ok(provider) => service.register(Arc::new(provider)),
                            Err(error) => failures.push(failure(
                                &source,
                                ProtocolFamily::Bip37,
                                endpoint,
                                format!("{error:?}"),
                            )),
                        }
                    }
                    if policy.protocols.contains(ProtocolFamily::Neutrino) {
                        let mut config =
                            NeutrinoConfig::new(source.id.clone(), endpoint.clone(), network);
                        if let TorRoute::Through { socks_port } = route {
                            config.transport = NeutrinoTransport::Tor {
                                proxy_host: crate::fusion::tor::DEFAULT_TOR_HOST.to_owned(),
                                proxy_port: socks_port,
                            };
                        }
                        match NeutrinoBackend::connect(config).await {
                            Ok(provider) => service.register(Arc::new(provider)),
                            Err(error) => failures.push(failure(
                                &source,
                                ProtocolFamily::Neutrino,
                                endpoint,
                                format!("{error:?}"),
                            )),
                        }
                    }
                }
                EndpointKind::BchnRpc if policy.protocols.contains(ProtocolFamily::BchnRpc) => {
                    let mut config = BchnRpcConfig::new(
                        source.id.clone(),
                        endpoint.clone(),
                        secrets.rpc_auth(&source.id),
                    );
                    config.txindex = secrets.rpc_txindex.contains(source.id.as_str());
                    config.https = secrets.rpc_https.contains(source.id.as_str());
                    match BchnRpcBackend::connect(config).await {
                        Ok(provider) => service.register(Arc::new(provider)),
                        Err(error) => failures.push(failure(
                            &source,
                            ProtocolFamily::BchnRpc,
                            endpoint,
                            format!("{error:?}"),
                        )),
                    }
                }
                EndpointKind::BchnZmq if policy.protocols.contains(ProtocolFamily::BchnZmq) => {
                    match BchnZmqEventSource::connect(BchnZmqConfig {
                        source_id: source.id.clone(),
                        endpoint: endpoint.clone(),
                    })
                    .await
                    {
                        Ok(provider) => event_sources.push(Arc::new(provider)),
                        Err(error) => failures.push(failure(
                            &source,
                            ProtocolFamily::BchnZmq,
                            endpoint,
                            format!("{error:?}"),
                        )),
                    }
                }
                _ => {}
            }
        }
    }

    NativeChainStack {
        service: Arc::new(Mutex::new(service)),
        event_sources,
        failures,
    }
}

fn failure(
    source: &ChainSource,
    protocol: ProtocolFamily,
    endpoint: &Endpoint,
    error: String,
) -> NativeChainProbeFailure {
    NativeChainProbeFailure {
        source: source.id.clone(),
        protocol,
        endpoint: endpoint.clone(),
        error,
    }
}

/// Compatibility bridge from the existing app-wide server settings into the
/// richer source catalog. Endpoints sharing a host are grouped into one source,
/// so a user-run node+Fulcrum installation naturally appears as one combined
/// source without inventing a generic "Home Server" name.
pub fn catalog_and_policy_from_app_state(state: &AppState) -> (SourceCatalog, ConnectionPolicy) {
    let mut by_host = BTreeMap::<String, ChainSource>::new();
    let network_servers = state.servers.for_network(state.network);

    // A legacy default is not yet a durable source-catalog choice. Do not open
    // a native provider connection until the user has explicitly configured a
    // route; bootstrap selection belongs to the persisted policy overlay.
    if let Some(electrum_entry) = network_servers.electrum.as_deref() {
        if let Ok(parsed) = parse_electrum_endpoint(electrum_entry, DEFAULT_WSS_PORT) {
            upsert_user_source(
                &mut by_host,
                parsed.host(),
                Endpoint {
                    kind: if parsed.encrypted() {
                        EndpointKind::ElectrumTls
                    } else {
                        EndpointKind::ElectrumTcp
                    },
                    host: parsed.host().to_owned(),
                    port: Some(parsed.port()),
                },
            );
        }
    }

    if let Some(peer_entry) = network_servers.peer.as_deref() {
        if let Ok(parsed) = parse_peer_endpoint(peer_entry, NODE_HINT_PORT) {
            upsert_user_source(
                &mut by_host,
                parsed.host(),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: parsed.host().to_owned(),
                    port: Some(parsed.port()),
                },
            );
        }
    }

    let mut catalog = SourceCatalog::default();
    for source in by_host.into_values() {
        // IDs are produced from unique normalized hosts, so duplicate insertion
        // is an internal bug rather than a user-facing condition.
        catalog
            .insert(source)
            .expect("host-grouped source ids are unique");
    }
    (catalog, ConnectionPolicy::auto())
}

fn upsert_user_source(by_host: &mut BTreeMap<String, ChainSource>, host: &str, endpoint: Endpoint) {
    let key = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let entry = by_host.entry(key.clone()).or_insert_with(|| ChainSource {
        id: SourceId::new(format!("host:{key}")),
        label: host.to_owned(),
        origin: SourceOrigin::UserAdded,
        endpoints: Vec::new(),
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority: 0,
    });
    if !entry.endpoints.contains(&endpoint) {
        entry.endpoints.push(endpoint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppAction, ServerKind};
    use optn_core::network::Network;
    use optn_runtime::chain::ProtocolSet;

    #[test]
    fn same_host_node_and_electrum_are_one_source_with_independent_routes() {
        let mut state = AppState::default();
        state.network = Network::Mainnet;
        state.apply(AppAction::SetServer {
            kind: ServerKind::Electrum,
            entry: "box.example:50002".into(),
        });
        state.apply(AppAction::SetServer {
            kind: ServerKind::Peer,
            entry: "box.example:8333".into(),
        });
        let (catalog, _) = catalog_and_policy_from_app_state(&state);
        let sources = catalog.iter().collect::<Vec<_>>();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "box.example");
        assert!(sources[0]
            .endpoints
            .iter()
            .any(|endpoint| endpoint.kind == EndpointKind::ElectrumTls));
        assert!(sources[0]
            .endpoints
            .iter()
            .any(|endpoint| endpoint.kind == EndpointKind::BchP2p));
    }

    #[test]
    fn default_state_has_no_native_route_before_a_source_is_configured() {
        let state = AppState::default();
        let (catalog, policy) = catalog_and_policy_from_app_state(&state);
        assert!(catalog.iter().next().is_none());
        assert!(build_selection_plan(&catalog, &policy).primary.is_empty());
    }

    #[test]
    fn native_direct_dial_reuses_the_core_loopback_rule() {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "127.13.9.2", "::1"] {
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: host.into(),
                port: Some(50002),
            };
            assert_eq!(
                native_chain_route(&endpoint, TorStatus::Absent),
                TorRoute::Direct,
                "{host}"
            );
        }
        for host in ["localhost.", "public.example", "192.168.1.2"] {
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: host.into(),
                port: Some(50002),
            };
            assert!(
                native_chain_route(&endpoint, TorStatus::Absent).is_refused(),
                "{host}"
            );
        }
    }

    #[test]
    fn verified_tor_route_is_used_for_remote_electrum() {
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "public.example".into(),
            port: Some(50002),
        };
        let route = native_chain_route(&endpoint, TorStatus::Verified { socks_port: 9050 });

        match electrum_transport(&endpoint, route).expect("verified route") {
            ElectrumTransport::Tor {
                proxy_host,
                proxy_port,
                username,
                password,
                tls,
            } => {
                assert_eq!(proxy_host, "127.0.0.1");
                assert_eq!(proxy_port, 9050);
                assert!(tls);
                assert_eq!(username, password);
                assert!(username.starts_with("optn-chain-"));
            }
            _ => panic!("remote endpoint must not use a direct Electrum transport"),
        }
    }

    #[tokio::test]
    async fn remote_routes_are_refused_before_any_native_dial() {
        let source_id = SourceId::new("remote");
        let endpoints = vec![
            Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "public.example".into(),
                port: Some(50002),
            },
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "public.example".into(),
                port: Some(8333),
            },
            Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "public.example".into(),
                port: Some(8332),
            },
            Endpoint {
                kind: EndpointKind::BchnZmq,
                host: "public.example".into(),
                port: Some(28332),
            },
        ];
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: source_id.clone(),
                label: "Remote source".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: endpoints.clone(),
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .expect("unique test source");
        let mut policy = ConnectionPolicy::auto();
        policy.protocols = ProtocolSet::all();

        let stack = build_native_chain_stack_with_tor_status(
            catalog,
            policy,
            "chipnet",
            &NativeChainSecrets::default(),
            TorStatus::Absent,
        )
        .await;

        assert!(stack.event_sources.is_empty());
        assert_eq!(
            stack
                .failures
                .iter()
                .map(|failure| (failure.protocol, failure.endpoint.clone()))
                .collect::<Vec<_>>(),
            vec![
                (ProtocolFamily::Electrum, endpoints[0].clone()),
                (ProtocolFamily::Bip37, endpoints[1].clone()),
                (ProtocolFamily::Neutrino, endpoints[1].clone()),
                (ProtocolFamily::BchnRpc, endpoints[2].clone()),
                (ProtocolFamily::BchnZmq, endpoints[3].clone()),
            ]
        );
        assert!(stack
            .failures
            .iter()
            .all(|failure| failure.source == source_id));
        assert!(stack.failures[..3]
            .iter()
            .all(|failure| { failure.error.as_str() == REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE }));
        assert!(stack.failures[3..].iter().all(|failure| {
            failure.error.as_str() == REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE
        }));
    }

    #[tokio::test]
    async fn remote_full_node_adapters_remain_fail_closed_even_with_tor() {
        let source_id = SourceId::new("remote-node");
        let endpoints = vec![
            Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "public.example".into(),
                port: Some(8332),
            },
            Endpoint {
                kind: EndpointKind::BchnZmq,
                host: "public.example".into(),
                port: Some(28332),
            },
        ];
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: source_id,
                label: "Remote node".into(),
                origin: SourceOrigin::UserInfrastructure {
                    group: "node".into(),
                },
                endpoints,
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .expect("unique test source");
        let mut policy = ConnectionPolicy::auto();
        policy.protocols = ProtocolSet::all();

        let stack = build_native_chain_stack_with_tor_status(
            catalog,
            policy,
            "chipnet",
            &NativeChainSecrets::default(),
            TorStatus::Verified { socks_port: 9050 },
        )
        .await;

        assert!(stack.event_sources.is_empty());
        assert_eq!(stack.failures.len(), 2);
        assert!(stack.failures.iter().all(|failure| {
            failure.error.as_str() == REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE
        }));
    }
}
