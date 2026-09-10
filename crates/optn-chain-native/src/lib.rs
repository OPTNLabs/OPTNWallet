#![forbid(unsafe_code)]

//! Tauri-free concrete chain adapters for issue #75's provider-neutral runtime.
//!
//! The shell owns concrete network transports and secrets; `optn-runtime` owns
//! routing, policy, evidence, and authoritative wallet state. A configured
//! endpoint is never probed unless it is inside the active source/protocol
//! policy. BCH P2P endpoints are independently probed for BIP37 and Neutrino so
//! a node can gain or lose either capability without changing the shared source
//! model. Tauri and the CLI build this same stack.

use optn_chain_bchn::{BchnRpcBackend, BchnRpcConfig, RpcAuth};
pub mod network_config;
pub mod wallet_checkpoint;
use optn_chain_bip37::{Bip37Backend, Bip37Config, Bip37Transport};
use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_chain_neutrino::{NeutrinoBackend, NeutrinoConfig, NeutrinoTransport};
use optn_chain_zmq::{BchnZmqConfig, BchnZmqEventSource};
use optn_core::endpoint::is_loopback_host;
use optn_core::tor::{route as tor_route, Route as TorRoute, TorStatus};
use optn_runtime::chain::{
    build_selection_plan, ChainEventSource, ChainSource, ConnectionPolicy, Endpoint, EndpointKind,
    ProtocolFamily, SourceCatalog, SourceId,
};
use optn_runtime::chain_service::ChainService;
use optn_runtime::events::ChainEventStream;
use rand_core::{OsRng, RngCore};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

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
    /// The accepted block headers every provider in this stack reads.
    ///
    /// Owned here rather than by any provider: the runtime writes verified
    /// headers into it, and BIP37 and Neutrino both hold read handles on the
    /// same store instead of keeping chains of their own.
    pub headers: Arc<optn_runtime::header_store::SharedHeaders>,
    pub revocation: optn_runtime::chain_service::ChainRevocation,
    pub service: Arc<Mutex<ChainService>>,
    pub event_sources: Vec<Arc<dyn NativeChainEventSource>>,
    pub failures: Vec<NativeChainProbeFailure>,
    /// A persisted source policy was unreadable or could not be resolved.
    /// No provider is registered in this state, so callers cannot fall back to
    /// a different route behind the user's back.
    pub configuration_error: Option<String>,
}

impl NativeChainStack {
    pub fn unavailable(error: impl Into<String>) -> Self {
        let service = ChainService::new(SourceCatalog::default(), ConnectionPolicy::auto());
        Self {
            // Empty rather than seeded: no provider is registered in this
            // state, so nothing should be able to read a header from it.
            headers: Arc::new(optn_runtime::header_store::SharedHeaders::default()),
            revocation: service.revocation(),
            service: Arc::new(Mutex::new(service)),
            event_sources: Vec::new(),
            failures: Vec::new(),
            configuration_error: Some(error.into()),
        }
    }
}

const REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE: &str =
    "remote native chain route requires a verified Tor SOCKS proxy";
const REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE: &str =
    "remote native chain route has no verified Tor-capable native adapter";
const DEFAULT_TOR_HOST: &str = "127.0.0.1";
const TOR_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

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
    // the shared network overlay owns custom proxy configuration.
    for &socks_port in optn_core::tor::AUTODETECT_SOCKS_PORTS {
        if is_tor_socks_port(DEFAULT_TOR_HOST, socks_port).await {
            return TorStatus::Verified { socks_port };
        }
    }
    TorStatus::Absent
}

async fn is_tor_socks_port(host: &str, port: u16) -> bool {
    let probe = async {
        let mut stream = TcpStream::connect((host, port)).await.ok()?;
        stream.write_all(&[0x05, 0x01, 0x00]).await.ok()?;
        let mut response = [0u8; 2];
        stream.read_exact(&mut response).await.ok()?;
        Some(response == [0x05, 0x00])
    };
    matches!(
        tokio::time::timeout(TOR_PROBE_TIMEOUT, probe).await,
        Ok(Some(true))
    )
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
                proxy_host: DEFAULT_TOR_HOST.to_owned(),
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
    // One store for the whole stack. Seeded with the network's genesis, which
    // is chain identity rather than anything a peer supplied, so `getheaders`
    // has a locator to start from on a fresh install.
    let headers = {
        let store = optn_runtime::header_store::SharedHeaders::default();
        store.write(|retained| {
            retained.insert_hash_only(0, optn_chain_bip37::genesis_hash(network));
        });
        Arc::new(store)
    };
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
                        optn_chain_bip37::genesis_hash(network),
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
                                proxy_host: DEFAULT_TOR_HOST.to_owned(),
                                proxy_port: socks_port,
                            };
                        }
                        match Bip37Backend::connect(config, headers.clone()).await {
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
                                proxy_host: DEFAULT_TOR_HOST.to_owned(),
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
        headers,
        revocation: service.revocation(),
        service: Arc::new(Mutex::new(service)),
        event_sources,
        failures,
        configuration_error: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::ProtocolSet;

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
                assert_eq!(proxy_host, DEFAULT_TOR_HOST);
                assert_eq!(proxy_port, 9050);
                assert!(tls);
                assert_eq!(username, password);
                assert!(username.starts_with("optn-chain-"));
            }
            _ => panic!("remote endpoint must not use a direct Electrum transport"),
        }
    }

    #[tokio::test]
    async fn plain_tcp_listener_is_not_a_tor_socks_proxy() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0u8; 3];
                let _ = stream.read_exact(&mut request).await;
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
            }
        });
        assert!(!is_tor_socks_port(DEFAULT_TOR_HOST, port).await);
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
                origin: optn_runtime::chain::SourceOrigin::UserAdded,
                endpoints: endpoints.clone(),
                capabilities: Default::default(),
                disposition: optn_runtime::chain::SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
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
            .all(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE));
        assert!(stack.failures[3..]
            .iter()
            .all(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE));
    }

    #[tokio::test]
    async fn remote_full_node_adapters_remain_fail_closed_even_with_tor() {
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
                id: SourceId::new("remote-node"),
                label: "Remote node".into(),
                origin: optn_runtime::chain::SourceOrigin::UserInfrastructure {
                    group: "node".into(),
                },
                endpoints,
                capabilities: Default::default(),
                disposition: optn_runtime::chain::SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
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
        assert!(stack
            .failures
            .iter()
            .all(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE));
    }
}
