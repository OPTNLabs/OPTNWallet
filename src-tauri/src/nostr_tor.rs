// Tor-routed WebSocket transport for Nostr relays, desktop only.
//
// P2P CashFusion must route its relay traffic through Tor so a peer's IP can't be
// correlated across its (round-key) input registration and its (throwaway-key)
// output registration — the same requirement classic CashFusion has. A WebView
// WebSocket cannot dial a SOCKS proxy, so this module opens each relay's wss://
// connection from Rust over the SAME Tor+TLS path the fusion client uses
// (fusion::connect_stream), performs the WebSocket handshake (tokio-tungstenite
// over that stream), and pipes text frames to/from the frontend as Tauri events.
// The frontend's TorWebSocket shim presents this as an ordinary WebSocket to
// nostr-tools (useWebSocketImplementation). This side moves frames; all Nostr
// protocol logic stays in JS.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use optn_core::network::Network;
use optn_runtime::AppRuntime;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::fusion::{connect_stream, Transport};

/// Per-connection outbound channel; dropping it ends the writer task.
static CONNECTIONS: Lazy<Mutex<HashMap<u32, mpsc::UnboundedSender<Message>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: Lazy<std::sync::atomic::AtomicU32> =
    Lazy::new(|| std::sync::atomic::AtomicU32::new(1));

fn msg_event(id: u32) -> String {
    format!("nostr-tor://msg/{id}")
}
fn open_event(id: u32) -> String {
    format!("nostr-tor://open/{id}")
}
fn closed_event(id: u32) -> String {
    format!("nostr-tor://closed/{id}")
}

/// Parse a secure WebSocket relay URL → (host, port). Only secure WebSockets
/// are accepted, so a relay is never contacted over plaintext transport.
fn parse_wss(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("wss://")
        .ok_or_else(|| format!("only wss:// relays supported: {url}"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p.parse::<u16>().map_err(|_| format!("bad port in {url}"))?;
            Ok((h.to_string(), port))
        }
        None => Ok((authority.to_string(), 443)),
    }
}

/// Open a Tor-routed wss:// connection to a Nostr relay. Returns a connection id
/// the frontend uses for `nostr_tor_send` / `nostr_tor_close`, and listens on
/// `nostr-tor://open/{id}`, `nostr-tor://msg/{id}`, `nostr-tor://closed/{id}`.
#[tauri::command]
pub async fn nostr_tor_open(
    app: AppHandle,
    url: String,
    socks_host: String,
    socks_port: u16,
) -> Result<u32, String> {
    let (host, port) = parse_wss(&url)?;
    let transport = Transport::Tor {
        host: &socks_host,
        port: socks_port,
    };
    // Tor+TLS leg, then the WebSocket upgrade over it. A failure here means Tor
    // isn't up or the relay is unreachable — the caller fails closed.
    let stream = connect_stream(&host, port, true, transport).await?;
    let (ws, _resp) = tokio_tungstenite::client_async(url.as_str(), stream)
        .await
        .map_err(|e| format!("ws handshake with {host} failed: {e}"))?;

    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    CONNECTIONS.lock().await.insert(id, tx);

    let (mut write, mut read) = ws.split();

    // Writer: forward frames from the JS `send()` path until the channel closes.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    // Reader: emit inbound text frames as events until close/error.
    let app_reader = app.clone();
    tokio::spawn(async move {
        while let Some(next) = read.next().await {
            match next {
                Ok(Message::Text(text)) => {
                    if app_reader.emit(&msg_event(id), text).is_err() {
                        break;
                    }
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => {}
                Ok(Message::Close(_)) | Ok(Message::Frame(_)) | Err(_) => break,
            }
        }
        CONNECTIONS.lock().await.remove(&id);
        let _ = app_reader.emit(&closed_event(id), ());
    });

    let _ = app.emit(&open_event(id), ());
    Ok(id)
}

/// Send a text frame on an open connection.
#[tauri::command]
pub async fn nostr_tor_send(id: u32, data: String) -> Result<(), String> {
    let conns = CONNECTIONS.lock().await;
    let tx = conns.get(&id).ok_or("relay connection not open")?;
    tx.send(Message::Text(data))
        .map_err(|_| "relay connection closed".to_string())
}

/// Close a connection. Dropping the sender ends the writer task; the reader then
/// emits the closed event. Removing eagerly makes a re-close a no-op.
#[tauri::command]
pub async fn nostr_tor_close(id: u32) -> Result<(), String> {
    if let Some(tx) = CONNECTIONS.lock().await.remove(&id) {
        let _ = tx.send(Message::Close(None));
    }
    Ok(())
}

const HEALTH_MAX_RELAYS: usize = 64;
const HEALTH_MAX_URL_BYTES: usize = 2048;
const HEALTH_CONCURRENCY: usize = 8;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_TTL: Duration = Duration::from_secs(30);
const HEALTH_STALE: &str = "Wallet or network policy changed; check relay health again.";
const HEALTH_POLICY_BLOCKED: &str = "Public relay checks are blocked by the source policy; owned Nostr relay classification is not supported yet.";
const HEALTH_TOR_REQUIRED: &str =
    "Relay health requires a verified Tor route; no direct fallback is used.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NostrRelayHealth {
    pub url: String,
    /// Reachable at the last check, not an active chat connection.
    pub reachable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NostrRelayHealthResponse {
    pub relays: Vec<NostrRelayHealth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug)]
struct HealthRelay {
    url: String,
    websocket_url: String,
    host: String,
    port: u16,
}

/// Validate the entire caller-supplied pool before any policy or socket I/O.
/// Preserve the first spelling for UI lookup; deduplicate canonical URLs.
fn health_relays(urls: Vec<String>) -> Result<Vec<HealthRelay>, &'static str> {
    if urls.len() > HEALTH_MAX_RELAYS {
        return Err("At most 64 relay URLs may be checked at once.");
    }
    let mut seen = HashSet::new();
    let mut relays = Vec::with_capacity(urls.len());
    for url in urls {
        if url.len() > HEALTH_MAX_URL_BYTES
            || url.chars().any(|ch| ch.is_control() || ch.is_whitespace())
            || url.contains('\\')
        {
            return Err(
                "Relay URLs must be at most 2048 bytes and contain no whitespace or backslashes.",
            );
        }
        let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid relay URL.")?;
        if parsed.scheme() != "wss"
            || !url
                .get(..6)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("wss://"))
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || url[6..]
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .contains('@')
        {
            return Err("Relay URLs must use wss:// with a host and no credentials or fragment.");
        }
        let port = parsed
            .port_or_known_default()
            .filter(|port| *port != 0)
            .ok_or("Invalid relay port.")?;
        let host = parsed
            .host_str()
            .ok_or("Invalid relay host.")?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let websocket_url = parsed.to_string();
        if seen.insert(websocket_url.clone()) {
            relays.push(HealthRelay {
                url,
                websocket_url,
                host,
                port,
            });
        }
    }
    Ok(relays)
}

fn blocked_health(relays: &[HealthRelay], reason: &str) -> NostrRelayHealthResponse {
    NostrRelayHealthResponse {
        relays: relays
            .iter()
            .map(|relay| NostrRelayHealth {
                url: relay.url.clone(),
                reachable: None,
                reason: Some(reason.to_owned()),
            })
            .collect(),
        error: Some(reason.to_owned()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HealthContext {
    network: Network,
    unlock_epoch: u64,
    policy_generation: u64,
}

fn health_context(
    state: &optn_app::AppState,
    network: Network,
    policy_generation: u64,
) -> Result<HealthContext, &'static str> {
    if state.wallet.is_none() {
        return Err("Open a wallet before checking relay health.");
    }
    if state.network != network {
        return Err("Relay health network does not match the open runtime wallet.");
    }
    Ok(HealthContext {
        network,
        unlock_epoch: state.lock.unlock_epoch,
        policy_generation,
    })
}

#[derive(Debug, PartialEq, Eq)]
struct HealthCacheKey {
    context: HealthContext,
    urls: Vec<String>,
}

struct CachedHealth {
    key: HealthCacheKey,
    completed_at: Instant,
    response: NostrRelayHealthResponse,
}

// ponytail: one cached/in-flight batch bounds memory and total sockets to eight.
// Use keyed slots only if simultaneous independent wallet pools become necessary.
static RELAY_HEALTH: Lazy<Mutex<Option<CachedHealth>>> = Lazy::new(|| Mutex::new(None));

async fn cached_health(
    cache: &Mutex<Option<CachedHealth>>,
    key: HealthCacheKey,
    relays: &[HealthRelay],
    force: bool,
    is_current: impl Fn() -> bool,
    probe: impl Future<Output = NostrRelayHealthResponse>,
) -> NostrRelayHealthResponse {
    let requested_at = Instant::now();
    let mut cached = cache.lock().await;
    // In particular, a locked wallet must never recover an old cached success.
    if !is_current() {
        *cached = None;
        return blocked_health(relays, HEALTH_STALE);
    }
    if let Some(entry) = cached.as_ref() {
        if entry.key == key && entry.completed_at.elapsed() < HEALTH_TTL
            // Force refreshes still join an identical batch already underway.
            && (!force || entry.completed_at >= requested_at)
        {
            return entry.response.clone();
        }
    }
    let changed = async {
        while is_current() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let response = tokio::select! {
        biased;
        () = changed => {
            *cached = None;
            return blocked_health(relays, HEALTH_STALE);
        }
        response = probe => response,
    };
    if !is_current() {
        *cached = None;
        return blocked_health(relays, HEALTH_STALE);
    }
    *cached = Some(CachedHealth {
        key,
        completed_at: Instant::now(),
        response: response.clone(),
    });
    response
}

async fn health_tor_port(
    public_allowed: bool,
    verified_proxy: impl Future<Output = Result<Option<u16>, String>>,
) -> Result<u16, &'static str> {
    if !public_allowed {
        return Err(HEALTH_POLICY_BLOCKED);
    }
    // Strictly Tor-only: even a loopback-only pool cannot opt into direct I/O.
    verified_proxy
        .await
        .ok()
        .flatten()
        .filter(|port| *port != 0)
        .ok_or(HEALTH_TOR_REQUIRED)
}

/// Only an HTTP upgrade and a WebSocket close frame. No Nostr identity, events,
/// subscriptions, authentication, ping loop, or publication is involved.
async fn health_handshake<S>(url: &str, stream: S) -> Result<(), &'static str>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut websocket, _) = tokio_tungstenite::client_async(url, stream)
        .await
        .map_err(|_| "Relay WebSocket handshake failed.")?;
    websocket
        .close(None)
        .await
        .map_err(|_| "Relay WebSocket close failed.")
}

async fn probe_health_relay(relay: &HealthRelay, socks_port: u16) -> NostrRelayHealth {
    let result = tokio::time::timeout(HEALTH_TIMEOUT, async {
        let stream = connect_stream(
            &relay.host,
            relay.port,
            true,
            Transport::Tor {
                host: crate::fusion::tor::DEFAULT_TOR_HOST,
                port: socks_port,
            },
        )
        .await
        .map_err(|_| "Relay connection through Tor failed.")?;
        health_handshake(&relay.websocket_url, stream).await
    })
    .await;
    let reason = match result {
        Ok(Ok(())) => None,
        Ok(Err(reason)) => Some(reason.to_owned()),
        Err(_) => Some("Relay check through Tor timed out after 15 seconds.".to_owned()),
    };
    NostrRelayHealth {
        url: relay.url.clone(),
        reachable: Some(reason.is_none()),
        reason,
    }
}

/// Check only the supplied configured Nostr pool, without expanding it from the
/// chain catalog. The renderer supplies neither a proxy nor routing authority.
#[tauri::command]
pub async fn nostr_relay_health(
    relays: Vec<String>,
    network: String,
    force: bool,
    runtime: tauri::State<'_, AppRuntime>,
    native: tauri::State<'_, Arc<crate::chain_runtime::NativeChainRuntime>>,
    network_settings: tauri::State<'_, crate::network_config::NetworkSettingsStore>,
) -> Result<NostrRelayHealthResponse, String> {
    let relays = match health_relays(relays) {
        Ok(relays) => relays,
        Err(reason) => return Ok(blocked_health(&[], reason)),
    };
    let network = match network.parse::<Network>() {
        Ok(network) => network,
        Err(_) => return Ok(blocked_health(&relays, "Unknown relay health network.")),
    };
    let state_rx = runtime.subscribe_state();
    let context = match health_context(&state_rx.borrow(), network, native.policy_generation()) {
        Ok(context) => context,
        Err(reason) => return Ok(blocked_health(&relays, reason)),
    };
    if relays.is_empty() {
        return Ok(NostrRelayHealthResponse {
            relays: Vec::new(),
            error: None,
        });
    }
    let is_current =
        || health_context(&state_rx.borrow(), network, native.policy_generation()) == Ok(context);
    let key = HealthCacheKey {
        context,
        urls: relays.iter().map(|relay| relay.url.clone()).collect(),
    };
    Ok(
        cached_health(&RELAY_HEALTH, key, &relays, force, is_current, async {
            let route = tokio::time::timeout(HEALTH_TIMEOUT, async {
                // Pair generation with a completed policy write, never its interim
                // old file. Release this lock before any relay connection starts.
                let _settings = network_settings.write_lock.lock().await;
                if !is_current() {
                    return Err(HEALTH_STALE);
                }
                let public_allowed = native.tor_status_for_update_check().await.0;
                let hosts: Vec<_> = relays.iter().map(|relay| relay.host.as_str()).collect();
                health_tor_port(
                    public_allowed,
                    crate::verified_native_proxy_for_network(&hosts, &network_settings, network),
                )
                .await
            })
            .await;
            let port = match route {
                Ok(Ok(port)) if is_current() => port,
                Ok(Ok(_)) => return blocked_health(&relays, HEALTH_STALE),
                Ok(Err(reason)) => return blocked_health(&relays, reason),
                Err(_) => {
                    return blocked_health(
                        &relays,
                        "Tor route verification timed out; no relays were checked.",
                    )
                }
            };
            let relay_inputs = &relays;
            let mut results: Vec<_> = futures_util::stream::iter(0..relay_inputs.len())
                .map(|index| async move {
                    let relay = &relay_inputs[index];
                    let result = if is_current() {
                        probe_health_relay(relay, port).await
                    } else {
                        NostrRelayHealth {
                            url: relay.url.clone(),
                            reachable: None,
                            reason: Some(HEALTH_STALE.to_owned()),
                        }
                    };
                    (index, result)
                })
                .buffer_unordered(HEALTH_CONCURRENCY)
                .collect()
                .await;
            results.sort_unstable_by_key(|(index, _)| *index);
            NostrRelayHealthResponse {
                relays: results.into_iter().map(|(_, result)| result).collect(),
                error: None,
            }
        })
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn relays(urls: &[&str]) -> Vec<HealthRelay> {
        health_relays(urls.iter().map(|url| (*url).to_owned()).collect()).unwrap()
    }

    fn context() -> HealthContext {
        HealthContext {
            network: Network::Chipnet,
            unlock_epoch: 7,
            policy_generation: 11,
        }
    }

    fn key(relays: &[HealthRelay]) -> HealthCacheKey {
        HealthCacheKey {
            context: context(),
            urls: relays.iter().map(|relay| relay.url.clone()).collect(),
        }
    }

    #[test]
    fn relay_health_validates_whole_batch_bounds_and_canonical_duplicates() {
        for invalid in [
            "ws://relay.invalid",
            "https://relay.invalid",
            "wss://",
            "wss://user@relay.invalid",
            "wss://@relay.invalid",
            "wss://user:pass@relay.invalid",
            "wss://relay.invalid/#",
            "wss://relay.invalid:0",
            "wss://relay.invalid:65536",
            " wss://relay.invalid",
            "wss://relay.invalid/\n",
            "wss://relay.invalid\\path",
        ] {
            assert!(
                health_relays(vec!["wss://valid.invalid".into(), invalid.into()]).is_err(),
                "{invalid}"
            );
        }
        let base = "wss://relay.invalid/";
        let longest = format!("{base}{}", "a".repeat(HEALTH_MAX_URL_BYTES - base.len()));
        assert!(health_relays(vec![longest.clone()]).is_ok());
        assert!(health_relays(vec![format!("{longest}a")]).is_err());
        assert!(health_relays(vec![base.into(); HEALTH_MAX_RELAYS]).is_ok());
        assert!(health_relays(vec![base.into(); HEALTH_MAX_RELAYS + 1]).is_err());
        assert!(health_relays(Vec::new()).unwrap().is_empty());
        let selected = relays(&[
            "wss://RELAY.invalid:443",
            "wss://relay.invalid/",
            "wss://[::1]:444/path?key=value",
        ]);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].url, "wss://RELAY.invalid:443");
        assert_eq!(selected[1].host, "::1");
        assert_eq!(selected[1].port, 444);
    }

    #[tokio::test]
    async fn relay_health_blocks_policy_and_missing_tor_without_dialing() {
        let denied = health_tor_port(false, async {
            panic!("blocked policy must not even verify a proxy")
        })
        .await;
        assert_eq!(denied, Err(HEALTH_POLICY_BLOCKED));
        assert_eq!(
            health_tor_port(true, async { Ok(None) }).await,
            Err(HEALTH_TOR_REQUIRED)
        );
        assert_eq!(
            health_tor_port(true, async { Ok(Some(0)) }).await,
            Err(HEALTH_TOR_REQUIRED)
        );
        assert_eq!(
            health_tor_port(true, async { Err("proxy unavailable".into()) }).await,
            Err(HEALTH_TOR_REQUIRED)
        );
        assert_eq!(
            health_tor_port(true, async { Ok(Some(9050)) }).await,
            Ok(9050)
        );
        let response = blocked_health(&relays(&["wss://relay.invalid"]), HEALTH_POLICY_BLOCKED);
        let json = serde_json::to_value(response).unwrap();
        assert!(json["relays"][0]["reachable"].is_null());
        assert_eq!(json["relays"][0]["reason"], HEALTH_POLICY_BLOCKED);
    }

    #[test]
    fn relay_health_requires_open_wallet_matching_network_and_epoch() {
        let mut state = optn_app::AppState::default();
        let network = state.network;
        assert!(health_context(&state, network, 1).is_err());
        state.wallet = Some(optn_app::OpenedWallet {
            kind: optn_app::WalletKind::WatchOnly,
            name: "public test fixture".into(),
            receive_address: String::new(),
            master_fingerprint: None,
            account_path: String::new(),
            multisig_policy: None,
            account_xpub: None,
        });
        state.network = Network::Chipnet;
        assert!(health_context(&state, Network::Mainnet, 1).is_err());
        let before = health_context(&state, Network::Chipnet, 1).unwrap();
        assert_ne!(health_context(&state, Network::Chipnet, 2).unwrap(), before);
        state.lock.unlock_epoch += 1;
        assert_ne!(health_context(&state, Network::Chipnet, 1).unwrap(), before);
        state.wallet = None;
        assert!(health_context(&state, Network::Chipnet, 1).is_err());
    }

    #[tokio::test]
    async fn relay_health_cache_coalesces_force_expires_and_discards_stale_results() {
        let relays = relays(&["wss://relay.invalid"]);
        let cache = Mutex::new(None);
        let calls = AtomicUsize::new(0);
        let current = AtomicBool::new(true);
        let probe = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            blocked_health(&relays, HEALTH_TOR_REQUIRED)
        };
        let (first, second) = tokio::join!(
            cached_health(&cache, key(&relays), &relays, false, || true, probe()),
            cached_health(&cache, key(&relays), &relays, true, || true, probe()),
        );
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cached_health(&cache, key(&relays), &relays, false, || true, probe()).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cached_health(&cache, key(&relays), &relays, true, || true, probe()).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        cache.lock().await.as_mut().unwrap().completed_at = Instant::now() - HEALTH_TTL;
        cached_health(&cache, key(&relays), &relays, false, || true, probe()).await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let response = cached_health(&cache, key(&relays), &relays, false, || false, async {
            panic!("closed wallet must not use cache or I/O")
        })
        .await;
        assert_eq!(response.error.as_deref(), Some(HEALTH_STALE));
        assert!(cache.lock().await.is_none());
        let response = cached_health(
            &cache,
            key(&relays),
            &relays,
            false,
            || current.load(Ordering::SeqCst),
            async {
                current.store(false, Ordering::SeqCst);
                NostrRelayHealthResponse {
                    relays: vec![NostrRelayHealth {
                        url: relays[0].url.clone(),
                        reachable: Some(true),
                        reason: None,
                    }],
                    error: None,
                }
            },
        )
        .await;
        assert_eq!(response.relays[0].reachable, None);
        assert!(cache.lock().await.is_none());
    }

    #[tokio::test]
    async fn relay_health_cache_is_scoped_to_network_unlock_policy_and_pool() {
        let selected = relays(&["wss://relay.invalid"]);
        let cache = Mutex::new(None);
        let calls = AtomicUsize::new(0);
        let probe = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            blocked_health(&selected, HEALTH_TOR_REQUIRED)
        };
        for changed_context in [
            HealthContext {
                network: Network::Mainnet,
                ..context()
            },
            HealthContext {
                unlock_epoch: 8,
                ..context()
            },
            HealthContext {
                policy_generation: 12,
                ..context()
            },
        ] {
            cached_health(&cache, key(&selected), &selected, false, || true, probe()).await;
            let before = calls.load(Ordering::SeqCst);
            let mut changed_key = key(&selected);
            changed_key.context = changed_context;
            cached_health(&cache, changed_key, &selected, false, || true, probe()).await;
            assert_eq!(calls.load(Ordering::SeqCst), before + 1);
        }
        cached_health(&cache, key(&selected), &selected, false, || true, probe()).await;
        let other_pool = relays(&["wss://other.invalid"]);
        let response = cached_health(
            &cache,
            key(&other_pool),
            &other_pool,
            false,
            || true,
            async { blocked_health(&other_pool, HEALTH_TOR_REQUIRED) },
        )
        .await;
        assert_eq!(response.relays[0].url, other_pool[0].url);
    }

    #[tokio::test]
    async fn relay_health_cancels_pending_io_when_context_changes() {
        let selected = relays(&["wss://relay.invalid"]);
        let cache = Mutex::new(None);
        let current = AtomicBool::new(true);
        let (sender, cancelled) = tokio::sync::oneshot::channel::<()>();
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            cached_health(
                &cache,
                key(&selected),
                &selected,
                false,
                || current.load(Ordering::SeqCst),
                async {
                    let _held_by_pending_io = sender;
                    current.store(false, Ordering::SeqCst);
                    std::future::pending().await
                },
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.relays[0].reachable, None);
        assert_eq!(response.error.as_deref(), Some(HEALTH_STALE));
        assert!(
            cancelled.await.is_err(),
            "the stale I/O future must be dropped"
        );
        assert!(cache.lock().await.is_none());
    }

    #[tokio::test]
    async fn relay_health_local_handshake_sends_only_close() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = async {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(
                matches!(socket.next().await.unwrap().unwrap(), Message::Close(None)),
                "health probes must not send EVENT, REQ, AUTH, profiles or other Nostr frames"
            );
        };
        let client = async {
            let stream = connect_stream("127.0.0.1", address.port(), false, Transport::Direct)
                .await
                .unwrap();
            // Plaintext is limited to this private loopback fixture; the command
            // validator above accepts only wss and the probe always uses Tor+TLS.
            health_handshake(&format!("ws://{address}"), stream)
                .await
                .unwrap();
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client);
        })
        .await
        .unwrap();
    }
}
