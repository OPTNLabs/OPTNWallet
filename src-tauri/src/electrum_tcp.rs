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
use std::sync::Arc;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// Per-connection handle: a channel the JS `write()` path pushes outbound bytes
/// into. Dropping the sender (on close) ends the writer task and tears down the
/// connection.
static CONNECTIONS: Lazy<Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

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
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect {host}:{port} failed: {e}"))?;
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
    let tls = TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?;
    Ok(ElectrumStream::Tls(Box::new(tls)))
}

/// Open a TCP(+TLS) connection to an Electrum server. Returns a connection id the
/// frontend uses for `electrum_tcp_send` / `electrum_tcp_close`, and listens on
/// `electrum-tcp://data/{id}` and `electrum-tcp://closed/{id}`.
#[tauri::command]
pub async fn electrum_tcp_connect(
    app: AppHandle,
    host: String,
    port: u16,
    use_ssl: bool,
) -> Result<u32, String> {
    let stream = open_stream(&host, port, use_ssl).await?;

    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    CONNECTIONS.lock().await.insert(id, tx);

    match stream {
        ElectrumStream::Plain(s) => {
            tokio::spawn(run_connection(app, id, s, rx));
        }
        ElectrumStream::Tls(s) => {
            tokio::spawn(run_connection(app, id, *s, rx));
        }
    }

    Ok(id)
}

/// Send bytes on an open connection.
#[tauri::command]
pub async fn electrum_tcp_send(id: u32, data: String) -> Result<(), String> {
    let conns = CONNECTIONS.lock().await;
    let tx = conns.get(&id).ok_or("connection not open")?;
    tx.send(data.into_bytes())
        .map_err(|_| "connection closed".to_string())
}

/// Close a connection.
#[tauri::command]
pub async fn electrum_tcp_close(id: u32) -> Result<(), String> {
    // Dropping the sender ends the writer task; the reader loop then emits the
    // closed event and removes the entry. Remove eagerly so a re-close is a noop.
    CONNECTIONS.lock().await.remove(&id);
    Ok(())
}
