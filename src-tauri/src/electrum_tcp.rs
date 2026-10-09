// Native TCP(+TLS) transport for Electrum, desktop only.
//
// The web build talks to Electrum servers over WebSocket (wss://, port 50004)
// because that is all a browser/WebView can open. But most Fulcrum servers only
// publish the raw TCP-SSL port (50002) with no WSS listener — so on the web
// build they are simply unreachable. On desktop we have a real socket, so this
// module is a thin byte-pipe: it opens a persistent TCP(+TLS) connection, streams
// bytes back to the frontend as Tauri events, and forwards writes. The Electrum
// JSON-RPC framing (newline-delimited) is left entirely to the existing JS
// client — this side moves bytes, nothing more.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// One open socket: the channel the JS `write()` path pushes outbound bytes
/// into, the page that opened it, the server and network it was allowed for,
/// and its task, which closing aborts so the socket goes away at once rather
/// than when the server hangs up.
struct Connection {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    owner: String,
    network: optn_core::network::Network,
    host: String,
    port: u16,
    tls: bool,
    task: tokio::task::AbortHandle,
}

static CONNECTIONS: Lazy<Mutex<HashMap<u32, Connection>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// A connect or TLS handshake that has not finished by now never will.
const CONNECT_DEADLINE: Duration = Duration::from_secs(20);

static NEXT_ID: Lazy<std::sync::atomic::AtomicU32> =
    Lazy::new(|| std::sync::atomic::AtomicU32::new(1));

fn data_event(id: u32) -> String {
    format!("electrum-tcp://data/{id}")
}
fn closed_event(id: u32) -> String {
    format!("electrum-tcp://closed/{id}")
}

/// Drive one connection: split the stream, forward outbound bytes from `rx`, and
/// emit inbound bytes as `data` events until EOF/error, then a `closed` event.
async fn run_connection<S>(
    app: AppHandle,
    id: u32,
    stream: S,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
) where
    S: AsyncReadExt + AsyncWriteExt + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);

    let writer_task = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break, // clean EOF
            Ok(n) => {
                // Electrum framing is UTF-8 JSON lines; forward as text.
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                if app.emit(&data_event(id), chunk).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    writer_task.abort();
    CONNECTIONS.lock().await.remove(&id);
    let _ = app.emit(&closed_event(id), ());
}

/// Either transport, unified so the command and tests share one code path.
pub enum ElectrumStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

/// Open a TCP(+TLS) connection to an Electrum server. Split out from the command
/// (no AppHandle, no registry) so it can be exercised directly by an integration
/// test that does a real server.version round-trip.
pub async fn open_stream(host: &str, port: u16, use_ssl: bool) -> Result<ElectrumStream, String> {
    let tcp = tokio::time::timeout(CONNECT_DEADLINE, TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("connect {host}:{port} timed out"))?
        .map_err(|e| format!("connect {host}:{port} failed: {e}"))?;
    secure(tcp, host, use_ssl).await
}

/// As [`open_stream`], to addresses already resolved and checked. `host`
/// names the server for TLS only.
pub async fn open_stream_to(
    addresses: &[SocketAddr],
    host: &str,
    use_ssl: bool,
) -> Result<ElectrumStream, String> {
    let tcp = tokio::time::timeout(CONNECT_DEADLINE, TcpStream::connect(addresses))
        .await
        .map_err(|_| format!("connect {host} timed out"))?
        .map_err(|e| format!("connect {host} failed: {e}"))?;
    secure(tcp, host, use_ssl).await
}

async fn secure(tcp: TcpStream, host: &str, use_ssl: bool) -> Result<ElectrumStream, String> {
    tcp.set_nodelay(true).ok();

    if !use_ssl {
        return Ok(ElectrumStream::Plain(tcp));
    }

    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    // Name the crypto provider explicitly (both ring and aws-lc-rs are reachable
    // in this tree) — same reasoning as the fusion client.
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS setup failed: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| format!("invalid server name: {host}"))?;
    let tls = tokio::time::timeout(
        CONNECT_DEADLINE,
        TlsConnector::from(Arc::new(config)).connect(server_name, tcp),
    )
    .await
    .map_err(|_| format!("TLS handshake with {host} timed out"))?
    .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?;
    Ok(ElectrumStream::Tls(Box::new(tls)))
}

/// Open a TCP(+TLS) connection to an Electrum server. Returns a connection id the
/// frontend uses for `electrum_tcp_send` / `electrum_tcp_close`, and listens on
/// `electrum-tcp://data/{id}` and `electrum-tcp://closed/{id}`.
///
/// Only a server the holder's source selection includes is dialled (see
/// `electrum_selection`); anything else is refused before any connection,
/// with a reason starting `electrum-not-selected`.
///
/// The connection follows the holder's Tor switch like every other route (see
/// `egress`): with Tor on, a public server is reached only through verified
/// Tor, so the addresses this socket asks about are never tied to this IP.
///
/// `network` is the requesting window's; see `egress::networks_for`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn electrum_tcp_connect(
    app: AppHandle,
    webview: tauri::Webview,
    host: String,
    port: u16,
    use_ssl: bool,
    network: Option<String>,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    network_settings: tauri::State<'_, crate::network_config::NetworkSettingsStore>,
) -> Result<u32, String> {
    let selected_for =
        crate::electrum_selection::requested_network(runtime.state().network, network.as_deref())?;
    crate::electrum_selection::check_dial(
        &runtime,
        &network_settings,
        selected_for,
        &host,
        port,
        use_ssl,
    )
    .await?;
    let networks = crate::egress::networks_for(runtime.state().network, network.as_deref());
    let route = crate::egress::decide(&host, &network_settings, &networks)
        .await?
        .route;
    // The holder named this server (or it ships with the app), so a direct
    // connection may reach their own network.
    let stream = crate::egress::open_stream(&host, port, use_ssl, route, false).await?;

    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    // Registered under the lock, so the task cannot remove its entry first.
    let mut connections = CONNECTIONS.lock().await;
    let task = tokio::spawn(run_connection(app, id, stream, rx));
    connections.insert(
        id,
        Connection {
            tx,
            owner: webview.label().to_owned(),
            network: selected_for,
            host,
            port,
            tls: use_ssl,
            task: task.abort_handle(),
        },
    );
    Ok(id)
}

/// Send bytes on an open connection.
#[tauri::command]
pub async fn electrum_tcp_send(id: u32, data: String) -> Result<(), String> {
    let conns = CONNECTIONS.lock().await;
    let connection = conns.get(&id).ok_or("connection not open")?;
    connection
        .tx
        .send(data.into_bytes())
        .map_err(|_| "connection closed".to_string())
}

/// Close a connection.
#[tauri::command]
pub async fn electrum_tcp_close(id: u32) -> Result<(), String> {
    if let Some(connection) = CONNECTIONS.lock().await.remove(&id) {
        connection.task.abort();
    }
    Ok(())
}

/// Close every socket a page opened. Called when it reloads or its window
/// closes: a browser socket would have died with the page, and so does this.
pub(crate) async fn close_owned_by(owner: &str) {
    CONNECTIONS.lock().await.retain(|_, connection| {
        let keep = connection.owner != owner;
        if !keep {
            connection.task.abort();
        }
        keep
    });
}

/// Close the sockets on `network` that its selection no longer includes, and
/// tell their pages. Called after the network's settings change: a server the
/// holder just disabled, banned or excluded by policy must not stay connected.
pub(crate) async fn revoke_unselected(
    app: &AppHandle,
    runtime: &optn_runtime::AppRuntime,
    settings: &crate::network_config::NetworkSettingsStore,
    network: optn_core::network::Network,
) {
    let targets: Vec<(u32, String, u16, bool)> = CONNECTIONS
        .lock()
        .await
        .iter()
        .filter(|(_, connection)| connection.network == network)
        .map(|(id, connection)| {
            (
                *id,
                connection.host.clone(),
                connection.port,
                connection.tls,
            )
        })
        .collect();
    if targets.is_empty() {
        return;
    }
    let mut revoke = Vec::new();
    for (id, host, port, tls) in targets {
        if crate::electrum_selection::check_dial(runtime, settings, network, &host, port, tls)
            .await
            .is_err()
        {
            revoke.push(id);
        }
    }
    let closed: Vec<u32> = {
        let mut connections = CONNECTIONS.lock().await;
        revoke
            .into_iter()
            .filter_map(|id| connections.remove(&id).map(|connection| (id, connection)))
            .map(|(id, connection)| {
                connection.task.abort();
                id
            })
            .collect()
    };
    for id in closed {
        let _ = app.emit(&closed_event(id), ());
    }
}

/// Close every socket and tell its page, which reconnects through the
/// current route. Called when the Tor switch changes: a socket opened under
/// the old rule must not outlive it.
pub(crate) async fn close_all(app: &AppHandle) {
    let closed: Vec<u32> = {
        let mut connections = CONNECTIONS.lock().await;
        connections
            .drain()
            .map(|(id, connection)| {
                connection.task.abort();
                id
            })
            .collect()
    };
    for id in closed {
        let _ = app.emit(&closed_event(id), ());
    }
}
