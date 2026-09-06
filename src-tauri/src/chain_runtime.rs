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
use optn_chain_bip37::{Bip37Backend, Bip37Config};
use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_chain_neutrino::{NeutrinoBackend, NeutrinoConfig};
use optn_chain_zmq::{BchnZmqConfig, BchnZmqEventSource};
use optn_core::endpoint::{
    parse_electrum_endpoint, parse_peer_endpoint, DEFAULT_WSS_PORT, NODE_HINT_PORT,
};
use optn_runtime::chain::{
    build_selection_plan, BootstrapProject, CapabilitySet, ChainEventSource, ChainSource,
    ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily, SourceCatalog, SourceDisposition,
    SourceId, SourceOrigin,
};
use optn_runtime::chain_service::ChainService;
use optn_runtime::events::ChainEventStream;
use optn_runtime::AppRuntime;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// Shell-only BCHN RPC settings. Credentials deliberately never enter portable
/// network configuration or renderer state.
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
pub async fn build_native_chain_stack(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
) -> NativeChainStack {
    let selection = build_selection_plan(&catalog, &policy);
    let selected = selection
        .primary
        .iter()
        .chain(selection.fallback.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let sources = catalog.iter().cloned().collect::<Vec<_>>();
    let mut service = ChainService::new(catalog, policy.clone());
    let mut event_sources: Vec<Arc<dyn NativeChainEventSource>> = Vec::new();
    let mut failures = Vec::new();

    for source in sources {
        if !source.is_enabled() || !selected.contains(&source.id) {
            continue;
        }
        for endpoint in &source.endpoints {
            match endpoint.kind {
                EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp
                    if policy.protocols.contains(ProtocolFamily::Electrum) =>
                {
                    let transport = if endpoint.kind == EndpointKind::ElectrumTls {
                        ElectrumTransport::Tls
                    } else {
                        ElectrumTransport::Tcp
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
                        match Bip37Backend::connect(Bip37Config::new(
                            source.id.clone(),
                            endpoint.clone(),
                            network,
                        ))
                        .await
                        {
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
                        match NeutrinoBackend::connect(NeutrinoConfig::new(
                            source.id.clone(),
                            endpoint.clone(),
                            network,
                        ))
                        .await
                        {
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

    let electrum_entry = state.servers.effective_electrum(state.network);
    if let Ok(parsed) = parse_electrum_endpoint(&electrum_entry, DEFAULT_WSS_PORT) {
        let custom = network_servers.electrum.is_some();
        upsert_host_source(
            &mut by_host,
            parsed.host(),
            custom,
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

    if let Some(peer_entry) = network_servers.peer.as_deref() {
        if let Ok(parsed) = parse_peer_endpoint(peer_entry, NODE_HINT_PORT) {
            upsert_host_source(
                &mut by_host,
                parsed.host(),
                true,
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

fn upsert_host_source(
    by_host: &mut BTreeMap<String, ChainSource>,
    host: &str,
    custom: bool,
    endpoint: Endpoint,
) {
    let key = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let origin = if custom {
        SourceOrigin::UserAdded
    } else {
        SourceOrigin::Bootstrap {
            project: BootstrapProject::FulcrumPeerNetwork,
            provenance: "OPTN network default Electrum endpoint".into(),
        }
    };
    let entry = by_host.entry(key.clone()).or_insert_with(|| ChainSource {
        id: SourceId::new(format!("host:{key}")),
        label: host.to_owned(),
        origin: origin.clone(),
        endpoints: Vec::new(),
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority: if custom { 0 } else { 100 },
    });
    if custom {
        entry.origin = SourceOrigin::UserAdded;
        entry.priority = 0;
    }
    if !entry.endpoints.contains(&endpoint) {
        entry.endpoints.push(endpoint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppAction, ServerKind};
    use optn_core::network::Network;

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
    fn default_label_is_the_real_host_not_a_generic_home_server_name() {
        let state = AppState::default();
        let (catalog, _) = catalog_and_policy_from_app_state(&state);
        let source = catalog.iter().next().expect("default electrum source");
        assert_eq!(source.label, state.network.default_host());
    }
}
