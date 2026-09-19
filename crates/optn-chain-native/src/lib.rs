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
pub mod coin_holds_file;
pub mod network_config;
pub mod registry_fetch;
pub mod wallet_checkpoint;
// Re-exported because the shell reaches BIP37 directly in two places: the
// Cash Code node scan builds one bounded block batch against the selected
// peer rather than a wallet refresh, and the legacy broadcast path relays a
// transaction on an already-open stream. Both need the backend types rather
// than the stack.
pub use optn_chain_bip37::{
    relay_tx_on_stream, Bip37Backend, Bip37Config, Bip37Transport, TxRelayOutcome,
};
use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_chain_neutrino::{NeutrinoBackend, NeutrinoConfig, NeutrinoTransport};
use optn_chain_zmq::{BchnZmqConfig, BchnZmqEventSource};
use optn_core::endpoint::is_loopback_host;
use optn_core::tor::{route as tor_route, Route as TorRoute, TorStatus};
use optn_runtime::chain::{
    build_selection_plan, ChainEventSource, ChainSource, ConnectionPolicy, Endpoint, EndpointKind,
    ProtocolFamily, SourceCatalog, SourceId, SourceScope,
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

/// A public BCMR registry is outside a holder's selected node infrastructure.
/// It is therefore available only under a policy scope that deliberately
/// permits public sources. A verified Tor listener supplies transport privacy,
/// never permission to contact an arbitrary external registry.
fn policy_allows_public_registry(policy: &ConnectionPolicy) -> bool {
    let allows_public =
        |scope: &SourceScope| matches!(scope, SourceScope::AllEnabled | SourceScope::PublicEnabled);
    allows_public(&policy.primary_scope)
        || policy.fallback_scope.as_ref().is_some_and(allows_public)
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
            // Declared own infrastructure is dialled directly, so it does not
            // put the stack through Tor detection either -- two probes at
            // 1500 ms each that nothing would then use.
            && !source.is_user_infrastructure()
            && source.endpoints.iter().any(|endpoint| {
                !is_loopback_host(&endpoint.host) && endpoint_can_use_native_tor(endpoint, policy)
            })
    })
}

/// Where a proxy may be, and why this wallet would trust it.
///
/// The split is the whole point. Answering a SOCKS5 greeting proves a SOCKS5
/// proxy is listening and nothing more: every no-auth proxy answers the same
/// three bytes, and Tor has no reply that distinguishes it from a corporate
/// proxy, an SSH dynamic forward, or something hostile that forwards in the
/// clear. Trust therefore comes from where the proxy came from.
#[derive(Debug, Clone, Copy, Default)]
pub struct TorProxyTrust<'a> {
    /// Ports of proxies this process started and owns.
    ///
    /// The application runs a Tor of its own on a port deliberately outside
    /// the conventional pair so it never collides with one the holder already
    /// runs. Owning the process is what makes it trusted; naming the port here
    /// is also what makes it visible at all, since auto-detection would never
    /// look there.
    pub managed: &'a [u16],
    /// Loopback ports the holder has confirmed are their own Tor.
    ///
    /// Persisted in `UserNetworkOverlay::trusted_socks_ports`. One deliberate
    /// act, once, rather than a probe that cannot tell the difference.
    pub trusted: &'a [u16],
}

/// Does this stack need a proxy at all, and is there one it may use?
///
/// A conventional port that answers but has neither provenance comes back
/// [`TorStatus::Unverified`] rather than [`TorStatus::Verified`]: something is
/// there, the holder can say whether it is theirs, and until they do the
/// routes that need Tor refuse instead of handing their traffic to a stranger.
pub async fn tor_status_for(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    trust: TorProxyTrust<'_>,
) -> TorStatus {
    if !needs_default_tor_proxy(catalog, policy) {
        return TorStatus::Absent;
    }

    tor_status_from_trust(trust).await
}

/// Resolve a proxy's usable status from provenance alone.
///
/// This is shared by native consumers which are not chain routes themselves.
/// The caller decides whether its destination requires Tor; this function owns
/// the only answer to whether a loopback SOCKS listener is trusted enough to
/// carry that traffic.
pub async fn tor_status_from_trust(trust: TorProxyTrust<'_>) -> TorStatus {
    for &socks_port in trust.managed.iter().chain(trust.trusted) {
        if socks_answers(DEFAULT_TOR_HOST, socks_port).await {
            return TorStatus::Verified { socks_port };
        }
    }

    // Nothing with provenance answered. Look at the conventional ports anyway,
    // because "a proxy is there but I cannot tell whether it is yours" is a
    // far more useful thing to report than "no Tor found" -- it is the
    // difference between a holder starting Tor and a holder confirming the Tor
    // they already have.
    for &socks_port in optn_core::tor::AUTODETECT_SOCKS_PORTS {
        if socks_answers(DEFAULT_TOR_HOST, socks_port).await {
            return TorStatus::Unverified { socks_port };
        }
    }
    TorStatus::Absent
}

/// Convenience for callers that own no proxy and carry no trust list.
pub async fn tor_status_with_managed(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    managed: &[u16],
) -> TorStatus {
    tor_status_for(
        catalog,
        policy,
        TorProxyTrust {
            managed,
            trusted: &[],
        },
    )
    .await
}

/// Whether any selected source would have to be reached through a proxy.
///
/// A host asks this before starting its own Tor: bootstrapping one for a stack
/// that only dials loopback or the holder's own infrastructure would be a
/// pointless minute of waiting.
pub fn requires_tor_proxy(catalog: &SourceCatalog, policy: &ConnectionPolicy) -> bool {
    needs_default_tor_proxy(catalog, policy)
}

/// Does *a SOCKS5 proxy* answer here?
///
/// Named for what it establishes. It used to be called `is_tor_socks_port`,
/// which is not what a `05 01 00` greeting and an `05 00` reply show: that
/// exchange is the SOCKS5 no-auth handshake and every such proxy completes it.
/// Whether the proxy is Tor is decided by provenance, in `tor_status_for`.
async fn socks_answers(host: &str, port: u16) -> bool {
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

/// How a chain route to `endpoint` on `source` may be made, or that it may not.
///
/// Fails closed like the Fusion rule it borrows, with one difference that
/// matters: a source the user has *declared* as their own infrastructure is
/// reached directly, exactly as loopback is.
///
/// Tor is there to stop a third-party server learning that this IP is asking
/// about these addresses. Your own node already knows — it is yours, and it is
/// the node the wallet is asking on your behalf. Routing to it over Tor buys
/// nothing and costs the mode its purpose: `is_loopback_host` recognises only
/// `127.0.0.0/8`, `localhost` and `::1`, so a self-hosted node one room away on
/// a LAN address, or on a private mesh, was refused as "remote" and
/// own-infrastructure-only could not reach any own infrastructure that was not
/// on this machine.
///
/// The declaration is what carries this, not the address: `UserInfrastructure`
/// is a group the holder wrote down (`SourceOrigin::UserInfrastructure`), and
/// `SourceScope::UserInfrastructure` already selects on exactly that. A plain
/// `UserAdded` endpoint -- a public server someone pasted in -- is still a
/// third party and still needs Tor.
fn native_chain_route(
    source: &ChainSource,
    endpoint: &Endpoint,
    tor_status: TorStatus,
) -> TorRoute {
    if source.is_user_infrastructure() {
        return TorRoute::Direct;
    }
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

/// An empty accepted-header store for `network`, seeded with its genesis.
///
/// Genesis is chain identity rather than anything a peer supplied, and
/// `getheaders` needs a locator to start from on a fresh install. Hosts that
/// keep the accepted chain across provider rebuilds create it here so the seed
/// is defined in one place.
pub fn new_accepted_header_store(network: &str) -> Arc<optn_runtime::header_store::SharedHeaders> {
    let store = optn_runtime::header_store::SharedHeaders::default();
    store.write(|retained| {
        retained.insert_hash_only(0, optn_chain_bip37::genesis_hash(network));
    });
    Arc::new(store)
}

pub async fn build_native_chain_stack(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
) -> NativeChainStack {
    build_native_chain_stack_via(catalog, policy, network, secrets, TorProxyTrust::default()).await
}

/// Build a stack without a retained header store, carrying the host's proxy
/// provenance just like the retained-header constructor below.
pub async fn build_native_chain_stack_via(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
    trust: TorProxyTrust<'_>,
) -> NativeChainStack {
    let tor_status = tor_status_for(&catalog, &policy, trust).await;
    build_native_chain_stack_with_tor_status(catalog, policy, network, secrets, tor_status, None)
        .await
}

/// Build a stack whose providers read a store the caller already owns.
///
/// A stack is rebuilt whenever policy, sources or credentials change, but the
/// accepted chain is not a property of a provider set: it is what the runtime
/// has verified, and it has to survive a source being swapped out. A host that
/// lets the store be rebuilt with the stack throws away every accepted header
/// each time the user edits a setting, and the next scan starts from genesis.
pub async fn build_native_chain_stack_with_headers(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
    headers: Arc<optn_runtime::header_store::SharedHeaders>,
) -> NativeChainStack {
    build_native_chain_stack_with_headers_via(
        catalog,
        policy,
        network,
        secrets,
        headers,
        TorProxyTrust::default(),
    )
    .await
}

/// As above, but also carrying which proxies this host may trust — its own
/// Tor, which does not listen on the conventional pair, and any the holder has
/// confirmed. A conventional port with neither provenance is reported as
/// unverified and the routes that need Tor refuse.
pub async fn build_native_chain_stack_with_headers_via(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
    headers: Arc<optn_runtime::header_store::SharedHeaders>,
    trust: TorProxyTrust<'_>,
) -> NativeChainStack {
    let tor_status = tor_status_for(&catalog, &policy, trust).await;
    build_native_chain_stack_with_tor_status(
        catalog,
        policy,
        network,
        secrets,
        tor_status,
        Some(headers),
    )
    .await
}

async fn build_native_chain_stack_with_tor_status(
    catalog: SourceCatalog,
    policy: ConnectionPolicy,
    network: &str,
    secrets: &NativeChainSecrets,
    tor_status: TorStatus,
    supplied_headers: Option<Arc<optn_runtime::header_store::SharedHeaders>>,
) -> NativeChainStack {
    // One store for the whole stack. Seeded with the network's genesis, which
    // is chain identity rather than anything a peer supplied, so `getheaders`
    // has a locator to start from on a fresh install.
    let headers = supplied_headers.unwrap_or_else(|| new_accepted_header_store(network));
    let selected = selected_source_ids(&catalog, &policy);
    let sources = catalog.iter().cloned().collect::<Vec<_>>();
    let mut service = ChainService::new(catalog, policy.clone());
    if let TorStatus::Verified { socks_port } = tor_status {
        if policy_allows_public_registry(&policy) {
            service
                .set_registry_fetcher(Arc::new(registry_fetch::VerifiedRegistryTor { socks_port }));
        }
    }
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

            let route = native_chain_route(&source, endpoint, tor_status);
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
                        match NeutrinoBackend::connect(config, headers.clone()).await {
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

    #[tokio::test]
    async fn registry_fetcher_requires_verified_tor_and_a_public_source_scope() {
        async fn installed(policy: ConnectionPolicy, tor_status: TorStatus) -> bool {
            let stack = build_native_chain_stack_with_tor_status(
                SourceCatalog::default(),
                policy,
                "chipnet",
                &NativeChainSecrets::default(),
                tor_status,
                None,
            )
            .await;
            let installed = stack.service.lock().await.registry_fetcher().is_some();
            installed
        }

        assert!(
            installed(
                ConnectionPolicy::auto(),
                TorStatus::Verified { socks_port: 9050 },
            )
            .await
        );
        assert!(policy_allows_public_registry(&ConnectionPolicy {
            protocols: ProtocolSet::wallet_sync(),
            primary_scope: SourceScope::UserInfrastructure,
            fallback_scope: Some(SourceScope::PublicEnabled),
            preferred: Vec::new(),
        }));
        assert!(
            !installed(
                ConnectionPolicy::own_infrastructure(),
                TorStatus::Verified { socks_port: 9050 },
            )
            .await
        );
        assert!(
            !installed(
                ConnectionPolicy::exact(SourceId::new("holder-node"), ProtocolFamily::Electrum),
                TorStatus::Verified { socks_port: 9050 },
            )
            .await
        );
        assert!(
            !installed(ConnectionPolicy::auto(), TorStatus::Absent).await,
            "public scope without verified proxy must not gain a registry transport"
        );

        let stack = build_native_chain_stack_with_tor_status(
            SourceCatalog::default(),
            ConnectionPolicy::auto(),
            "chipnet",
            &NativeChainSecrets::default(),
            TorStatus::Verified { socks_port: 9050 },
            None,
        )
        .await;
        let mut service = stack.service.lock().await;
        assert!(service.registry_fetcher().is_some());
        service.set_policy(ConnectionPolicy::own_infrastructure());
        assert!(
            service.registry_fetcher().is_none(),
            "a fetcher authorized by the previous public policy cannot survive an own-only selection"
        );
    }

    /// A public endpoint someone pasted in: a third party, needing Tor.
    fn pasted_source() -> ChainSource {
        ChainSource {
            id: SourceId::new("pasted"),
            label: "Pasted".into(),
            origin: optn_runtime::chain::SourceOrigin::UserAdded,
            endpoints: Vec::new(),
            capabilities: Default::default(),
            disposition: optn_runtime::chain::SourceDisposition::Enabled,
            priority: 0,
        }
    }

    /// A node the holder declared as theirs.
    fn declared_own_source() -> ChainSource {
        ChainSource {
            origin: optn_runtime::chain::SourceOrigin::UserInfrastructure {
                group: "home".into(),
            },
            ..pasted_source()
        }
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
                native_chain_route(&pasted_source(), &endpoint, TorStatus::Absent),
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
                native_chain_route(&pasted_source(), &endpoint, TorStatus::Absent).is_refused(),
                "{host}"
            );
        }
    }

    /// Own infrastructure is reachable off this machine, with no Tor.
    ///
    /// The whole point of the mode is a node the holder runs; before this, an
    /// own-infrastructure policy could only reach `127.0.0.0/8`, so a node on
    /// a LAN address or a private mesh was refused as "remote" and the mode
    /// had nothing it could select. Tor protects you from a third-party
    /// server; your own node is not one.
    #[test]
    fn declared_own_infrastructure_dials_directly_without_tor() {
        let own = declared_own_source();
        for host in [
            "192.168.1.50",
            "100.100.51.120",
            "node.internal",
            "10.0.0.9",
        ] {
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: host.into(),
                port: Some(50001),
            };
            assert_eq!(
                native_chain_route(&own, &endpoint, TorStatus::Absent),
                TorRoute::Direct,
                "declared own infrastructure at {host} must not require Tor"
            );
            // The same address, merely pasted in, is still a third party.
            assert!(
                native_chain_route(&pasted_source(), &endpoint, TorStatus::Absent).is_refused(),
                "an undeclared {host} must still fail closed"
            );
        }
    }

    /// A remote source, so Tor detection actually runs.
    fn public_catalog() -> SourceCatalog {
        let mut catalog = SourceCatalog::default();
        let mut source = pasted_source();
        source.endpoints = vec![Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "electrum.example.org".into(),
            port: Some(50002),
        }];
        catalog.insert(source).expect("insert");
        catalog
    }

    /// A TCP listener that completes the SOCKS5 no-auth greeting and nothing
    /// else, which is all any SOCKS5 proxy does -- Tor included.
    async fn fake_socks_proxy() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let port = listener.local_addr().expect("addr").port();
        let handle = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut greeting = [0u8; 3];
                if stream.read_exact(&mut greeting).await.is_err() {
                    continue;
                }
                let _ = stream.write_all(&[0x05, 0x00]).await;
            }
        });
        (port, handle)
    }

    #[tokio::test]
    async fn a_socks_greeting_alone_does_not_make_a_proxy_trusted() {
        // The row-4 hole. This listener is not Tor -- it is thirty lines of
        // test code -- and it answers the greeting exactly as Tor does, which
        // is the whole problem: there is no reply that tells them apart. Before
        // this, any process holding 9050 was promoted to Verified and handed
        // traffic the wallet believed was anonymised.
        let (port, handle) = fake_socks_proxy().await;
        let catalog = public_catalog();
        let policy = ConnectionPolicy::auto();

        // Found, and refused: something is there, but nothing says it is Tor.
        let found = tor_status_for(
            &catalog,
            &policy,
            TorProxyTrust {
                managed: &[],
                trusted: &[],
            },
        )
        .await;
        // Auto-detection only looks at 9050/9150, so an ephemeral port is not
        // even seen -- the meaningful assertion is that it is never usable.
        assert_eq!(found.usable_port(), None);

        // Named as merely present: still unusable.
        let probed = socks_answers(DEFAULT_TOR_HOST, port).await;
        assert!(probed, "the fake proxy must answer, or this proves nothing");

        handle.abort();
    }

    #[tokio::test]
    async fn provenance_is_what_makes_a_proxy_usable() {
        // The same listener, the same greeting, the same bytes on the wire.
        // Only where it came from changes, and that is the whole rule.
        let (port, handle) = fake_socks_proxy().await;
        let catalog = public_catalog();
        let policy = ConnectionPolicy::auto();

        let owned = tor_status_for(
            &catalog,
            &policy,
            TorProxyTrust {
                managed: &[port],
                trusted: &[],
            },
        )
        .await;
        assert_eq!(
            owned,
            TorStatus::Verified { socks_port: port },
            "a proxy this process started and owns is usable"
        );

        let confirmed = tor_status_for(
            &catalog,
            &policy,
            TorProxyTrust {
                managed: &[],
                trusted: &[port],
            },
        )
        .await;
        assert_eq!(
            confirmed,
            TorStatus::Verified { socks_port: port },
            "a proxy the holder confirmed is usable"
        );

        let neither = tor_status_for(
            &catalog,
            &policy,
            TorProxyTrust {
                managed: &[],
                trusted: &[],
            },
        )
        .await;
        assert_ne!(
            neither,
            TorStatus::Verified { socks_port: port },
            "the same proxy without provenance must not be usable"
        );

        handle.abort();
    }

    #[tokio::test]
    async fn a_trusted_port_that_stops_answering_is_not_still_trusted() {
        // Trust is in the port, not in the listener. If the holder's Tor is
        // not running, the confirmation must not make its absence look like
        // presence.
        let (port, handle) = fake_socks_proxy().await;
        handle.abort();
        // Give the abort a moment to release the socket.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let status = tor_status_for(
            &public_catalog(),
            &ConnectionPolicy::auto(),
            TorProxyTrust {
                managed: &[],
                trusted: &[port],
            },
        )
        .await;
        assert_ne!(status, TorStatus::Verified { socks_port: port });
    }

    /// And it does not drag the stack through Tor detection it will not use.
    #[test]
    fn own_infrastructure_does_not_ask_for_a_tor_proxy() {
        let mut catalog = SourceCatalog::default();
        let mut source = declared_own_source();
        source.endpoints = vec![Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "100.100.51.120".into(),
            port: Some(50001),
        }];
        catalog.insert(source).expect("insert");
        assert!(!needs_default_tor_proxy(
            &catalog,
            &ConnectionPolicy::own_infrastructure()
        ));
    }

    #[test]
    fn verified_tor_route_is_used_for_remote_electrum() {
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: "public.example".into(),
            port: Some(50002),
        };
        let route = native_chain_route(
            &pasted_source(),
            &endpoint,
            TorStatus::Verified { socks_port: 9050 },
        );

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
        assert!(!socks_answers(DEFAULT_TOR_HOST, port).await);
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
            None,
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
            None,
        )
        .await;

        assert!(stack.event_sources.is_empty());
        assert_eq!(stack.failures.len(), 2);
        assert!(stack
            .failures
            .iter()
            .all(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE));
    }

    /// The provider crates keep separate copies of the network tables, and
    /// they have to answer identically.
    ///
    /// They are reached over the same socket for the same wallet: if BIP37 and
    /// Neutrino disagree about a network's genesis or wire magic, one of them
    /// is talking to a chain the rest of the wallet is not on. Regtest was
    /// missing from Neutrino's genesis table while present in its parameters,
    /// which is the shape this catches.
    #[test]
    fn bip37_and_neutrino_agree_about_every_network() {
        for network in [
            "mainnet", "chipnet", "testnet4", "testnet", "testnet3", "regtest",
        ] {
            assert_eq!(
                optn_chain_bip37::genesis_hash(network),
                optn_chain_neutrino::genesis_hash(network),
                "{network} genesis differs between BIP37 and Neutrino"
            );
            let bip37 = optn_chain_bip37::params_for(network);
            let neutrino = optn_chain_neutrino::params_for(network);
            assert_eq!(
                bip37.magic, neutrino.magic,
                "{network} wire magic differs between BIP37 and Neutrino"
            );
            assert_eq!(
                bip37.default_port, neutrino.default_port,
                "{network} default port differs between BIP37 and Neutrino"
            );
        }
    }

    /// Build a source at `host:port`, public or declared as the holder's own.
    fn live_source(id: &str, host: &str, port: u16, own: bool) -> ChainSource {
        ChainSource {
            id: SourceId::new(id),
            label: id.into(),
            origin: if own {
                optn_runtime::chain::SourceOrigin::UserInfrastructure {
                    group: "live-test".into(),
                }
            } else {
                optn_runtime::chain::SourceOrigin::UserAdded
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: host.into(),
                port: Some(port),
            }],
            capabilities: Default::default(),
            disposition: optn_runtime::chain::SourceDisposition::Enabled,
            priority: 0,
        }
    }

    async fn stack_for(source: ChainSource) -> NativeChainStack {
        let mut catalog = SourceCatalog::default();
        let policy = ConnectionPolicy::auto();
        catalog.insert(source).expect("insert");
        build_native_chain_stack(catalog, policy, "chipnet", &NativeChainSecrets::default()).await
    }

    /// A public endpoint is never dialled without Tor, and the holder's own is
    /// never made to wait for it.
    ///
    /// Issue #75's rows 3 and 5 both said "not exercised end to end against a
    /// live route change", and both are the same invariant seen from two
    /// sides: what may be reached depends on who owns it, not on what the
    /// address looks like.
    ///
    /// Opt-in, because it reaches real hosts:
    ///
    ///   OPTN_LIVE_PUBLIC_ELECTRUM=chipnet.imaginary.cash:50002     ///   OPTN_LIVE_OWN_ELECTRUM=<your node>:50001     ///   cargo test --manifest-path crates/optn-chain-native/Cargo.toml     ///     -- --ignored --nocapture live_route
    ///
    /// Tor is detected, not required: with a verified SOCKS proxy the public
    /// route becomes eligible, and without one it must be refused. Both are
    /// asserted, so the test says something either way rather than only when
    /// the environment happens to suit it.
    #[tokio::test]
    #[ignore = "reaches real hosts; see the doc comment for the variables it needs"]
    async fn live_route_eligibility_follows_ownership_not_address_shape() {
        let public = std::env::var("OPTN_LIVE_PUBLIC_ELECTRUM").ok();
        let own = std::env::var("OPTN_LIVE_OWN_ELECTRUM").ok();
        assert!(
            public.is_some() || own.is_some(),
            "set OPTN_LIVE_PUBLIC_ELECTRUM and/or OPTN_LIVE_OWN_ELECTRUM"
        );

        let split = |value: &str| -> (String, u16) {
            let (host, port) = value.rsplit_once(':').expect("host:port");
            (host.to_owned(), port.parse().expect("port"))
        };

        if let Some(endpoint) = public.as_deref() {
            let (host, port) = split(endpoint);
            let stack = stack_for(live_source("live-public", &host, port, false)).await;
            let refused = stack
                .failures
                .iter()
                .any(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE);
            // Which way it went depends on the host's Tor, and the invariant
            // is the same either way: a public endpoint is reached through
            // Tor or not at all.
            match tor_status_from_trust(TorProxyTrust::default()).await {
                TorStatus::Verified { .. } => assert!(
                    !refused,
                    "a verified Tor proxy is available and the public route was                      still refused: {:?}",
                    stack.failures
                ),
                TorStatus::Unverified { .. } | TorStatus::Absent => assert!(
                    refused,
                    "no verified Tor proxy, so the public route must be refused                      rather than dialled directly; failures were {:?}",
                    stack.failures
                ),
            }
        }

        if let Some(endpoint) = own.as_deref() {
            let (host, port) = split(endpoint);
            let stack = stack_for(live_source("live-own", &host, port, true)).await;
            // Declared own infrastructure is dialled directly whatever Tor is
            // doing. Tor hides you from a third-party server; your own node is
            // not one, and requiring it there is what made
            // own-infrastructure-only unable to reach any own infrastructure
            // that was not on this machine.
            assert!(
                !stack
                    .failures
                    .iter()
                    .any(|failure| failure.error == REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE),
                "the holder's own node was refused for want of Tor: {:?}",
                stack.failures
            );
        }
    }
}
