#[allow(dead_code)] // menu bar is built on the JS side now; kept for reference
mod menu;

pub mod electrum_tcp;
pub mod fusion;
pub mod hw;
pub mod nostr_tor;
pub mod spv;

async fn verified_fusion_proxy<'a>(
    destination_hosts: &[&str],
    tor_host: Option<&'a str>,
    tor_port: Option<u16>,
) -> Result<Option<(&'a str, u16)>, String> {
    if destination_hosts
        .iter()
        .all(|host| fusion::is_local_server(host))
    {
        return Ok(None);
    }

    let (host, port) = match (tor_host, tor_port) {
        (Some(host), Some(port)) if !host.trim().is_empty() && port > 0 => (host, port),
        (Some(_), None) | (None, Some(_)) => {
            return Err("CashFusion Tor proxy configuration is incomplete".into())
        }
        _ => return Err("CashFusion needs a verified Tor proxy for every remote endpoint".into()),
    };

    if !fusion::tor::is_tor_port(host, port).await {
        return Err("CashFusion refused an unverified Tor proxy".into());
    }
    Ok(Some((host, port)))
}

fn fusion_transport_for_host<'a>(
    destination_host: &str,
    verified_proxy: Option<(&'a str, u16)>,
) -> Result<fusion::Transport<'a>, String> {
    if fusion::is_local_server(destination_host) {
        return Ok(fusion::Transport::Direct);
    }
    let (host, port) = verified_proxy
        .ok_or_else(|| "CashFusion remote endpoint has no verified Tor route".to_string())?;
    Ok(fusion::Transport::Tor { host, port })
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FusionStatusCacheKey {
    host: String,
    port: u16,
    use_ssl: bool,
    tor_host: Option<String>,
    tor_port: Option<u16>,
}

#[derive(Clone)]
struct FusionStatusCacheEntry {
    recorded_at: std::time::Instant,
    result: Result<fusion::FusionServerStatus, String>,
}

type FusionStatusCacheSlot = std::sync::Arc<tokio::sync::Mutex<Option<FusionStatusCacheEntry>>>;

static FUSION_STATUS_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashMap<FusionStatusCacheKey, FusionStatusCacheSlot>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

const FUSION_STATUS_SUCCESS_TTL: std::time::Duration = std::time::Duration::from_secs(30);
const FUSION_STATUS_FAILURE_TTL: std::time::Duration = std::time::Duration::from_secs(15);

fn fusion_status_cache_slot(key: &FusionStatusCacheKey) -> FusionStatusCacheSlot {
    let mut slots = FUSION_STATUS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // The renderer controls the configured endpoint, so keep this process-wide
    // cache bounded even if a user repeatedly edits the server field.
    if slots.len() >= 64 && !slots.contains_key(key) {
        slots.clear();
    }
    slots
        .entry(key.clone())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(None)))
        .clone()
}

async fn shared_fusion_server_status<F, Fut>(
    key: FusionStatusCacheKey,
    fetch: F,
) -> Result<fusion::FusionServerStatus, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<fusion::FusionServerStatus, String>>,
{
    let slot = fusion_status_cache_slot(&key);
    let mut entry = slot.lock().await;
    let now = std::time::Instant::now();
    if let Some(cached) = entry.as_ref() {
        let ttl = if cached.result.is_ok() {
            FUSION_STATUS_SUCCESS_TTL
        } else {
            FUSION_STATUS_FAILURE_TTL
        };
        if now.saturating_duration_since(cached.recorded_at) < ttl {
            return cached.result.clone();
        }
    }

    // Hold only this endpoint's async lock during the probe. Other endpoints
    // remain independent, while every wallet window targeting this server
    // shares one in-flight handshake and its bounded result.
    let result = fetch().await;
    *entry = Some(FusionStatusCacheEntry {
        recorded_at: std::time::Instant::now(),
        result: result.clone(),
    });
    result
}

async fn fetch_fusion_server_status(
    host: &str,
    port: u16,
    use_ssl: bool,
    tor_host: Option<&str>,
    tor_port: Option<u16>,
) -> Result<fusion::FusionServerStatus, String> {
    log::info!(
        "[FusionTrace] status start host={} port={} ssl={}",
        host,
        port,
        use_ssl
    );
    let verified_proxy = verified_fusion_proxy(&[host], tor_host, tor_port).await?;
    let transport = fusion_transport_for_host(host, verified_proxy)?;
    let result = fusion::server_status(host, port, use_ssl, transport, None).await;
    match &result {
        Ok(status) => log::info!(
            "[FusionTrace] status ok tiers={} components={}",
            status.tiers.len(),
            status.num_components
        ),
        Err(error) => log::warn!("[FusionTrace] status failed: {error}"),
    }
    result
}

// CashFusion server status (Phase 1).
//
// The fusion protocol is raw TCP+TLS with protobuf framing — a WebView cannot
// speak it, so the client lives in Rust. This performs a real protocol
// handshake (ClientHello -> ServerHello) and returns the server's actual fusion
// parameters. It does NOT join a pool or run a fusion round; see
// docs/cashfusion-implementation-scope.md for the phased plan.
#[tauri::command]
async fn fusion_server_status(
    host: String,
    port: u16,
    use_ssl: bool,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<fusion::FusionServerStatus, String> {
    // Electron Cash's rule (plugin.py start_fusion), reproduced exactly: fusing
    // against a REMOTE server without Tor defeats the protocol's own privacy
    // guarantee — the server can re-link a player's covert connections by IP —
    // so it refuses. A server on localhost is the one exemption: there is no
    // network observer to hide from.
    if host.trim().is_empty() || port == 0 {
        return Err("CashFusion server endpoint is invalid".into());
    }

    let key = FusionStatusCacheKey {
        host: host.trim().trim_end_matches('.').to_ascii_lowercase(),
        port,
        use_ssl,
        tor_host: tor_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.trim_end_matches('.').to_ascii_lowercase()),
        tor_port,
    };
    // All WebViews share the native process. Coalescing here prevents four
    // wallet windows from opening four identical Tor handshakes at once. The
    // short failure TTL still lets a manual retry observe a repaired server.
    shared_fusion_server_status(key, || {
        fetch_fusion_server_status(&host, port, use_ssl, tor_host.as_deref(), tor_port)
    })
    .await
}

/// Join a fusion server's waiting pool for the given tiers and report live tier
/// occupancy for up to `wait_secs`, returning early if the server signals a
/// round is starting (FusionBegin). This is Phase 1 milestone 1.1 — it joins and
/// observes only; it builds no components, commits nothing, and signs nothing.
/// The same Tor requirement as fusion_server_status applies: a remote server
/// over clearnet could link a player's covert connections by IP.
#[tauri::command]
async fn fusion_join_status(
    host: String,
    port: u16,
    use_ssl: bool,
    tiers: Vec<u64>,
    wait_secs: u64,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<fusion::round::FusionJoinResult, String> {
    if host.trim().is_empty() || port == 0 {
        return Err("CashFusion server endpoint is invalid".into());
    }
    let verified_proxy =
        verified_fusion_proxy(&[host.as_str()], tor_host.as_deref(), tor_port).await?;
    let transport = fusion_transport_for_host(&host, verified_proxy)?;

    fusion::round::join_pool_status(
        &host,
        port,
        use_ssl,
        transport,
        tiers,
        None,
        std::time::Duration::from_secs(wait_secs.clamp(1, 120)),
    )
    .await
}

/// One Electrum server the renderer offers for peer-input verification.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FusionLookupEndpointReq {
    host: String,
    port: u16,
    use_ssl: bool,
}

#[derive(serde::Deserialize)]
struct FusionRunInputReq {
    prev_txid: String,
    prev_index: u32,
    pubkey: String,
    value: u64,
    privkey: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FusionExecutionStatus {
    ready: bool,
    message: Option<&'static str>,
}

#[tauri::command]
fn fusion_execution_status() -> FusionExecutionStatus {
    let ready = fusion::fusion_execution_ready();
    FusionExecutionStatus {
        ready,
        message: (!ready).then_some(fusion::FUSION_EXECUTION_PAUSED_MESSAGE),
    }
}

/// Reserve a bounded cancellation ID before the renderer derives signing keys
/// or persists fresh output scripts.
#[tauri::command]
fn fusion_prepare_round(round_id: String) -> Result<(), String> {
    if !fusion::fusion_execution_ready() {
        return Err(fusion::FUSION_EXECUTION_PAUSED_MESSAGE.into());
    }
    fusion::round_cancel::prepare_round(&round_id)
}

/// Sign only wallet-owned inputs of an already agreed P2P-v3 template.
/// The bounded native boundary revalidates the complete template before keys
/// reach the transaction signer; classic server CashFusion remains separate.
#[tauri::command]
fn fusion_p2p_sign(
    request: fusion::p2p_sign::P2pSignRequest,
) -> Result<fusion::p2p_sign::P2pSignResponse, String> {
    fusion::p2p_sign::sign_p2p(request)
}

/// Encode an Electron Cash `Component` and return `sha256(component)` for P2P v4
/// blind credentials. Does not change the live round wire version by itself.
#[tauri::command]
fn fusion_p2p_encode_component(
    request: fusion::p2p_component::P2pComponentEncodeRequest,
) -> Result<fusion::p2p_component::P2pComponentEncodeResponse, String> {
    fusion::p2p_component::encode_component_for_p2p(request)
}

/// Run a full CashFusion round (Phase 1.7): contribute `inputs` (each with the
/// key to sign it) and fresh `outputs`, join `tier`, and fuse. Returns the
/// assembled transaction on success. Same Tor requirement as the other fusion
/// commands. A round only COMPLETES with >=2 players in the tier — run several
/// wallet instances to fuse with yourself for testing. Private keys are used only
/// to sign locally and are never logged or sent over the network.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // command args map 1:1 to the JS invoke call
/// `wallet_tag` is a stable per-wallet token (the wallet id is enough). It is
/// hashed with a per-process salt into the self-fusion pool tag, so the server
/// can refuse to place this wallet in one fusion twice without learning
/// anything that survives a restart.
#[allow(clippy::too_many_arguments)]
async fn fusion_run(
    round_id: String,
    wallet_tag: String,
    host: String,
    port: u16,
    use_ssl: bool,
    tier_plans: Vec<fusion::server_plan::FusionTierPlan>,
    inputs: Vec<FusionRunInputReq>,
    output_scripts: Vec<String>,
    lookup_host: String,
    lookup_port: u16,
    lookup_use_ssl: bool,
    lookup_fallbacks: Vec<FusionLookupEndpointReq>,
    tor_host: Option<String>,
    tor_port: Option<u16>,
    expected_hello: fusion::server_plan::ExpectedHello,
    join_inactive_timeout_ms: Option<u64>,
) -> Result<fusion::run::FusionOutcome, String> {
    log::info!(
        "[FusionTrace] round start id={} host={} port={} plans={} inputs={}",
        round_id,
        host,
        port,
        tier_plans.len(),
        inputs.len()
    );
    if !fusion::fusion_execution_ready() {
        return Err(fusion::FUSION_EXECUTION_PAUSED_MESSAGE.into());
    }

    if host.trim().is_empty() || port == 0 {
        return Err("CashFusion server endpoint is invalid".into());
    }
    if lookup_host.trim().is_empty() || lookup_port == 0 {
        return Err("CashFusion peer-input lookup endpoint is invalid".into());
    }
    let verified_proxy = verified_fusion_proxy(
        &[host.as_str(), lookup_host.as_str()],
        tor_host.as_deref(),
        tor_port,
    )
    .await?;
    let transport = fusion_transport_for_host(&host, verified_proxy)?;
    let lookup_transport = fusion_transport_for_host(&lookup_host, verified_proxy)?;
    let remote_transport = verified_proxy.map(|(host, port)| fusion::Transport::Tor { host, port });

    let join_inactive_timeout = match join_inactive_timeout_ms {
        None => None,
        Some(600_000) => Some(fusion::run::EC_AUTOFUSE_INACTIVE_TIMEOUT),
        Some(_) => {
            return Err("automatic server Fusion inactivity timeout must be 600000 ms".into())
        }
    };
    let registration = fusion::round_cancel::acquire_round(&round_id)?;
    let cancel = registration.flag();

    let mut keyed_inputs = Vec::with_capacity(inputs.len());
    for i in inputs {
        let pubkey = decode_hex(&i.pubkey)?;
        let privkey: [u8; 32] = decode_hex(&i.privkey)?
            .try_into()
            .map_err(|_| "privkey must be 32 bytes".to_string())?;
        keyed_inputs.push(fusion::run::FusionInputKey {
            prev_txid: i.prev_txid,
            prev_index: i.prev_index,
            pubkey,
            value: i.value,
            privkey,
        });
    }
    let mut scripts = Vec::with_capacity(output_scripts.len());
    for s in &output_scripts {
        scripts.push(decode_hex(s)?);
    }

    let result = fusion::run::run_fusion(fusion::run::FusionRunParams {
        host: &host,
        port,
        use_ssl,
        tier_plans,
        inputs: keyed_inputs,
        output_scripts: scripts,
        main_transport: transport,
        remote_transport,
        // Every configured Electrum server, primary first, not just one. A
        // single unreachable host otherwise makes peer inputs unverifiable —
        // and since missing evidence must never become an accusation, that
        // aborts every round rather than blaming anyone.
        lookup_endpoints: std::iter::once(fusion::electrum_input::ElectrumEndpoint {
            host: lookup_host,
            port: lookup_port,
            use_ssl: lookup_use_ssl,
        })
        .chain(lookup_fallbacks.into_iter().map(|endpoint| {
            fusion::electrum_input::ElectrumEndpoint {
                host: endpoint.host,
                port: endpoint.port,
                use_ssl: endpoint.use_ssl,
            }
        }))
        .collect(),
        lookup_transport,
        timing: fusion::run::FusionTiming::default(),
        join_inactive_timeout,
        cancel,
        expected_hello,
        wallet_tag_seed: wallet_tag.into_bytes(),
        // Electron Cash's default (conf.py:51 SelfFusePlayers = 1): never place
        // this wallet in a fusion with itself.
        self_fuse_limit: 1,
    })
    .await;

    match &result {
        Ok(outcome) => log::info!(
            "[FusionTrace] round settled id={} ok={} message={}",
            round_id,
            outcome.ok,
            outcome.message
        ),
        Err(error) => log::warn!("[FusionTrace] round failed id={round_id}: {error}"),
    }

    drop(registration);
    result
}

/// Cancel a running fusion round by its round_id. Idempotent — returns true
/// if the round was found and cancelled, false if it was already gone.
#[tauri::command]
fn fusion_cancel_round(round_id: String) -> bool {
    fusion::round_cancel::cancel_round(&round_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FusionRelayRoute {
    Direct,
    Tor,
}

const MAX_FUSION_RELAY_TX_BYTES: usize = 100_000;

fn validate_fusion_relay_request(tx_hex: &str, network: &str) -> Result<(), String> {
    if !matches!(network, "mainnet" | "chipnet") {
        return Err("unsupported CashFusion relay network".into());
    }
    if tx_hex.is_empty() || tx_hex.len() % 2 != 0 {
        return Err("transaction hex must be non-empty and even length".into());
    }
    if tx_hex.len() / 2 > MAX_FUSION_RELAY_TX_BYTES {
        return Err("CashFusion relay transaction exceeds the size limit".into());
    }
    Ok(())
}

fn fusion_relay_is_local(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || matches!(host, "127.0.0.1" | "::1")
}

fn fusion_relay_transport_policy(
    relay_host: &str,
    observer_host: &str,
    tor_verified: bool,
) -> Result<(FusionRelayRoute, FusionRelayRoute), String> {
    let route = |host: &str| {
        if fusion_relay_is_local(host) {
            Ok(FusionRelayRoute::Direct)
        } else if tor_verified {
            Ok(FusionRelayRoute::Tor)
        } else {
            Err(
                "CashFusion relay and observation require a verified Tor proxy for every remote peer"
                    .to_string(),
            )
        }
    };
    Ok((route(relay_host)?, route(observer_host)?))
}

fn fusion_relay_endpoint_key(host: &str, port: u16) -> (String, u16) {
    let normalized_host = if fusion_relay_is_local(host) {
        "loopback".to_string()
    } else {
        host.trim_end_matches('.').to_ascii_lowercase()
    };
    (normalized_host, port)
}

fn fusion_relay_endpoints_are_distinct(
    relay_host: &str,
    relay_port: u16,
    observer_host: &str,
    observer_port: u16,
) -> bool {
    fusion_relay_endpoint_key(relay_host, relay_port)
        != fusion_relay_endpoint_key(observer_host, observer_port)
}

/// Broadcast a server-assembled CashFusion transaction to one BCH peer, then
/// require a separate peer to return the exact raw transaction by txid.
///
/// Does the network already have this transaction?
///
/// Relay-and-observe proves a broadcast by watching a SECOND node echo the
/// transaction back, which only works when we are the first to announce it. In
/// a server-coordinated fusion the CashFusion server broadcasts first, so by the
/// time we relay, nodes already hold the transaction and do not re-announce it —
/// and a good, already-accepted fusion looks like a failure.
///
/// Asking an Electrum server whether the transaction exists tests what actually
/// matters, regardless of who announced it. Every configured server is tried,
/// and only "no server could answer" is an error — an unreachable Electrum must
/// never be mistaken for a missing transaction.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fusion_transaction_is_known(
    txid: String,
    lookup_host: String,
    lookup_port: u16,
    lookup_use_ssl: bool,
    lookup_fallbacks: Vec<FusionLookupEndpointReq>,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<bool, String> {
    let endpoints: Vec<fusion::electrum_input::ElectrumEndpoint> =
        std::iter::once(fusion::electrum_input::ElectrumEndpoint {
            host: lookup_host,
            port: lookup_port,
            use_ssl: lookup_use_ssl,
        })
        .chain(lookup_fallbacks.into_iter().map(|endpoint| {
            fusion::electrum_input::ElectrumEndpoint {
                host: endpoint.host,
                port: endpoint.port,
                use_ssl: endpoint.use_ssl,
            }
        }))
        .collect();

    let hosts: Vec<&str> = endpoints.iter().map(|e| e.host.as_str()).collect();
    let verified_proxy = verified_fusion_proxy(&hosts, tor_host.as_deref(), tor_port).await?;

    let mut last_error = String::from("no Electrum server could answer");
    for endpoint in &endpoints {
        let transport = match fusion_transport_for_host(&endpoint.host, verified_proxy) {
            Ok(transport) => transport,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        match fusion::electrum_input::transaction_is_known(endpoint, transport, &txid).await {
            // A server that HAS it settles the question. A server that does not
            // may simply be behind, so keep asking the others.
            Ok(true) => return Ok(true),
            Ok(false) => {
                last_error = format!("{}:{} does not have it", endpoint.host, endpoint.port)
            }
            Err(error) => last_error = format!("{}:{}: {error}", endpoint.host, endpoint.port),
        }
    }
    Err(last_error)
}

/// Remote peers are routed only through a proxy freshly verified as Tor at this
/// API boundary. Loopback peers are the sole direct-connection exemption.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fusion_relay_broadcast_and_observe(
    tx_hex: String,
    network: String,
    relay_host: String,
    relay_port: u16,
    observer_host: String,
    observer_port: u16,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<spv::FusionRelayObservation, String> {
    if !fusion::fusion_execution_ready() {
        return Err(fusion::FUSION_EXECUTION_PAUSED_MESSAGE.into());
    }
    if !fusion_relay_endpoints_are_distinct(&relay_host, relay_port, &observer_host, observer_port)
    {
        return Err("relay and observer endpoints must be distinct".into());
    }

    validate_fusion_relay_request(&tx_hex, &network)?;
    let tx_bytes = decode_hex(&tx_hex).map_err(|_| "invalid transaction hex".to_string())?;

    let any_remote = !fusion_relay_is_local(&relay_host) || !fusion_relay_is_local(&observer_host);
    let tor_verified = if any_remote {
        match (tor_host.as_deref(), tor_port) {
            (Some(host), Some(port)) => fusion::tor::is_tor_port(host, port).await,
            _ => false,
        }
    } else {
        false
    };
    let (relay_route, observer_route) =
        fusion_relay_transport_policy(&relay_host, &observer_host, tor_verified)?;

    let verified_proxy = match (tor_host.as_deref(), tor_port) {
        (Some(host), Some(port)) if tor_verified => Some((host, port)),
        _ => None,
    };
    let relay_transport = match relay_route {
        FusionRelayRoute::Direct => fusion::Transport::Direct,
        FusionRelayRoute::Tor => {
            let (host, port) =
                verified_proxy.ok_or("verified Tor proxy details unavailable for remote relay")?;
            fusion::Transport::Tor { host, port }
        }
    };
    let observer_transport = match observer_route {
        FusionRelayRoute::Direct => fusion::Transport::Direct,
        FusionRelayRoute::Tor => {
            let (host, port) = verified_proxy
                .ok_or("verified Tor proxy details unavailable for remote observer")?;
            fusion::Transport::Tor { host, port }
        }
    };

    spv::relay_broadcast_and_observe(
        &relay_host,
        relay_port,
        relay_transport,
        &observer_host,
        observer_port,
        observer_transport,
        &network,
        tx_bytes,
    )
    .await
}

/// Find a running Tor SOCKS proxy, mirroring Electron Cash's auto-detection
/// (ports 9050 = daemon, 9150 = Tor Browser). Returns the port, or null if Tor
/// isn't running. Verifies it's genuinely Tor, not just something listening.
#[tauri::command]
async fn fusion_tor_detect(host: Option<String>) -> Option<u16> {
    let host = host.unwrap_or_else(|| fusion::tor::DEFAULT_TOR_HOST.to_string());
    fusion::tor::scan_tor_port(&host).await
}

/// Check one specific host:port for a Tor proxy (used when the user pins a
/// manual port rather than relying on auto-detection).
#[tauri::command]
async fn fusion_tor_check(host: String, port: u16) -> bool {
    fusion::tor::is_tor_port(&host, port).await
}

// BIP37 SPV — Phase 1 node probe.
//
// A full node speaks the raw BCH P2P protocol, not Electrum, so — like fusion —
// the client lives in Rust. This performs a real version/verack handshake and
// reports the peer's parameters (user-agent, height, whether it serves BIP37).
// It does not sync or track UTXOs; see the plan for later phases. tor_host/
// tor_port route the connection through Tor (optional; LAN/localhost go direct).
#[tauri::command]
async fn bip37_node_probe(
    host: String,
    port: u16,
    network: String,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<spv::NodeProbe, String> {
    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ => fusion::Transport::Direct,
    };
    spv::probe_node(&host, port, &network, transport).await
}

// Parse a 40-hex-char pubkey hash (hash160) into 20 bytes.
fn decode_hex(h: &str) -> Result<Vec<u8>, String> {
    if !h.is_ascii() {
        return Err("invalid hex".into());
    }
    if h.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).map_err(|_| "invalid hex".to_string()))
        .collect()
}

fn parse_pkh(h: &str) -> Result<[u8; 20], String> {
    if h.len() != 40 {
        return Err("pubkey hash must be 40 hex chars".into());
    }
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16)
            .map_err(|_| "invalid pubkey-hash hex".to_string())?;
    }
    Ok(out)
}

// Parse a display (big-endian) block-hash hex into internal little-endian bytes.
fn parse_block_hash(h: &str) -> Result<[u8; 32], String> {
    if h.len() != 64 {
        return Err("block hash must be 64 hex chars".into());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[31 - i] = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16)
            .map_err(|_| "invalid block-hash hex".to_string())?;
    }
    Ok(out)
}

// Sync a batch of block headers from a node, starting after `locator` (a
// display-hex block hash; empty/none = the network genesis). Returns validated
// HeaderInfo; the caller loops with the last hash to walk toward the tip.
#[tauri::command]
async fn bip37_headers(
    host: String,
    port: u16,
    network: String,
    locator: Option<String>,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<Vec<spv::HeaderInfo>, String> {
    let start = match locator.as_deref().filter(|s| !s.is_empty()) {
        Some(h) => parse_block_hash(h)?,
        None => spv::genesis_hash(&network),
    };
    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ => fusion::Transport::Direct,
    };
    spv::fetch_headers_after(&host, port, &network, transport, start).await
}

// Scan the given blocks (display-hex hashes) for outputs/inputs touching the
// wallet's `pubkey_hashes` (40-hex each), returning owned UTXOs + spent
// outpoints. This is the trustless, direct-from-node path.
#[tauri::command]
async fn bip37_scan(
    host: String,
    port: u16,
    network: String,
    pubkey_hashes: Vec<String>,
    block_hashes: Vec<String>,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<spv::ScanResult, String> {
    let watched: std::collections::HashSet<[u8; 20]> = pubkey_hashes
        .iter()
        .map(|h| parse_pkh(h))
        .collect::<Result<_, _>>()?;
    let blocks: Vec<[u8; 32]> = block_hashes
        .iter()
        .map(|h| parse_block_hash(h))
        .collect::<Result<_, _>>()?;
    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ => fusion::Transport::Direct,
    };
    spv::scan_blocks(&host, port, &network, transport, &blocks, &watched).await
}

// Broadcast a signed raw transaction (hex) to a node over P2P. Returns the txid.
// The node write-path for a BIP37 backend.
#[tauri::command]
async fn bip37_broadcast(
    host: String,
    port: u16,
    network: String,
    tx_hex: String,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<String, String> {
    if tx_hex.len() % 2 != 0 || tx_hex.is_empty() {
        return Err("transaction hex must be non-empty and even length".into());
    }
    let tx_bytes: Vec<u8> = (0..tx_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&tx_hex[i..i + 2], 16))
        .collect::<Result<_, _>>()
        .map_err(|_| "invalid transaction hex".to_string())?;
    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ => fusion::Transport::Direct,
    };
    spv::broadcast_tx(&host, port, &network, transport, tx_bytes).await
}

// ── Integrated (app-managed) Tor ────────────────────────────────────────────
//
// SOCKS port for the app's own Tor — deliberately not 9050/9150 so it never
// clashes with a Tor the user is already running.
const INTEGRATED_TOR_SOCKS_PORT: u16 = 9251;

/// Resolve where the tor binary + geoip data live: a dev override via
/// OPTN_TOR_BIN, otherwise the bundled resource dir (resources/tor/).
fn resolve_tor_paths(app: &tauri::AppHandle) -> Result<fusion::tor_manager::TorPaths, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tor-data");

    let bin_name = if cfg!(windows) { "tor.exe" } else { "tor" };

    // 1. Explicit override (dev / tests).
    if let Ok(bin) = std::env::var("OPTN_TOR_BIN") {
        return Ok(fusion::tor_manager::TorPaths {
            binary: std::path::PathBuf::from(bin),
            data_dir,
            geoip: std::env::var("OPTN_TOR_GEOIP")
                .ok()
                .map(std::path::PathBuf::from),
            geoip6: std::env::var("OPTN_TOR_GEOIP6")
                .ok()
                .map(std::path::PathBuf::from),
        });
    }

    // 2. Dev fallback: the binary staged into the source tree by
    //    scripts/fetch-tor.mjs. `tauri dev` doesn't copy bundled resources, so
    //    without this integrated Tor wouldn't work in dev. CARGO_MANIFEST_DIR is
    //    baked at compile time and only resolves on the build machine, so this
    //    is naturally inert in a packaged build.
    #[cfg(debug_assertions)]
    {
        let dev_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("tor");
        let dev_bin = dev_dir.join(bin_name);
        if dev_bin.exists() {
            let geoip = dev_dir.join("geoip");
            let geoip6 = dev_dir.join("geoip6");
            return Ok(fusion::tor_manager::TorPaths {
                binary: dev_bin,
                data_dir,
                geoip: geoip.exists().then_some(geoip),
                geoip6: geoip6.exists().then_some(geoip6),
            });
        }
    }

    // 3. Bundled resource (see tauri.conf.json bundle.resources).
    let tor_dir = app
        .path()
        .resolve("resources/tor", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let binary = tor_dir.join(bin_name);
    let geoip = tor_dir.join("geoip");
    let geoip6 = tor_dir.join("geoip6");
    Ok(fusion::tor_manager::TorPaths {
        binary,
        data_dir,
        geoip: geoip.exists().then_some(geoip),
        geoip6: geoip6.exists().then_some(geoip6),
    })
}

/// Start the integrated Tor and wait for it to bootstrap. Returns the SOCKS port.
#[tauri::command]
async fn tor_start(app: tauri::AppHandle) -> Result<u16, String> {
    let paths = resolve_tor_paths(&app)?;
    if !paths.binary.exists() && std::env::var("OPTN_TOR_BIN").is_err() {
        return Err(format!(
            "Tor binary not found at {} — this build does not bundle Tor yet.",
            paths.binary.display()
        ));
    }
    fusion::tor_manager::start(
        paths,
        INTEGRATED_TOR_SOCKS_PORT,
        // First bootstrap over a slow or filtered network can run past two
        // minutes; on timeout tor is left running (not killed), so this is a
        // patience bound, not a hard cap.
        std::time::Duration::from_secs(180),
    )
    .await
}

/// Stop the integrated Tor.
#[tauri::command]
async fn tor_stop() -> Result<(), String> {
    fusion::tor_manager::stop().await
}

/// Current integrated-Tor status (running / bootstrap % / SOCKS port).
#[tauri::command]
fn tor_status() -> fusion::tor_manager::TorStatus {
    fusion::tor_manager::status()
}

// Desktop-only price fetch.
//
// The OPTN price server rejects (HTTP 500) any browser `Origin` header, and
// @tauri-apps/plugin-http force-sets Origin to the webview origin
// (`tauri.localhost`) in production, which cannot be overridden from JS. The
// mobile app avoids this by using Capacitor's native HTTP (no browser Origin).
// This command is the desktop equivalent: a server-side reqwest call (no Origin),
// hardcoded to the single trusted price host so it can never be used for SSRF.
#[tauri::command]
async fn optn_price_fetch(url: String) -> Result<String, String> {
    if !url.starts_with("https://price.optnlabs.com/") {
        return Err("host not allowed".into());
    }
    // A server that accepts the TCP/TLS connection and then never answers
    // (observed in practice against this exact host) would otherwise hang
    // this request indefinitely — reqwest has no default timeout. The JS
    // side (http-bridge.ts) also races this call against its own timeout,
    // but bounding it here too means a slow/dead server doesn't leave the
    // Rust-side request running forever regardless of what the JS caller does.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    Ok(body)
}

// Read/write a wallet file at a path the user explicitly picked via the OS
// dialog. Done in Rust (unrestricted fs) so opening/exporting a .optn file from
// anywhere on disk doesn't require a broad JS fs-capability scope. Constrained
// to the .optn extension so these commands can't be repurposed to read/write
// arbitrary files.
fn ensure_optn_path(path: &str) -> Result<(), String> {
    if std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("optn"))
        == Some(true)
    {
        Ok(())
    } else {
        Err("only .optn wallet files are allowed".into())
    }
}

// Companion data file for a wallet pack (encrypted labels/history/fusion).
// Same unrestricted-fs rationale as .optn: users save next to the keystore
// (Desktop, Downloads, …) which is outside the JS fs plugin appdata scope.
// Extension is literally "optn-cold" (Path::extension after the last dot).
fn ensure_optn_cold_path(path: &str) -> Result<(), String> {
    if std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("optn-cold"))
        == Some(true)
    {
        Ok(())
    } else {
        Err("only .optn-cold data files are allowed".into())
    }
}

// Open an external URL in the user's default browser. A Tauri webview silently
// blocks `target="_blank"` links, so faucet/explorer/etc. links never open; the
// frontend intercepts those clicks and routes them here. Restricted to http(s).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs may be opened externally".into());
    }
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawn = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawn
        .map(|_| ())
        .map_err(|e| format!("could not open browser: {e}"))
}

#[tauri::command]
async fn read_wallet_file(path: String) -> Result<String, String> {
    ensure_optn_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_wallet_file(path: String, contents: String) -> Result<(), String> {
    ensure_optn_path(&path)?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_optn_cold_file(path: String) -> Result<String, String> {
    ensure_optn_cold_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_optn_cold_file(path: String, contents: String) -> Result<(), String> {
    ensure_optn_cold_path(&path)?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// True if a companion .optn-cold exists next to a selected .optn (sibling
/// auto-load). Path-restricted so it cannot probe arbitrary files.
#[tauri::command]
async fn optn_cold_file_exists(path: String) -> Result<bool, String> {
    ensure_optn_cold_path(&path)?;
    Ok(std::path::Path::new(&path).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_keyring::init())
        .plugin(tauri_plugin_biometry::init())
        .invoke_handler(tauri::generate_handler![
            optn_price_fetch,
            open_external,
            read_wallet_file,
            write_wallet_file,
            read_optn_cold_file,
            write_optn_cold_file,
            optn_cold_file_exists,
            fusion_server_status,
            fusion_join_status,
            fusion_execution_status,
            fusion_prepare_round,
            fusion_p2p_sign,
            fusion_p2p_encode_component,
            fusion_run,
            fusion_cancel_round,
            fusion_relay_broadcast_and_observe,
            fusion_transaction_is_known,
            fusion_tor_detect,
            fusion_tor_check,
            bip37_node_probe,
            bip37_headers,
            bip37_scan,
            bip37_broadcast,
            tor_start,
            tor_stop,
            tor_status,
            electrum_tcp::electrum_tcp_connect,
            electrum_tcp::electrum_tcp_send,
            electrum_tcp::electrum_tcp_close,
            nostr_tor::nostr_tor_open,
            nostr_tor::nostr_tor_send,
            nostr_tor::nostr_tor_close,
            hw::session::hw_enumerate,
            hw::session::hw_open,
            hw::session::hw_close,
            hw::session::hw_write,
            hw::session::hw_read,
            hw::ledger::hw_ledger_open,
            hw::ledger::hw_ledger_exchange,
            hw::trezor_bridge::trezor_bridge_ping,
            hw::trezor_bridge::trezor_bridge_enumerate,
            hw::trezor_bridge::trezor_bridge_acquire,
            hw::trezor_bridge::trezor_bridge_release,
            hw::trezor_bridge::trezor_bridge_call,
            hw::trezor_webusb::trezor_webusb_enumerate,
            hw::trezor_webusb::trezor_webusb_open,
            hw::trezor_webusb::trezor_webusb_close,
            hw::trezor_webusb::trezor_webusb_write,
            hw::trezor_webusb::trezor_webusb_read,
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    // Builder defaults already include stdout + a LogDir using
                    // productName (OPTNWallet.log). Clear them before adding the
                    // two intentional sinks below, otherwise every entry is
                    // duplicated into both OPTNWallet.log and optn-wallet.log.
                    .clear_targets()
                    .level(log::LevelFilter::Info)
                    .level_for(tauri_plugin_log::WEBVIEW_TARGET, log_level)
                    .level_for(env!("CARGO_CRATE_NAME"), log_level)
                    // Stdout so the terminal shows logs during dev
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    // Rolling log file in the OS app-log directory:
                    //   Windows: %LOCALAPPDATA%\com.optilabs.wallet\logs\
                    //   macOS:   ~/Library/Logs/com.optilabs.wallet/
                    //   Linux:   ~/.local/share/com.optilabs.wallet/logs/
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("optn-wallet".into()),
                        },
                    ))
                    // 5MB filled in <1h of multi-wallet p2p-live spam and left
                    // agents blind mid-run. Larger file + deduped JS logging.
                    .max_file_size(20_000_000) // 20 MB per file
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .build(),
            )?;
            // Menu bar is built on the frontend in TypeScript
            // (src/platform/desktop/useMenuBar.ts) so File → Open Wallet can list
            // the actual saved wallets from the webview's WASM SQLite DB. The old
            // static Rust menu is intentionally not attached — leaving it would
            // flash a stale menu before the frontend replaces it via setAsAppMenu().
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_fusion_status() -> fusion::FusionServerStatus {
        fusion::FusionServerStatus {
            tiers: vec![10_000],
            num_components: 17,
            component_feerate: 1_000,
            min_excess_fee: 10,
            max_excess_fee: 1_000,
            donation_address: None,
        }
    }

    #[tokio::test]
    async fn automatic_status_probe_is_shared_across_wallet_windows() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let key = FusionStatusCacheKey {
            host: "coalesce-test.invalid".into(),
            port: 8789,
            use_ssl: true,
            tor_host: Some("127.0.0.1".into()),
            tor_port: Some(9050),
        };
        let calls = std::sync::Arc::new(AtomicUsize::new(0));

        let first_calls = calls.clone();
        let first = shared_fusion_server_status(key.clone(), move || async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok(test_fusion_status())
        });
        let second_calls = calls.clone();
        let second = shared_fusion_server_status(key, move || async move {
            second_calls.fetch_add(1, Ordering::SeqCst);
            Ok(test_fusion_status())
        });

        let (first_result, second_result) = tokio::join!(first, second);
        assert_eq!(first_result.unwrap().tiers, vec![10_000]);
        assert_eq!(second_result.unwrap().tiers, vec![10_000]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn automatic_status_failure_uses_shared_backoff() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let key = FusionStatusCacheKey {
            host: "failure-backoff-test.invalid".into(),
            port: 8789,
            use_ssl: true,
            tor_host: Some("127.0.0.1".into()),
            tor_port: Some(9050),
        };
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let first = shared_fusion_server_status(key.clone(), move || async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            Err("server unavailable".to_string())
        })
        .await;
        assert_eq!(first.unwrap_err(), "server unavailable");

        let second_calls = calls.clone();
        let second = shared_fusion_server_status(key, move || async move {
            second_calls.fetch_add(1, Ordering::SeqCst);
            Ok(test_fusion_status())
        })
        .await;
        assert_eq!(second.unwrap_err(), "server unavailable");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn fusion_command_transport_requires_a_verified_proxy_for_remote_hosts() {
        for host in ["localhost", "127.0.0.1", "::1"] {
            assert!(matches!(
                fusion_transport_for_host(host, None).unwrap(),
                fusion::Transport::Direct
            ));
        }

        assert!(fusion_transport_for_host("fusion.example", None)
            .unwrap_err()
            .contains("verified Tor"));
        assert!(matches!(
            fusion_transport_for_host("fusion.example", Some(("127.0.0.1", 9050))).unwrap(),
            fusion::Transport::Tor {
                host: "127.0.0.1",
                port: 9050
            }
        ));
    }

    #[test]
    fn fusion_relay_policy_allows_every_loopback_form_direct() {
        let loopbacks = ["localhost", "127.0.0.1", "::1"];
        for relay_host in loopbacks {
            for observer_host in loopbacks {
                assert_eq!(
                    fusion_relay_transport_policy(relay_host, observer_host, false).unwrap(),
                    (FusionRelayRoute::Direct, FusionRelayRoute::Direct)
                );
            }
        }
    }

    #[test]
    fn fusion_relay_policy_rejects_any_remote_peer_without_verified_tor() {
        for (relay_host, observer_host) in [
            ("relay.example", "observer.example"),
            ("localhost", "observer.example"),
            ("relay.example", "::1"),
        ] {
            let err = fusion_relay_transport_policy(relay_host, observer_host, false).unwrap_err();
            assert!(err.contains("verified Tor"), "unexpected error: {err}");
        }
    }

    #[test]
    fn fusion_relay_policy_routes_each_remote_peer_through_verified_tor() {
        assert_eq!(
            fusion_relay_transport_policy("localhost", "observer.example", true).unwrap(),
            (FusionRelayRoute::Direct, FusionRelayRoute::Tor)
        );
        assert_eq!(
            fusion_relay_transport_policy("relay.example", "observer.example", true).unwrap(),
            (FusionRelayRoute::Tor, FusionRelayRoute::Tor)
        );
    }

    #[test]
    fn fusion_relay_endpoints_must_be_distinct() {
        assert!(!fusion_relay_endpoints_are_distinct(
            "relay.example",
            8333,
            "RELAY.EXAMPLE.",
            8333
        ));
        assert!(!fusion_relay_endpoints_are_distinct(
            "localhost",
            8333,
            "127.0.0.1",
            8333
        ));
        assert!(fusion_relay_endpoints_are_distinct(
            "relay.example",
            8333,
            "observer.example",
            8333
        ));
    }

    #[test]
    fn fusion_relay_request_is_bounded_and_network_explicit() {
        assert!(validate_fusion_relay_request("00", "mainnet").is_ok());
        assert!(validate_fusion_relay_request("00", "chipnet").is_ok());
        assert!(validate_fusion_relay_request("00", "unknown").is_err());
        assert!(validate_fusion_relay_request("", "mainnet").is_err());
        assert!(validate_fusion_relay_request("0", "mainnet").is_err());
        assert!(validate_fusion_relay_request(
            &"00".repeat(MAX_FUSION_RELAY_TX_BYTES + 1),
            "mainnet"
        )
        .is_err());
    }
}
