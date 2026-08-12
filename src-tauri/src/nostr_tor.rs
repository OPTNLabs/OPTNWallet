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

use std::collections::HashMap;

use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
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

/// Parse `wss://host[:port]/path` → (host, port). Only wss:// is accepted, so a
/// relay is never contacted over plaintext ws://.
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
