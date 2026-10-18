//! Every connection the desktop app makes on the renderer's behalf, routed by
//! the holder's Tor switch (#75 §4.1).
//!
//! The webview cannot reach the network itself: its CSP allows only the app's
//! own origin, IPC and loopback. HTTP, WebSockets, images and the legacy
//! Electrum socket all come through here, ask [`decide`] how to reach their
//! host, and reach it that way or not at all.
//!
//! - Loopback is direct: there is no network hop to hide.
//! - With Tor on, a node the holder declared as their own is direct, and
//!   everything else goes through a Tor proxy whose provenance is verified.
//!   No verified Tor means no connection, never a quiet direct one.
//! - With Tor off, everything is direct.
//!
//! A request answers to two networks: the shared runtime's and the one the
//! requesting window is on, which can differ when windows show wallets on
//! different networks. The stricter of the two decides, so no window is ever
//! routed more loosely than its own network says.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use optn_core::network::Network;
use optn_runtime::chain::SourceCatalog;
use serde::{Deserialize, Serialize};

use crate::network_config::NetworkSettingsStore;

pub(crate) const TOR_NEEDED: &str = "Tor is on and no verified Tor is running. Start Tor in \
     Settings > Servers > Privacy & Transport, or turn Tor off.";

/// How one host is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum EgressRoute {
    Direct,
    Tor { socks_port: u16 },
}

/// The route, and whether the host is the holder's own on every network the
/// request answers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EgressDecision {
    pub route: EgressRoute,
    pub own: bool,
}

/// The networks a request answers to: the runtime's, and the requesting
/// window's when it names a different one.
pub(crate) fn networks_for(runtime: Network, requested: Option<&str>) -> Vec<Network> {
    let mut networks = vec![runtime];
    if let Some(network) = requested.and_then(|value| value.parse::<Network>().ok()) {
        if network != runtime {
            networks.push(network);
        }
    }
    networks
}

/// Whether the holder declared `host` as one of their own nodes.
fn declared_own_host(catalog: &SourceCatalog, host: &str) -> bool {
    let host = host.trim_end_matches('.');
    catalog.iter().any(|source| {
        source.is_enabled()
            && source.is_user_infrastructure()
            && source.endpoints.iter().any(|endpoint| {
                endpoint
                    .host
                    .trim_end_matches('.')
                    .eq_ignore_ascii_case(host)
            })
    })
}

/// A verified Tor port, remembered briefly so a burst of small requests does
/// not probe the proxy once each.
async fn verified_tor_port(trusted: &[u16]) -> Option<u16> {
    const FRESH_FOR: Duration = Duration::from_secs(5);
    type Remembered = Option<(Instant, Option<u16>, Vec<u16>, Option<u16>)>;
    static LAST: OnceLock<Mutex<Remembered>> = OnceLock::new();
    let managed = crate::fusion::tor_manager::owned_socks_port();
    let last = LAST.get_or_init(Mutex::default);
    if let Ok(guard) = last.lock() {
        if let Some((at, seen_managed, seen_trusted, port)) = guard.as_ref() {
            if at.elapsed() < FRESH_FOR && *seen_managed == managed && seen_trusted == trusted {
                return *port;
            }
        }
    }
    let port = optn_chain_native::tor_status_from_trust(optn_chain_native::TorProxyTrust {
        managed: managed.as_slice(),
        trusted,
    })
    .await
    .usable_port();
    if let Ok(mut guard) = last.lock() {
        *guard = Some((Instant::now(), managed, trusted.to_vec(), port));
    }
    port
}

/// How the app reaches `host` for a request answering to `networks`, or why
/// it may not. Tor if the switch requires it on any of them; own only if the
/// host is declared own on all of them.
pub(crate) async fn decide(
    host: &str,
    network_settings: &NetworkSettingsStore,
    networks: &[Network],
) -> Result<EgressDecision, String> {
    if optn_core::endpoint::is_loopback_host(host) {
        return Ok(EgressDecision {
            route: EgressRoute::Direct,
            own: true,
        });
    }
    let settings = network_settings.clone();
    let owned_host = host.to_owned();
    let networks = networks.to_vec();
    let (requires_tor, own, trusted) = tokio::task::spawn_blocking(move || {
        let mut requires_tor = false;
        let mut own_everywhere = true;
        let mut trusted = Vec::new();
        for network in networks {
            let transport = settings.transport(network)?;
            let own = settings
                .chain_selection(network)?
                .is_some_and(|(catalog, _)| declared_own_host(&catalog, &owned_host));
            requires_tor |= transport.tor_for(own);
            own_everywhere &= own;
            for port in settings.trusted_socks_ports(network) {
                if !trusted.contains(&port) {
                    trusted.push(port);
                }
            }
        }
        Ok::<_, String>((requires_tor, own_everywhere, trusted))
    })
    .await
    .map_err(|_| "network settings reader stopped".to_string())??;
    if !requires_tor {
        return Ok(EgressDecision {
            route: EgressRoute::Direct,
            own,
        });
    }
    verified_tor_port(&trusted)
        .await
        .map(|socks_port| EgressDecision {
            route: EgressRoute::Tor { socks_port },
            own,
        })
        .ok_or_else(|| TOR_NEEDED.to_string())
}

/// A byte stream to `host:port` over `route`, TLS when asked.
///
/// `public_only` makes a direct connection only to the public addresses the
/// name resolved to, and refuses a name with none. It is for destinations a
/// peer or a dApp supplied: with Tor off they must not be able to aim the
/// wallet at the holder's own network. The checked addresses are the ones
/// dialled, so a second resolution cannot swap in a private one. Over Tor the
/// exit resolves the name and cannot reach that network anyway.
pub(crate) async fn open_stream(
    host: &str,
    port: u16,
    tls: bool,
    route: EgressRoute,
    public_only: bool,
) -> Result<crate::fusion::FusionStream, String> {
    let stream = match route {
        EgressRoute::Tor { socks_port } => {
            return crate::fusion::connect_stream(
                host,
                port,
                tls,
                crate::fusion::Transport::Tor {
                    host: crate::fusion::tor::DEFAULT_TOR_HOST,
                    port: socks_port,
                },
            )
            .await;
        }
        EgressRoute::Direct if public_only && !optn_core::endpoint::is_loopback_host(host) => {
            let addresses = public_addresses(host, port).await?;
            crate::electrum_tcp::open_stream_to(&addresses, host, tls).await?
        }
        EgressRoute::Direct => crate::electrum_tcp::open_stream(host, port, tls).await?,
    };
    Ok(match stream {
        crate::electrum_tcp::ElectrumStream::Plain(stream) => Box::new(stream),
        crate::electrum_tcp::ElectrumStream::Tls(stream) => Box::new(*stream),
    })
}

/// The public addresses `host` resolves to, or a refusal when it has none.
async fn public_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("cannot resolve {host}: {error}"))?
        .filter(|address| optn_chain_native::registry_fetch::is_public_address(address.ip()))
        .collect();
    if addresses.is_empty() {
        return Err(format!("{host} does not resolve to a public address"));
    }
    Ok(addresses)
}

/// An HTTP client over `route`, reused for the same destination. Redirects
/// are followed by the caller, so each hop is checked like the first.
///
/// Over Tor each destination host gets its own SOCKS credential, and so its
/// own circuit: requests to different services cannot be linked by a shared
/// circuit, while a burst to one service does not build a circuit per request.
fn http_client(
    route: EgressRoute,
    timeout: Duration,
    public_only: bool,
    host: &str,
) -> Result<reqwest::Client, String> {
    type Key = (EgressRoute, bool, u64, String);
    static CLIENTS: OnceLock<Mutex<HashMap<Key, reqwest::Client>>> = OnceLock::new();
    const MAX_CLIENTS: usize = 64;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let key: Key = (route, public_only, timeout.as_secs(), host.clone());
    let clients = CLIENTS.get_or_init(Mutex::default);
    if let Some(client) = clients
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
    {
        return Ok(client);
    }
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(15)));
    let builder = match route {
        EgressRoute::Tor { socks_port } => {
            let token = isolation_token(&host);
            builder.proxy(
                reqwest::Proxy::all(format!(
                    "socks5h://{token}:{token}@{}:{socks_port}",
                    crate::fusion::tor::DEFAULT_TOR_HOST
                ))
                .map_err(|error| format!("Tor proxy is invalid: {error}"))?,
            )
        }
        EgressRoute::Direct if public_only => builder.no_proxy().dns_resolver(Arc::new(
            optn_chain_native::registry_fetch::PublicAddressesOnly,
        )),
        // No proxy from the environment either: the holder chose a direct
        // connection, and a variable set for some other program is not that.
        EgressRoute::Direct => builder.no_proxy(),
    };
    let client = builder
        .build()
        .map_err(|error| format!("HTTP client could not start: {error}"))?;
    if let Ok(mut cache) = clients.lock() {
        if cache.len() >= MAX_CLIENTS {
            cache.clear();
        }
        cache.insert(key, client.clone());
    }
    Ok(client)
}

/// A SOCKS credential for one destination host, fresh for each run of the app.
fn isolation_token(host: &str) -> String {
    use std::hash::{Hash, Hasher};
    static RUN: OnceLock<u128> = OnceLock::new();
    let run = *RUN.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    host.hash(&mut hasher);
    format!("optn-egress-{run:x}-{:016x}", hasher.finish())
}

// ---------------------------------------------------------------------------
// HTTP for the renderer
// ---------------------------------------------------------------------------

/// The hosts the renderer's HTTP may reach: exactly those its CSP allowed
/// before every request came here. Routing through Rust adds privacy, never
/// new destinations.
fn http_host_allowed(host: &str) -> bool {
    const EXACT: &[&str] = &[
        "app.cauldron.quest",
        "indexer.riften.net",
        "indexer-chipnet.riften.net",
        "cashtokens.org",
    ];
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    EXACT.contains(&host.as_str()) || host.ends_with(".optnlabs.com")
}

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const HTTP_DEADLINE: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: usize = 5;

/// Headers the renderer may not set: identity, cookies and framing belong to
/// the host, not to a page.
fn header_forwardable(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "origin"
            | "referer"
            | "cookie"
            | "cookie2"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "keep-alive"
            | "proxy-authorization"
            | "te"
            | "upgrade"
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestIn {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body_base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseOut {
    status: u16,
    headers: Vec<(String, String)>,
    body_base64: String,
    url: String,
}

fn https_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("only HTTPS is allowed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with credentials are not allowed".into());
    }
    if url.host_str().is_none() {
        return Err("URL has no host".into());
    }
    Ok(url)
}

/// One HTTP request for the renderer, under the Tor switch.
#[tauri::command]
pub async fn optn_http_fetch(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    request: HttpRequestIn,
    network: Option<String>,
) -> Result<HttpResponseOut, String> {
    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| "invalid HTTP method".to_string())?;
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err(format!("HTTP method {method} is not allowed"));
    }
    let body = match request.body_base64.as_deref() {
        Some(encoded) => Some(base64_decode(encoded)?),
        None => None,
    };
    if body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err("request body is too large".into());
    }
    let networks = networks_for(runtime.state().network, network.as_deref());
    let mut url = https_url(&request.url)?;
    let mut method = method;
    let mut body = body;
    for _ in 0..=MAX_REDIRECTS {
        let host = url.host_str().unwrap_or_default().to_owned();
        if !http_host_allowed(&host) {
            return Err(format!("{host} is not a destination this app contacts"));
        }
        let route = decide(&host, &network_settings, &networks).await?.route;
        let client = http_client(route, HTTP_DEADLINE, false, &host)?;
        let mut builder = client.request(method.clone(), url.clone());
        for (name, value) in &request.headers {
            if header_forwardable(name) {
                builder = builder.header(name.as_str(), value.as_str());
            }
        }
        if let Some(body) = &body {
            builder = builder.body(body.clone());
        }
        let response = builder
            .send()
            .await
            .map_err(|error| format!("request to {host} failed: {error}"))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("redirect without a location")?;
            url = https_url(
                url.join(location)
                    .map_err(|_| "invalid redirect location".to_string())?
                    .as_str(),
            )?;
            if status == reqwest::StatusCode::SEE_OTHER
                || (matches!(status.as_u16(), 301 | 302) && method == reqwest::Method::POST)
            {
                method = reqwest::Method::GET;
                body = None;
            }
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| !name.as_str().eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(name, value)| {
                Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
            })
            .collect();
        let final_url = response.url().to_string();
        let bytes = read_bounded(response, MAX_RESPONSE_BYTES).await?;
        return Ok(HttpResponseOut {
            status: status.as_u16(),
            headers,
            body_base64: crate::token_images::base64(&bytes),
            url: final_url,
        });
    }
    Err("too many redirects".into())
}

async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("response is too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("response failed: {error}"))?
    {
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err("response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let trimmed = value.trim_end_matches('=');
    let mut out = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in trimmed.bytes() {
        let value = sextet(byte).ok_or("invalid base64 body")?;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Images for the renderer
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const IMAGE_DEADLINE: Duration = Duration::from_secs(20);
const MAX_CACHED_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// An image URL a dApp, peer, add-on or indexer may name: HTTPS to a public
/// name. Addresses and local names are refused outright, as registry URIs
/// are, so a URL cannot aim the wallet at the holder's own network.
fn image_url(value: &str) -> Result<reqwest::Url, String> {
    let url = https_url(value)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<IpAddr>().is_ok()
        || optn_core::endpoint::is_loopback_host(bare)
        || bare == "localhost"
        || bare.trim_end_matches('.').ends_with(".localhost")
    {
        return Err("images are fetched from public names only".into());
    }
    Ok(url)
}

/// The type of a remote icon, judged from its bytes: what token images allow,
/// plus the icon formats dApps commonly name (ICO, BMP, AVIF).
fn remote_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if let Some(media_type) = crate::token_images::image_media_type(bytes) {
        return Some(media_type);
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0x02, 0x00])
    {
        return Some("image/x-icon");
    }
    if bytes.len() >= 14 && bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 16 && &bytes[4..8] == b"ftyp" {
        let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let brands = &bytes[8..size.clamp(16, bytes.len())];
        if brands
            .chunks_exact(4)
            .any(|brand| brand == b"avif" || brand == b"avis")
        {
            return Some("image/avif");
        }
    }
    None
}

/// A remote image named by a dApp, a peer, an add-on or an indexer, as a
/// `data:` URL, fetched under the Tor switch. Only bounded bytes of a
/// recognised image type come back; anything else is `None`.
#[tauri::command]
pub async fn optn_remote_image(
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    url: String,
    network: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(hit) = image_cache().lock().ok().and_then(|cache| cache.get(&url)) {
        return Ok(Some(hit));
    }
    let networks = networks_for(runtime.state().network, network.as_deref());
    let mut current = image_url(&url)?;
    for _ in 0..=3 {
        let host = current.host_str().unwrap_or_default().to_owned();
        let decision = decide(&host, &network_settings, &networks).await?;
        let client = http_client(decision.route, IMAGE_DEADLINE, !decision.own, &host)?;
        let Ok(response) = client.get(current.clone()).send().await else {
            return Ok(None);
        };
        if response.status().is_redirection() {
            let Some(next) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| current.join(location).ok())
            else {
                return Ok(None);
            };
            let Ok(next) = image_url(next.as_str()) else {
                return Ok(None);
            };
            current = next;
            continue;
        }
        if !response.status().is_success() {
            return Ok(None);
        }
        let Ok(bytes) = read_bounded(response, MAX_IMAGE_BYTES).await else {
            return Ok(None);
        };
        let Some(media_type) = remote_image_media_type(&bytes) else {
            return Ok(None);
        };
        let data_url = format!(
            "data:{media_type};base64,{}",
            crate::token_images::base64(&bytes)
        );
        if let Ok(mut cache) = image_cache().lock() {
            cache.insert(url, data_url.clone());
        }
        return Ok(Some(data_url));
    }
    Ok(None)
}

#[derive(Default)]
struct RemoteImageCache {
    entries: std::collections::VecDeque<(String, String)>,
    bytes: usize,
}

impl RemoteImageCache {
    fn get(&self, url: &str) -> Option<String> {
        self.entries
            .iter()
            .find(|(key, _)| key == url)
            .map(|(_, value)| value.clone())
    }

    fn insert(&mut self, url: String, value: String) {
        if value.len() > MAX_CACHED_IMAGE_BYTES {
            return;
        }
        while self.bytes + value.len() > MAX_CACHED_IMAGE_BYTES {
            let Some((_, evicted)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= evicted.len();
        }
        self.bytes += value.len();
        self.entries.push_back((url, value));
    }
}

fn image_cache() -> &'static Mutex<RemoteImageCache> {
    static CACHE: OnceLock<Mutex<RemoteImageCache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::{
        ChainSource, Endpoint, EndpointKind, SourceDisposition, SourceId, SourceOrigin,
        TransportPolicy,
    };

    fn temporary_store(label: &str) -> (NetworkSettingsStore, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "optn-egress-{label}-{}-{}",
            std::process::id(),
            isolation_token(label)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        (NetworkSettingsStore::new(directory.clone()), directory)
    }

    fn set_transport(store: &NetworkSettingsStore, network: Network, transport: TransportPolicy) {
        store
            .update_overlay(network, |overlay| {
                overlay.connection_policy.transport = transport;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn only_the_hosts_the_old_csp_allowed_are_reachable_over_http() {
        for host in [
            "price.optnlabs.com",
            "tokenindex.optnlabs.com",
            "indexer.riften.net",
            "INDEXER-CHIPNET.riften.net.",
            "app.cauldron.quest",
            "cashtokens.org",
        ] {
            assert!(http_host_allowed(host), "{host}");
        }
        for host in [
            "optnlabs.com.evil.example",
            "evil-optnlabs.com",
            "riften.net",
            "ipfs.io",
            "relay.walletconnect.com",
            "127.0.0.1",
        ] {
            assert!(!http_host_allowed(host), "{host}");
        }
        assert!(https_url("http://price.optnlabs.com/").is_err());
        assert!(https_url("https://user:pass@price.optnlabs.com/").is_err());
        assert!(https_url("https://price.optnlabs.com/v1/prices").is_ok());
    }

    #[test]
    fn renderer_headers_never_carry_identity_or_framing() {
        for name in ["Origin", "Cookie", "Host", "Referer", "Content-Length"] {
            assert!(!header_forwardable(name), "{name}");
        }
        for name in ["Accept", "Content-Type", "Authorization", "X-Api-Key"] {
            assert!(header_forwardable(name), "{name}");
        }
    }

    #[test]
    fn base64_round_trips_any_body() {
        for body in [
            b"".to_vec(),
            b"f".to_vec(),
            b"fo".to_vec(),
            b"foo".to_vec(),
            (0..=255u8).collect::<Vec<_>>(),
        ] {
            assert_eq!(base64_decode(&crate::token_images::base64(&body)), Ok(body));
        }
        assert!(base64_decode("not base64!").is_err());
    }

    #[test]
    fn only_a_declared_own_node_counts_as_the_holders() {
        let mut catalog = SourceCatalog::default();
        let mut source = ChainSource {
            id: SourceId::new("home"),
            label: "Home".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "Node.Home.Example.".into(),
                port: Some(50002),
            }],
            capabilities: Default::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        catalog.insert(source.clone()).unwrap();
        assert!(!declared_own_host(&catalog, "node.home.example"));
        source.origin = SourceOrigin::UserInfrastructure {
            group: "home".into(),
        };
        let mut catalog = SourceCatalog::default();
        catalog.insert(source).unwrap();
        assert!(declared_own_host(&catalog, "node.home.example"));
        assert!(!declared_own_host(&catalog, "other.example"));
    }

    /// The route alone, for one network.
    async fn route_for(
        host: &str,
        store: &NetworkSettingsStore,
        network: Network,
    ) -> Result<EgressRoute, String> {
        decide(host, store, &[network])
            .await
            .map(|decision| decision.route)
    }

    /// The switch decides: Direct when off, Tor or refusal when on, and a
    /// declared own node direct with Tor on.
    #[tokio::test]
    async fn the_tor_switch_decides_every_route() {
        let (store, directory) = temporary_store("switch");
        let network = Network::Chipnet;
        assert_eq!(
            route_for("127.0.0.1", &store, network).await,
            Ok(EgressRoute::Direct)
        );
        set_transport(&store, network, TransportPolicy::Direct);
        assert_eq!(
            route_for("relay.example.org", &store, network).await,
            Ok(EgressRoute::Direct)
        );
        set_transport(&store, network, TransportPolicy::Tor);
        // Tor on: a verified proxy, or a refusal. Never Direct for a public host.
        match route_for("relay.example.org", &store, network).await {
            Ok(EgressRoute::Tor { .. }) => {}
            Err(reason) => assert_eq!(reason, TOR_NEEDED),
            Ok(EgressRoute::Direct) => panic!("Tor on must never route a public host directly"),
        }
        // The holder's own node is direct with Tor on.
        store
            .update_overlay(network, |overlay| {
                optn_runtime::network_config::add_user_source_services(
                    overlay,
                    "Home",
                    vec![Endpoint {
                        kind: EndpointKind::ElectrumTls,
                        host: "node.home.example".into(),
                        port: Some(50002),
                    }],
                    Some("home"),
                )
                .map(|_| ())
            })
            .unwrap();
        assert_eq!(
            decide("NODE.home.example.", &store, &[network]).await,
            Ok(EgressDecision {
                route: EgressRoute::Direct,
                own: true
            })
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    /// A window on a network with Tor on is never routed directly because the
    /// shared runtime is on another network with Tor off.
    #[tokio::test]
    async fn the_stricter_of_two_networks_decides() {
        let (store, directory) = temporary_store("networks");
        set_transport(&store, Network::Chipnet, TransportPolicy::Direct);
        set_transport(&store, Network::Mainnet, TransportPolicy::Tor);
        let networks = networks_for(Network::Chipnet, Some("mainnet"));
        assert_eq!(networks, vec![Network::Chipnet, Network::Mainnet]);
        match decide("relay.example.org", &store, &networks).await {
            Ok(EgressDecision {
                route: EgressRoute::Tor { .. },
                ..
            }) => {}
            Err(reason) => assert_eq!(reason, TOR_NEEDED),
            Ok(decision) => panic!("Tor on for the window's network was ignored: {decision:?}"),
        }
        assert_eq!(
            networks_for(Network::Chipnet, Some("not a network")),
            vec![Network::Chipnet]
        );
        assert_eq!(
            decide("relay.example.org", &store, &[Network::Chipnet]).await,
            Ok(EgressDecision {
                route: EgressRoute::Direct,
                own: false
            })
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_direct_connection_dials_only_checked_public_addresses() {
        assert!(public_addresses("localhost", 443).await.is_err());
    }

    #[test]
    fn icons_are_fetched_from_public_names_only() {
        for url in [
            "https://192.168.1.1/x.png",
            "https://[::1]/x.png",
            "https://[::ffff:10.0.0.1]:9100/x",
            "https://2130706433/x.png",
            "https://localhost/x.png",
            "https://app.localhost./x.png",
            "http://cdn.example.org/x.png",
        ] {
            assert!(image_url(url).is_err(), "{url}");
        }
        assert!(image_url("https://cdn.example.org/icon.png").is_ok());
    }

    #[test]
    fn common_dapp_icon_formats_are_recognised() {
        assert_eq!(
            remote_image_media_type(&[0, 0, 1, 0, 1, 0, 16, 16]),
            Some("image/x-icon")
        );
        let mut bmp = b"BM".to_vec();
        bmp.resize(20, 0);
        assert_eq!(remote_image_media_type(&bmp), Some("image/bmp"));
        let mut avif = vec![0, 0, 0, 24];
        avif.extend_from_slice(b"ftypavif");
        avif.extend_from_slice(&[0, 0, 0, 0]);
        avif.extend_from_slice(b"mif1miaf");
        assert_eq!(remote_image_media_type(&avif), Some("image/avif"));
        assert_eq!(
            remote_image_media_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(remote_image_media_type(b"<html>"), None);
    }

    #[test]
    fn one_circuit_per_destination_host_for_this_run() {
        assert_eq!(isolation_token("a.example"), isolation_token("a.example"));
        assert_ne!(isolation_token("a.example"), isolation_token("b.example"));
        assert!(isolation_token(&"x".repeat(253)).len() < 64);
    }
}
