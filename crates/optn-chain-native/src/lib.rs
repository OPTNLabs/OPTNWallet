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
pub mod discovered_peers_file;
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
    ProtocolFamily, SourceCatalog, SourceId, SourceScope, TransportPolicy,
};
use optn_runtime::chain_service::{ChainBackend, ChainOperation, ChainService};
use optn_runtime::events::ChainEventStream;
use rand_core::{OsRng, RngCore};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
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
    pub fn from_credentials(
        credentials: Vec<optn_runtime::rpc_credentials::LoadedRpcCredential>,
    ) -> Self {
        let mut secrets = Self::default();
        for credential in credentials {
            secrets.set_rpc_basic_auth(
                &credential.source,
                &credential.endpoint,
                credential.username.expose(),
                credential.password.expose(),
            );
        }
        secrets
    }

    pub fn set_rpc_basic_auth(
        &mut self,
        source: &SourceId,
        endpoint: &Endpoint,
        username: impl Into<String>,
        password: impl Into<String>,
    ) {
        self.rpc_auth.insert(
            rpc_endpoint_binding(source, endpoint),
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

    /// Add persisted authentication without discarding host-probed settings.
    /// The endpoint-bound map prevents a source row with another RPC endpoint
    /// from inheriting the credential while the source-level compatibility
    /// flags retain their existing semantics.
    pub fn merge(&mut self, other: Self) {
        self.rpc_auth.extend(other.rpc_auth);
        self.rpc_txindex.extend(other.rpc_txindex);
        self.rpc_https.extend(other.rpc_https);
    }

    fn rpc_auth(&self, source: &SourceId, endpoint: &Endpoint) -> RpcAuth {
        self.rpc_auth
            .get(&rpc_endpoint_binding(source, endpoint))
            .cloned()
            .unwrap_or(RpcAuth::None)
    }
}

/// Source ids identify a catalog row, while an RPC password identifies one
/// endpoint. A row may carry more than one RPC endpoint, so source-only keys
/// would let a later endpoint inherit credentials intended for another node.
fn rpc_endpoint_binding(source: &SourceId, endpoint: &Endpoint) -> String {
    format!(
        "{}\u{0}bchn-rpc\u{0}{}\u{0}{}",
        source.as_str(),
        endpoint
            .host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase(),
        endpoint.port.unwrap_or_default(),
    )
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
    /// Last proxy observation used to build this stack, not a new connectivity check.
    pub tor_status: Option<TorStatus>,
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
    /// Electrum servers the connected servers advertised and the catalog does
    /// not already hold (#75 §21.3). Hints for the host to keep, never routes
    /// of this stack.
    pub discovered_peers: Vec<optn_runtime::bootstrap::DiscoveredPeer>,
    /// Selected Electrum servers held back for failover.
    pub held_back: HeldBackServers,
}

impl NativeChainStack {
    pub fn unavailable(error: impl Into<String>) -> Self {
        let service = ChainService::new(SourceCatalog::default(), ConnectionPolicy::auto());
        let revocation = service.revocation();
        let service = Arc::new(Mutex::new(service));
        Self {
            tor_status: None,
            // Empty rather than seeded: no provider is registered in this
            // state, so nothing should be able to read a header from it.
            headers: Arc::new(optn_runtime::header_store::SharedHeaders::default()),
            revocation: revocation.clone(),
            held_back: HeldBackServers::none(service.clone(), revocation),
            service,
            event_sources: Vec::new(),
            failures: Vec::new(),
            configuration_error: Some(error.into()),
            discovered_peers: Vec::new(),
        }
    }
}

/// Discovered servers dialled in one build when nothing else connected.
const MAX_FAILOVER_ATTEMPTS: usize = 3;

/// Keep what a connected Electrum server says about its peers: TLS names, and
/// onions only while Tor carries public traffic. Bounded, without repeats, and
/// without servers the catalog already has.
fn note_advertised_peers(
    provider: &ElectrumBackend,
    source: &ChainSource,
    allow_onion: bool,
    known: &[Endpoint],
    into: &mut Vec<optn_runtime::bootstrap::DiscoveredPeer>,
) {
    use optn_runtime::bootstrap::MAX_DISCOVERED_PEERS;
    for endpoint in optn_chain_electrum::advertised_peers(
        &provider.server_info().peers,
        allow_onion,
        MAX_DISCOVERED_PEERS,
    ) {
        if into.len() >= MAX_DISCOVERED_PEERS {
            return;
        }
        let already = known.iter().any(|existing| {
            existing.kind == endpoint.kind
                && existing.port == endpoint.port
                && existing
                    .host
                    .trim_end_matches('.')
                    .eq_ignore_ascii_case(&endpoint.host)
        });
        if !already && into.iter().all(|peer| peer.endpoint != endpoint) {
            into.push(optn_runtime::bootstrap::DiscoveredPeer {
                endpoint,
                advertised_by: source.id.clone(),
            });
        }
    }
}

const REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE: &str =
    "remote native chain route requires a verified Tor SOCKS proxy";
const REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE: &str =
    "remote native chain route has no verified Tor-capable native adapter";
const REMOTE_FULL_NODE_LOCAL_ONLY: &str =
    "remote full-node RPC and ZMQ are unavailable; only a node on this machine is used";
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

/// The configured metadata origins of `kind` this policy selects, each with
/// whether it is the holder's declared infrastructure.
fn configured_metadata_origins(
    catalog: &SourceCatalog,
    policy: &ConnectionPolicy,
    kind: EndpointKind,
) -> Vec<(url::Url, bool)> {
    let plan = optn_runtime::chain::build_endpoint_selection_plan(catalog, policy, kind);
    plan.primary
        .iter()
        .chain(&plan.fallback)
        .filter_map(|id| catalog.get(id))
        .flat_map(|source| {
            let own_infrastructure = source.is_user_infrastructure();
            source
                .endpoints
                .iter()
                .map(move |endpoint| (endpoint, own_infrastructure))
        })
        .filter(|(endpoint, _)| endpoint.kind == kind)
        .filter_map(|(endpoint, own_infrastructure)| {
            let mut url = url::Url::parse("https://gateway.invalid/").ok()?;
            url.set_host(Some(&endpoint.host)).ok()?;
            url.set_port(endpoint.port).ok()?;
            Some((url, own_infrastructure))
        })
        .take(16)
        .collect()
}

/// How registry and IPFS bytes from an origin of this ownership are fetched.
///
/// Registry URIs never name loopback (`registry_fetch` refuses `localhost` and
/// IP literals), so only ownership and the transport decide.
fn registry_route(
    transport: TransportPolicy,
    own_infrastructure: bool,
    tor_status: TorStatus,
) -> registry_fetch::RegistryRoute {
    if !transport.tor_for(own_infrastructure) {
        return registry_fetch::RegistryRoute::Direct { own_infrastructure };
    }
    match tor_status.usable_port() {
        Some(socks_port) => {
            registry_fetch::RegistryRoute::Tor(registry_fetch::VerifiedRegistryTor { socks_port })
        }
        None => registry_fetch::RegistryRoute::TorUnavailable,
    }
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
    let transport = policy.transport;
    let selected = selected_source_ids(catalog, policy);
    // A registry named on chain is a third party wherever it is hosted. Asked
    // only once some source is selected: with none, no identity can resolve,
    // and an idle install must not wait on Tor detection.
    if !selected.is_empty() && policy_allows_public_registry(policy) && transport.tor_for(false) {
        return true;
    }
    // Configured gateways and indexers follow the rule like any source.
    if [
        EndpointKind::IpfsGatewayHttps,
        EndpointKind::BcmrIndexerHttps,
    ]
    .into_iter()
    .flat_map(|kind| configured_metadata_origins(catalog, policy, kind))
    .any(|(_, own_infrastructure)| transport.tor_for(own_infrastructure))
    {
        return true;
    }
    catalog.iter().any(|source| {
        source.is_enabled()
            && selected.contains(&source.id)
            // A source the transport reaches directly does not put the stack
            // through Tor detection either -- two probes at 1500 ms each that
            // nothing would then use.
            && source.endpoints.iter().any(|endpoint| {
                transport.requires_tor(source.is_user_infrastructure(), &endpoint.host)
                    && endpoint_can_use_native_tor(endpoint, policy)
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
/// The holder's transport policy decides (#75 §4.1); ownership is one input
/// to it, never a rule of its own. Loopback is always direct.
///
/// - **Tor on** (the default): a source the holder *declared* as their own is
///   reached directly, exactly as loopback is. Tor is there to stop a
///   third-party server learning that this IP is asking about these
///   addresses; their own node already knows. `is_loopback_host` recognises
///   only `127.0.0.0/8`, `localhost` and `::1`, so without this a self-hosted
///   node one room away on a LAN address, or on a private mesh, would be
///   refused as "remote".
/// - **Tor off**: nothing is proxied.
///
/// The declaration is what carries ownership, not the address:
/// `UserInfrastructure` is a group the holder wrote down
/// (`SourceOrigin::UserInfrastructure`), and `SourceScope::UserInfrastructure`
/// already selects on exactly that. A plain `UserAdded` endpoint -- a public
/// server someone pasted in -- is still a third party.
///
/// Wherever Tor is required this fails closed like the Fusion rule it borrows:
/// no verified Tor, no route, and never a quiet direct one.
fn native_chain_route(
    source: &ChainSource,
    endpoint: &Endpoint,
    transport: TransportPolicy,
    tor_status: TorStatus,
) -> TorRoute {
    if !transport.requires_tor(source.is_user_infrastructure(), &endpoint.host) {
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
    let plan = build_selection_plan(&catalog, &policy);
    let enabled = |ids: &[SourceId]| -> Vec<ChainSource> {
        ids.iter()
            .filter_map(|id| catalog.get(id))
            .filter(|source| source.is_enabled())
            .cloned()
            .collect()
    };
    let (primary, fallback) = (enabled(&plan.primary), enabled(&plan.fallback));
    // Discovered servers are failover (#75 §21.6): after every other source,
    // in their own order, and dialled only while no Electrum route connected.
    let mut discovered: Vec<ChainSource> = primary
        .iter()
        .chain(fallback.iter())
        .filter(|source| optn_runtime::bootstrap::is_discovered(source))
        .cloned()
        .collect();
    discovered.sort_by_key(|source| source.priority);
    let known_endpoints: Vec<Endpoint> = catalog
        .iter()
        .filter(|source| !optn_runtime::bootstrap::is_discovered(source))
        .flat_map(|source| source.endpoints.iter().cloned())
        .collect();
    let allow_onion = policy.transport.tor_for(false) && tor_status.usable_port().is_some();
    let mut service = ChainService::new(catalog, policy.clone());
    {
        // Each metadata origin is reached as the transport says for its owner.
        let routed = |kind| {
            configured_metadata_origins(service.catalog(), &policy, kind)
                .into_iter()
                .map(|(origin, own_infrastructure)| {
                    let route = registry_route(policy.transport, own_infrastructure, tor_status);
                    (origin, route)
                })
                .collect::<Vec<_>>()
        };
        let fetcher = registry_fetch::ConfiguredRegistryFetcher::new(
            routed(EndpointKind::IpfsGatewayHttps),
            routed(EndpointKind::BcmrIndexerHttps),
            policy_allows_public_registry(&policy)
                .then(|| registry_route(policy.transport, false, tor_status)),
        );
        if fetcher.can_fetch() {
            service.set_registry_fetcher(Arc::new(fetcher));
        }
    }
    let mut build = StackBuild {
        service,
        event_sources: Vec::new(),
        failures: Vec::new(),
        discovered_peers: Vec::new(),
        known_endpoints,
        allow_onion,
        wallet_routes: 0,
        electrum_routes: 0,
    };
    let mut held_back = VecDeque::new();

    // Primary sources first, in plan order; fallback sources only when no
    // primary source gave a wallet route, so a public fallback never sees a
    // handshake while the holder's own node is serving (#75 §21).
    let tiers = [
        (primary, Some(&policy.primary_scope)),
        (fallback, policy.fallback_scope.as_ref()),
    ];
    for (tier, (sources, scope)) in tiers.into_iter().enumerate() {
        if tier > 0 && build.wallet_routes > 0 {
            break;
        }
        let mut jobs = Vec::new();
        for source in sources
            .iter()
            .filter(|source| !optn_runtime::bootstrap::is_discovered(source))
        {
            jobs.extend(plan_connect_jobs(
                source,
                &policy,
                secrets,
                network,
                tor_status,
                &mut build.failures,
            ));
        }
        let (electrum, others): (Vec<_>, Vec<_>) = jobs
            .into_iter()
            .partition(|job| matches!(job.kind, ConnectKind::Electrum(_)));
        let mut electrum = VecDeque::from(electrum);
        // Where the app chooses among public servers, a few are dialled and
        // the rest held back for failover. Servers the holder named are all
        // dialled.
        let bounded = scope.is_some_and(|scope| {
            matches!(scope, SourceScope::AllEnabled | SourceScope::PublicEnabled)
        });
        let first = if bounded {
            electrum.len().min(ELECTRUM_BATCH)
        } else {
            electrum.len()
        };
        let mut batch: Vec<ConnectJob> = others;
        batch.extend(electrum.drain(..first));
        build.absorb(connect_jobs(batch, network, &headers).await);
        while build.electrum_routes == 0 && !electrum.is_empty() {
            let next = electrum.len().min(ELECTRUM_BATCH);
            build.absorb(connect_jobs(electrum.drain(..next).collect(), network, &headers).await);
        }
        held_back.extend(electrum);
    }

    // One discovered server at a time, so a working one stops the search.
    for source in discovered.iter().take(MAX_FAILOVER_ATTEMPTS) {
        if build.electrum_routes > 0 {
            break;
        }
        let jobs = plan_connect_jobs(
            source,
            &policy,
            secrets,
            network,
            tor_status,
            &mut build.failures,
        );
        build.absorb(connect_jobs(jobs, network, &headers).await);
    }

    let revocation = build.service.revocation();
    let service = Arc::new(Mutex::new(build.service));
    NativeChainStack {
        tor_status: Some(tor_status),
        headers: headers.clone(),
        revocation: revocation.clone(),
        held_back: HeldBackServers::new(held_back, service.clone(), revocation, network, headers),
        service,
        event_sources: build.event_sources,
        failures: build.failures,
        configuration_error: None,
        discovered_peers: build.discovered_peers,
    }
}

/// Connects in flight at once while a stack is built.
const MAX_CONCURRENT_CONNECTS: usize = 6;
/// Electrum servers dialled at a time where the app chooses among public ones.
const ELECTRUM_BATCH: usize = MAX_FAILOVER_ATTEMPTS;

/// One provider to connect, decided without I/O.
#[derive(Clone)]
struct ConnectJob {
    source: ChainSource,
    endpoint: Endpoint,
    kind: ConnectKind,
}

#[derive(Clone)]
enum ConnectKind {
    Electrum(ElectrumTransport),
    Bip37(Box<Bip37Config>),
    Neutrino(Box<NeutrinoConfig>),
    Rpc(Box<BchnRpcConfig>),
    Zmq(Box<BchnZmqConfig>),
}

impl ConnectKind {
    const fn protocol(&self) -> ProtocolFamily {
        match self {
            Self::Electrum(_) => ProtocolFamily::Electrum,
            Self::Bip37(_) => ProtocolFamily::Bip37,
            Self::Neutrino(_) => ProtocolFamily::Neutrino,
            Self::Rpc(_) => ProtocolFamily::BchnRpc,
            Self::Zmq(_) => ProtocolFamily::BchnZmq,
        }
    }
}

enum Connected {
    Electrum(Box<ElectrumBackend>),
    Chain(Arc<dyn ChainBackend>),
    Events(Arc<dyn NativeChainEventSource>),
}

/// What a stack has gathered while it is being built.
struct StackBuild {
    service: ChainService,
    event_sources: Vec<Arc<dyn NativeChainEventSource>>,
    failures: Vec<NativeChainProbeFailure>,
    discovered_peers: Vec<optn_runtime::bootstrap::DiscoveredPeer>,
    known_endpoints: Vec<Endpoint>,
    allow_onion: bool,
    wallet_routes: usize,
    electrum_routes: usize,
}

impl StackBuild {
    /// Register what connected and record what did not, in plan order.
    fn absorb(&mut self, results: Vec<(ConnectJob, Result<Connected, String>)>) {
        for (job, result) in results {
            match result {
                Ok(Connected::Electrum(provider)) => {
                    note_advertised_peers(
                        &provider,
                        &job.source,
                        self.allow_onion,
                        &self.known_endpoints,
                        &mut self.discovered_peers,
                    );
                    self.electrum_routes += 1;
                    if provider.supports(ChainOperation::WalletRefresh) {
                        self.wallet_routes += 1;
                    }
                    self.service
                        .register(Arc::<ElectrumBackend>::from(provider));
                }
                Ok(Connected::Chain(provider)) => {
                    if provider.supports(ChainOperation::WalletRefresh) {
                        self.wallet_routes += 1;
                    }
                    self.service.register(provider);
                }
                Ok(Connected::Events(source)) => self.event_sources.push(source),
                Err(error) => self.failures.push(failure(
                    &job.source,
                    job.kind.protocol(),
                    &job.endpoint,
                    error,
                )),
            }
        }
    }
}

/// The providers `source` asks for under this policy. Endpoints that cannot
/// be used here are recorded as failures, with a reason the holder can act on.
fn plan_connect_jobs(
    source: &ChainSource,
    policy: &ConnectionPolicy,
    secrets: &NativeChainSecrets,
    network: &str,
    tor_status: TorStatus,
    failures: &mut Vec<NativeChainProbeFailure>,
) -> Vec<ConnectJob> {
    let mut jobs = Vec::new();
    for endpoint in &source.endpoints {
        // Full-node RPC and ZMQ are used on this machine only, whatever the
        // transport: their adapters cannot use a proxy, and RPC credentials
        // are kept for loopback endpoints alone (`optn_runtime::rpc_credentials`).
        // The reason names what the holder can change.
        if !is_loopback_host(&endpoint.host)
            && matches!(endpoint.kind, EndpointKind::BchnRpc | EndpointKind::BchnZmq)
        {
            let reason = if policy
                .transport
                .requires_tor(source.is_user_infrastructure(), &endpoint.host)
            {
                REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE
            } else {
                REMOTE_FULL_NODE_LOCAL_ONLY
            };
            record_remote_route_failure(failures, source, endpoint, policy, reason);
            continue;
        }

        let route = native_chain_route(source, endpoint, policy.transport, tor_status);
        if route.is_refused() {
            record_remote_route_failure(
                failures,
                source,
                endpoint,
                policy,
                REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE,
            );
            continue;
        }
        let job = |kind| ConnectJob {
            source: source.clone(),
            endpoint: endpoint.clone(),
            kind,
        };

        match endpoint.kind {
            EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp
                if policy.protocols.contains(ProtocolFamily::Electrum) =>
            {
                match electrum_transport(endpoint, route) {
                    Some(transport) => jobs.push(job(ConnectKind::Electrum(transport))),
                    None => record_remote_route_failure(
                        failures,
                        source,
                        endpoint,
                        policy,
                        REMOTE_NATIVE_CHAIN_TOR_UNAVAILABLE,
                    ),
                }
            }
            EndpointKind::BchP2p => {
                if policy.protocols.contains(ProtocolFamily::Bip37) {
                    let mut config = Bip37Config::new(source.id.clone(), endpoint.clone(), network);
                    if let TorRoute::Through { socks_port } = route {
                        config.transport = Bip37Transport::Tor {
                            proxy_host: DEFAULT_TOR_HOST.to_owned(),
                            proxy_port: socks_port,
                        };
                    }
                    jobs.push(job(ConnectKind::Bip37(Box::new(config))));
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
                    jobs.push(job(ConnectKind::Neutrino(Box::new(config))));
                }
            }
            EndpointKind::BchnRpc if policy.protocols.contains(ProtocolFamily::BchnRpc) => {
                let mut config = BchnRpcConfig::new(
                    source.id.clone(),
                    endpoint.clone(),
                    secrets.rpc_auth(&source.id, endpoint),
                );
                config.txindex = secrets.rpc_txindex.contains(source.id.as_str());
                config.https = secrets.rpc_https.contains(source.id.as_str());
                jobs.push(job(ConnectKind::Rpc(Box::new(config))));
            }
            EndpointKind::BchnZmq if policy.protocols.contains(ProtocolFamily::BchnZmq) => {
                jobs.push(job(ConnectKind::Zmq(Box::new(BchnZmqConfig {
                    source_id: source.id.clone(),
                    endpoint: endpoint.clone(),
                }))));
            }
            _ => {}
        }
    }
    jobs
}

/// Connect `jobs`, several at once, and return each with its result in the
/// order given. A hung peer delays only its own slot, not every source
/// behind it.
async fn connect_jobs(
    jobs: Vec<ConnectJob>,
    network: &str,
    headers: &Arc<optn_runtime::header_store::SharedHeaders>,
) -> Vec<(ConnectJob, Result<Connected, String>)> {
    let mut running = tokio::task::JoinSet::new();
    let mut waiting = jobs.into_iter().enumerate();
    let mut finished = Vec::new();
    loop {
        while running.len() < MAX_CONCURRENT_CONNECTS {
            let Some((index, job)) = waiting.next() else {
                break;
            };
            let network = network.to_owned();
            let headers = headers.clone();
            running.spawn(async move {
                let result = connect_job(job.clone(), &network, headers).await;
                (index, job, result)
            });
        }
        match running.join_next().await {
            Some(Ok(done)) => finished.push(done),
            // A provider that panicked while connecting fails the build, as it
            // did when connects ran one after another.
            Some(Err(error)) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Some(Err(_)) => {}
            None => break,
        }
    }
    finished.sort_by_key(|(index, ..)| *index);
    finished
        .into_iter()
        .map(|(_, job, result)| (job, result))
        .collect()
}

async fn connect_job(
    job: ConnectJob,
    network: &str,
    headers: Arc<optn_runtime::header_store::SharedHeaders>,
) -> Result<Connected, String> {
    match job.kind {
        ConnectKind::Electrum(transport) => ElectrumBackend::connect(ElectrumConfig::new(
            job.source.id.clone(),
            job.endpoint.clone(),
            transport,
            optn_chain_bip37::genesis_hash(network),
        ))
        .await
        .map(|provider| Connected::Electrum(Box::new(provider)))
        .map_err(|error| format!("{error:?}")),
        ConnectKind::Bip37(config) => Bip37Backend::connect(*config, headers)
            .await
            .map(|provider| Connected::Chain(Arc::new(provider)))
            .map_err(|error| format!("{error:?}")),
        ConnectKind::Neutrino(config) => NeutrinoBackend::connect(*config, headers)
            .await
            .map(|provider| Connected::Chain(Arc::new(provider)))
            .map_err(|error| format!("{error:?}")),
        ConnectKind::Rpc(config) => BchnRpcBackend::connect(*config)
            .await
            .map(|provider| Connected::Chain(Arc::new(provider)))
            .map_err(|error| format!("{error:?}")),
        ConnectKind::Zmq(config) => BchnZmqEventSource::connect(*config)
            .await
            .map(|provider| Connected::Events(Arc::new(provider)))
            .map_err(|error| format!("{error:?}")),
    }
}

/// Selected Electrum servers a build did not dial because enough others
/// connected (#75 §21). When the stack has no wallet route left, the next few
/// are dialled into the same service, so the wallet fails over without a
/// rebuild and without every public server seeing a handshake up front.
#[derive(Clone)]
pub struct HeldBackServers {
    inner: Arc<HeldBackInner>,
}

struct HeldBackInner {
    jobs: Mutex<VecDeque<ConnectJob>>,
    service: Arc<Mutex<ChainService>>,
    revocation: optn_runtime::chain_service::ChainRevocation,
    network: String,
    headers: Arc<optn_runtime::header_store::SharedHeaders>,
}

impl HeldBackServers {
    fn new(
        jobs: VecDeque<ConnectJob>,
        service: Arc<Mutex<ChainService>>,
        revocation: optn_runtime::chain_service::ChainRevocation,
        network: &str,
        headers: Arc<optn_runtime::header_store::SharedHeaders>,
    ) -> Self {
        Self {
            inner: Arc::new(HeldBackInner {
                jobs: Mutex::new(jobs),
                service,
                revocation,
                network: network.to_owned(),
                headers,
            }),
        }
    }

    /// Nothing held back: for a stack that dials everything it selects.
    pub fn none(
        service: Arc<Mutex<ChainService>>,
        revocation: optn_runtime::chain_service::ChainRevocation,
    ) -> Self {
        Self::new(
            VecDeque::new(),
            service,
            revocation,
            "",
            Arc::new(optn_runtime::header_store::SharedHeaders::default()),
        )
    }

    /// How many servers are still held back.
    pub async fn remaining(&self) -> usize {
        self.inner.jobs.lock().await.len()
    }

    /// Dial the next few held-back servers into the service, unless the stack
    /// was retired, and say how many connected.
    pub async fn connect_next(&self) -> usize {
        if self.inner.revocation.is_revoked() {
            return 0;
        }
        let batch: Vec<ConnectJob> = {
            let mut jobs = self.inner.jobs.lock().await;
            let next = jobs.len().min(ELECTRUM_BATCH);
            jobs.drain(..next).collect()
        };
        if batch.is_empty() {
            return 0;
        }
        let results = connect_jobs(batch, &self.inner.network, &self.inner.headers).await;
        if self.inner.revocation.is_revoked() {
            return 0;
        }
        let mut service = self.inner.service.lock().await;
        let mut connected = 0;
        for (_, result) in results {
            match result {
                Ok(Connected::Electrum(provider)) => {
                    service.register(Arc::<ElectrumBackend>::from(provider));
                    connected += 1;
                }
                Ok(Connected::Chain(provider)) => {
                    service.register(provider);
                    connected += 1;
                }
                Ok(Connected::Events(_)) | Err(_) => {}
            }
        }
        connected
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
    async fn configured_metadata_uses_source_policy_without_becoming_chain_provider() {
        for kind in [
            EndpointKind::IpfsGatewayHttps,
            EndpointKind::BcmrIndexerHttps,
        ] {
            use optn_runtime::chain::{build_endpoint_selection_plan, SourceDisposition};
            use optn_runtime::network_config::{add_user_source_services, UserNetworkOverlay};
            let mut overlay = UserNetworkOverlay::default();
            let own = add_user_source_services(
                &mut overlay,
                "My gateway",
                vec![Endpoint {
                    kind,
                    host: "gateway.example".into(),
                    port: Some(443),
                }],
                Some("home"),
            )
            .unwrap();
            let public = add_user_source_services(
                &mut overlay,
                "Other gateway",
                vec![Endpoint {
                    kind,
                    host: "public.example".into(),
                    port: Some(8443),
                }],
                None,
            )
            .unwrap();
            let mut catalog = SourceCatalog::default();
            for source in overlay.user_sources {
                catalog.insert(source).unwrap();
            }
            let mut policy = ConnectionPolicy::own_infrastructure();
            policy.preferred = vec![public.clone()];
            assert_eq!(
                configured_metadata_origins(&catalog, &policy, kind)
                    .iter()
                    .map(|(origin, own)| (origin.as_str(), *own))
                    .collect::<Vec<_>>(),
                vec![("https://gateway.example/", true)]
            );
            assert!(build_selection_plan(&catalog, &policy).primary.is_empty());
            // The holder's own gateway is reached directly, so it needs no
            // Tor; a public one would.
            assert!(!requires_tor_proxy(&catalog, &policy));
            policy.fallback_scope = Some(SourceScope::PublicEnabled);
            let plan = build_endpoint_selection_plan(&catalog, &policy, kind);
            assert_eq!(plan.primary, vec![own.clone()]);
            assert_eq!(plan.fallback, vec![public.clone()]);
            catalog.get_mut(&public).unwrap().disposition = SourceDisposition::Banned;
            assert_eq!(
                configured_metadata_origins(&catalog, &policy, kind).len(),
                1
            );
            policy.fallback_scope = None;
            let stack = build_native_chain_stack_with_tor_status(
                catalog.clone(),
                policy.clone(),
                "chipnet",
                &NativeChainSecrets::default(),
                TorStatus::Absent,
                None,
            )
            .await;
            let service = stack.service.lock().await;
            let fetcher = service
                .registry_fetcher()
                .expect("own gateway installs a direct metadata transport");
            assert!(
                fetcher
                    .fetch(
                        "https://publisher.example/registry.json",
                        Default::default()
                    )
                    .await
                    .is_err(),
                "own-only must not dial arbitrary publishers"
            );
            drop(service);
            catalog.get_mut(&own).unwrap().disposition = SourceDisposition::Disabled;
            assert!(configured_metadata_origins(&catalog, &policy, kind).is_empty());
            assert!(!requires_tor_proxy(&catalog, &policy));
        }
    }

    #[tokio::test]
    async fn registry_fetcher_needs_a_public_scope_and_a_route_the_transport_allows() {
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
            transport: Default::default(),
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
        let mut direct = ConnectionPolicy::auto();
        direct.transport = TransportPolicy::Direct;
        assert!(
            installed(direct, TorStatus::Absent).await,
            "a direct transport needs no Tor to reach public registries"
        );
        let mut own_direct = ConnectionPolicy::own_infrastructure();
        own_direct.transport = TransportPolicy::Direct;
        assert!(
            !installed(own_direct, TorStatus::Absent).await,
            "a direct transport is not permission to reach public registries"
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
                native_chain_route(
                    &pasted_source(),
                    &endpoint,
                    TransportPolicy::default(),
                    TorStatus::Absent
                ),
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
                native_chain_route(
                    &pasted_source(),
                    &endpoint,
                    TransportPolicy::default(),
                    TorStatus::Absent
                )
                .is_refused(),
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
                native_chain_route(
                    &own,
                    &endpoint,
                    TransportPolicy::default(),
                    TorStatus::Absent
                ),
                TorRoute::Direct,
                "declared own infrastructure at {host} must not require Tor"
            );
            // The same address, merely pasted in, is still a third party.
            assert!(
                native_chain_route(
                    &pasted_source(),
                    &endpoint,
                    TransportPolicy::default(),
                    TorStatus::Absent
                )
                .is_refused(),
                "an undeclared {host} must still fail closed"
            );
        }
    }

    /// The transport, not ownership, decides how each source is reached.
    #[test]
    fn the_transport_decides_how_each_source_is_reached() {
        let tor = TorStatus::Verified { socks_port: 9050 };
        let through = TorRoute::Through { socks_port: 9050 };
        let remote = Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "192.168.1.50".into(),
            port: Some(50001),
        };
        let local = Endpoint {
            host: "127.0.0.1".into(),
            ..remote.clone()
        };
        for (transport, own, public) in [
            (TransportPolicy::Tor, TorRoute::Direct, through),
            (TransportPolicy::Direct, TorRoute::Direct, TorRoute::Direct),
        ] {
            assert_eq!(
                native_chain_route(&declared_own_source(), &remote, transport, tor),
                own,
                "{transport:?}"
            );
            assert_eq!(
                native_chain_route(&pasted_source(), &remote, transport, tor),
                public,
                "{transport:?}"
            );
            // Loopback has no hop to hide, whatever the transport.
            for source in [declared_own_source(), pasted_source()] {
                assert_eq!(
                    native_chain_route(&source, &local, transport, tor),
                    TorRoute::Direct,
                    "{transport:?}"
                );
            }
        }
        // Requiring Tor without a trusted one refuses; it never falls back.
        assert!(native_chain_route(
            &pasted_source(),
            &remote,
            TransportPolicy::Tor,
            TorStatus::Absent
        )
        .is_refused());
        assert!(native_chain_route(
            &pasted_source(),
            &remote,
            TransportPolicy::default(),
            TorStatus::Unverified { socks_port: 9050 }
        )
        .is_refused());
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
    fn the_transport_decides_whether_the_stack_needs_tor_at_all() {
        let mut policy = ConnectionPolicy::auto();
        assert!(needs_default_tor_proxy(&public_catalog(), &policy));
        policy.transport = TransportPolicy::Direct;
        assert!(
            !needs_default_tor_proxy(&public_catalog(), &policy),
            "a direct transport never waits for Tor"
        );
        // Registries named on chain are third parties: a policy that permits
        // public sources wants Tor for them even when every selected chain
        // source is the holder's own.
        policy.transport = TransportPolicy::default();
        let mut own_only = SourceCatalog::default();
        let mut own = declared_own_source();
        own.endpoints = vec![Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "100.100.51.120".into(),
            port: Some(50001),
        }];
        own_only.insert(own).expect("insert");
        assert!(needs_default_tor_proxy(&own_only, &policy));
        assert!(!needs_default_tor_proxy(
            &own_only,
            &ConnectionPolicy::own_infrastructure()
        ));
        // With nothing selected nothing can resolve, and an idle install does
        // not wait on Tor detection.
        assert!(!needs_default_tor_proxy(&SourceCatalog::default(), &policy));
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
            TransportPolicy::default(),
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
    async fn remote_full_node_adapters_remain_fail_closed_whatever_the_transport() {
        use optn_runtime::chain::SourceOrigin;
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
        let own = || SourceOrigin::UserInfrastructure {
            group: "node".into(),
        };
        for (origin, transport, reason) in [
            // Tor is required here, and these adapters cannot use it.
            (
                SourceOrigin::UserAdded,
                TransportPolicy::default(),
                REMOTE_NATIVE_CHAIN_TOR_ADAPTER_UNAVAILABLE,
            ),
            // No Tor is required, and remote full-node RPC is still not used.
            (
                own(),
                TransportPolicy::default(),
                REMOTE_FULL_NODE_LOCAL_ONLY,
            ),
            (
                SourceOrigin::UserAdded,
                TransportPolicy::Direct,
                REMOTE_FULL_NODE_LOCAL_ONLY,
            ),
        ] {
            let mut catalog = SourceCatalog::default();
            catalog
                .insert(ChainSource {
                    id: SourceId::new("remote-node"),
                    label: "Remote node".into(),
                    origin,
                    endpoints: endpoints.clone(),
                    capabilities: Default::default(),
                    disposition: optn_runtime::chain::SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
            let mut policy = ConnectionPolicy::auto();
            policy.protocols = ProtocolSet::all();
            policy.transport = transport;

            let stack = build_native_chain_stack_with_tor_status(
                catalog,
                policy,
                "chipnet",
                &NativeChainSecrets::default(),
                TorStatus::Verified { socks_port: 9050 },
                None,
            )
            .await;

            assert!(stack.event_sources.is_empty(), "{transport:?}");
            assert_eq!(stack.failures.len(), 2, "{transport:?}");
            assert!(
                stack.failures.iter().all(|failure| failure.error == reason),
                "{transport:?}: {:?}",
                stack.failures
            );
        }
    }

    /// An Electrum server on loopback that answers the handshake for chipnet
    /// and advertises `peers`.
    async fn fake_electrum(peers: serde_json::Value) -> (u16, tokio::task::JoinHandle<()>) {
        let (port, handle, _) = counting_electrum(peers).await;
        (port, handle)
    }

    /// As [`fake_electrum`], counting the connections it accepts.
    async fn counting_electrum(
        peers: serde_json::Value,
    ) -> (
        u16,
        tokio::task::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut genesis = optn_chain_bip37::genesis_hash("chipnet");
        genesis.reverse();
        let genesis = hex::encode(genesis);
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        let handle = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let genesis = genesis.clone();
                let peers = peers.clone();
                tokio::spawn(async move {
                    let (read, mut write) = tokio::io::split(stream);
                    let mut lines = tokio::io::BufReader::new(read).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let request: serde_json::Value =
                            serde_json::from_str(&line).unwrap_or_default();
                        let result = match request["method"].as_str() {
                            Some("server.version") => serde_json::json!(["Fulcrum test", "1.5"]),
                            Some("server.features") => {
                                serde_json::json!({ "genesis_hash": genesis })
                            }
                            Some("server.peers.subscribe") => peers.clone(),
                            _ => serde_json::Value::Null,
                        };
                        let reply = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": request["id"],
                            "result": result,
                        });
                        if write
                            .write_all(format!("{reply}\n").as_bytes())
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        (port, handle, accepted)
    }

    /// A public (or the holder's own) Electrum source on loopback TCP.
    fn tcp_source(id: &str, port: u16, own: bool) -> ChainSource {
        ChainSource {
            id: SourceId::new(id),
            origin: if own {
                optn_runtime::chain::SourceOrigin::UserInfrastructure {
                    group: "home".into(),
                }
            } else {
                optn_runtime::chain::SourceOrigin::UserAdded
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            }],
            ..pasted_source()
        }
    }

    fn dialled(counters: &[Arc<std::sync::atomic::AtomicUsize>]) -> usize {
        counters
            .iter()
            .filter(|counter| counter.load(std::sync::atomic::Ordering::SeqCst) > 0)
            .count()
    }

    /// Where the app chooses among public servers, a build dials a few and
    /// holds the rest back, rather than handshaking with every one (#75).
    #[tokio::test]
    async fn a_build_dials_a_few_public_servers_and_holds_the_rest_back() {
        let mut catalog = SourceCatalog::default();
        let (mut servers, mut counters) = (Vec::new(), Vec::new());
        for index in 0..21 {
            let (port, handle, counter) = counting_electrum(serde_json::json!([])).await;
            servers.push(handle);
            counters.push(counter);
            catalog
                .insert(tcp_source(&format!("s{index:02}"), port, false))
                .unwrap();
        }
        let stack = build_native_chain_stack_with_tor_status(
            catalog,
            ConnectionPolicy::auto(),
            "chipnet",
            &NativeChainSecrets::default(),
            TorStatus::Absent,
            None,
        )
        .await;
        assert!(stack.failures.is_empty(), "{:?}", stack.failures);
        assert_eq!(dialled(&counters), ELECTRUM_BATCH);
        // The first ones in the plan's order.
        assert!(counters[..ELECTRUM_BATCH]
            .iter()
            .all(|counter| counter.load(std::sync::atomic::Ordering::SeqCst) > 0));
        assert_eq!(stack.held_back.remaining().await, 21 - ELECTRUM_BATCH);
        assert!(!stack
            .service
            .lock()
            .await
            .routes_for_operation(ChainOperation::WalletRefresh)
            .is_empty());

        // Held back, then dialled into the same service when asked.
        assert_eq!(stack.held_back.connect_next().await, ELECTRUM_BATCH);
        assert_eq!(dialled(&counters), 2 * ELECTRUM_BATCH);
        assert_eq!(stack.held_back.remaining().await, 21 - 2 * ELECTRUM_BATCH);
        // A retired stack dials nothing more.
        stack.revocation.revoke();
        assert_eq!(stack.held_back.connect_next().await, 0);
        assert_eq!(dialled(&counters), 2 * ELECTRUM_BATCH);
        for server in servers {
            server.abort();
        }
    }

    /// When the first few hang up, the build carries on to the next few in
    /// order until one connects.
    #[tokio::test]
    async fn a_build_fails_over_past_servers_that_hang_up() {
        let mut catalog = SourceCatalog::default();
        let (mut servers, mut counters) = (Vec::new(), Vec::new());
        for index in 0..ELECTRUM_BATCH {
            let (port, handle) = hang_up().await;
            servers.push(handle);
            catalog
                .insert(tcp_source(&format!("s{index:02}"), port, false))
                .unwrap();
        }
        for index in ELECTRUM_BATCH..10 {
            let (port, handle, counter) = counting_electrum(serde_json::json!([])).await;
            servers.push(handle);
            counters.push(counter);
            catalog
                .insert(tcp_source(&format!("s{index:02}"), port, false))
                .unwrap();
        }
        let stack = build_native_chain_stack_with_tor_status(
            catalog,
            ConnectionPolicy::auto(),
            "chipnet",
            &NativeChainSecrets::default(),
            TorStatus::Absent,
            None,
        )
        .await;
        let failed: Vec<_> = stack
            .failures
            .iter()
            .map(|failure| failure.source.as_str().to_owned())
            .collect();
        assert_eq!(failed, ["s00", "s01", "s02"]);
        assert_eq!(dialled(&counters), ELECTRUM_BATCH);
        assert_eq!(stack.held_back.remaining().await, 10 - 2 * ELECTRUM_BATCH);
        for server in servers {
            server.abort();
        }
    }

    /// A public fallback sees no handshake while the holder's own node serves,
    /// and is used when it does not.
    #[tokio::test]
    async fn a_public_fallback_is_dialled_only_when_the_own_node_is_down() {
        let policy = ConnectionPolicy {
            fallback_scope: Some(SourceScope::PublicEnabled),
            ..ConnectionPolicy::own_infrastructure()
        };
        let secrets = NativeChainSecrets::default();
        let build = |catalog| {
            build_native_chain_stack_with_tor_status(
                catalog,
                policy.clone(),
                "chipnet",
                &secrets,
                TorStatus::Absent,
                None,
            )
        };
        let (public_port, public_server, public) = counting_electrum(serde_json::json!([])).await;

        let (own_port, own_server, own) = counting_electrum(serde_json::json!([])).await;
        let mut catalog = SourceCatalog::default();
        catalog.insert(tcp_source("own", own_port, true)).unwrap();
        catalog
            .insert(tcp_source("public", public_port, false))
            .unwrap();
        let stack = build(catalog).await;
        assert!(stack.failures.is_empty(), "{:?}", stack.failures);
        assert!(own.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert_eq!(public.load(std::sync::atomic::Ordering::SeqCst), 0);

        let (down_port, down_server) = hang_up().await;
        let mut catalog = SourceCatalog::default();
        catalog.insert(tcp_source("own", down_port, true)).unwrap();
        catalog
            .insert(tcp_source("public", public_port, false))
            .unwrap();
        let stack = build(catalog).await;
        assert_eq!(stack.failures.len(), 1, "{:?}", stack.failures);
        assert!(public.load(std::sync::atomic::Ordering::SeqCst) > 0);
        assert!(!stack
            .service
            .lock()
            .await
            .routes_for_operation(ChainOperation::WalletRefresh)
            .is_empty());
        for server in [public_server, own_server, down_server] {
            server.abort();
        }
    }

    /// A loopback port that accepts and hangs up, so a dial fails at once.
    async fn hang_up() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                drop(stream);
            }
        });
        (port, handle)
    }

    /// Discovered servers are failover (#75 §21.6): untouched while another
    /// Electrum route works, a bounded few in order when none does. What a
    /// working server advertises comes back for the host to keep.
    #[tokio::test]
    async fn discovered_servers_are_bounded_failover_and_peer_lists_are_kept() {
        use optn_runtime::bootstrap::{stable_source_id, with_discovered_peers, DiscoveredPeer};
        let electrum = |port| Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "127.0.0.1".into(),
            port: Some(port),
        };
        let mut servers = Vec::new();
        let mut peers = Vec::new();
        for _ in 0..5 {
            let (port, handle) = hang_up().await;
            servers.push(handle);
            peers.push(DiscoveredPeer {
                endpoint: electrum(port),
                advertised_by: SourceId::new("pasted"),
            });
        }
        let catalog_with = |port| {
            let mut catalog = SourceCatalog::default();
            let mut source = pasted_source();
            source.endpoints = vec![electrum(port)];
            catalog.insert(source).unwrap();
            with_discovered_peers(catalog, &peers)
        };
        let secrets = NativeChainSecrets::default();
        let build = |catalog| {
            build_native_chain_stack_with_tor_status(
                catalog,
                ConnectionPolicy::auto(),
                "chipnet",
                &secrets,
                TorStatus::Absent,
                None,
            )
        };

        // Nothing else connects: three discovered servers, in their order.
        let (dead, handle) = hang_up().await;
        servers.push(handle);
        let stack = build(catalog_with(dead)).await;
        let tried: Vec<_> = stack
            .failures
            .iter()
            .map(|failure| failure.source.clone())
            .collect();
        let expected: Vec<_> = std::iter::once(SourceId::new("pasted"))
            .chain(
                peers
                    .iter()
                    .take(MAX_FAILOVER_ATTEMPTS)
                    .map(|peer| SourceId::new(stable_source_id(&peer.endpoint))),
            )
            .collect();
        assert_eq!(tried, expected);

        // A working route: no discovered server is dialled, and the public
        // names it advertises are kept, never an address.
        let (port, handle) = fake_electrum(serde_json::json!([
            ["203.0.113.7", "found.example.org", ["v1.5", "s50002"]],
            ["203.0.113.8", "127.0.0.1", ["s50002"]]
        ]))
        .await;
        servers.push(handle);
        let stack = build(catalog_with(port)).await;
        assert!(stack.failures.is_empty(), "{:?}", stack.failures);
        assert_eq!(
            stack.discovered_peers,
            vec![DiscoveredPeer {
                endpoint: Endpoint {
                    kind: EndpointKind::ElectrumTls,
                    host: "found.example.org".into(),
                    port: Some(50002),
                },
                advertised_by: SourceId::new("pasted"),
            }]
        );
        for server in servers {
            server.abort();
        }
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
