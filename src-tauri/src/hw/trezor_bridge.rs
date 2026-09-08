//! Trezor Bridge (trezord) HTTP — Electron Cash / trezorlib model.
//!
//! EC: `trezorlib.transport.enumerate_devices()` + `get_transport(path)`
//! talks to Bridge **from the native process**, never from a browser WebView.
//!
//! This optional route requires a local Bridge on 127.0.0.1:21325. Native
//! WebUSB is handled separately by `trezor_webusb`; Model One may also appear
//! as HID through `session`.
//!
//! Protocol: <https://github.com/trezor/trezord-go> (HTTP API)

use serde::{Deserialize, Serialize};
use std::time::Duration;

const BRIDGE_BASE: &str = "http://127.0.0.1:21325";
/// Suite / trezorlib-style Origin so Bridge CORS accepts us.
const BRIDGE_ORIGIN: &str = "https://suite.trezor.io";
/// Wallet policy: a 1 MiB binary frame as hex plus JSON overhead, not a Bridge protocol limit.
const MAX_BRIDGE_BODY_BYTES: usize = 2 * 1024 * 1024 + 1024;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(3))
        // Device messages must stay on the fixed loopback Bridge endpoint.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| format!("Trezor Bridge HTTP client: {e}"))
}

async fn read_bridge_body(mut res: reqwest::Response) -> Result<String, String> {
    let too_large = || format!("Bridge body exceeds wallet limit of {MAX_BRIDGE_BODY_BYTES} bytes");
    if res
        .content_length()
        .is_some_and(|len| len > MAX_BRIDGE_BODY_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if chunk.len() > MAX_BRIDGE_BODY_BYTES - body.len() {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|e| format!("Bridge body is not valid UTF-8: {e}"))
}

async fn read_bridge_json(res: reqwest::Response) -> Result<serde_json::Value, String> {
    serde_json::from_str(&read_bridge_body(res).await?)
        .map_err(|e| format!("Bridge body is not valid JSON: {e}"))
}

fn bridge_err(ctx: &str, e: impl std::fmt::Display) -> String {
    format!(
        "{ctx}: {e}. Open Trezor Suite (starts Bridge on port 21325), unlock the device, then retry. (Electron Cash uses the same Bridge.)"
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeDeviceInfo {
    pub path: String,
    pub vendor: u16,
    pub product: u16,
    pub session: Option<String>,
    pub debug: bool,
}

/// GET / → { version }
#[tauri::command]
pub async fn trezor_bridge_ping() -> Result<Option<String>, String> {
    let c = client()?;
    let res = match c
        .get(format!("{BRIDGE_BASE}/"))
        .header("Origin", BRIDGE_ORIGIN)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !res.status().is_success() {
        return Ok(None);
    }
    let v = read_bridge_json(res)
        .await
        .map_err(|e| bridge_err("Bridge version JSON", e))?;
    Ok(Some(
        v.get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
    ))
}

/// POST /enumerate → list devices (WebUSB Safe 5 etc.)
#[tauri::command]
pub async fn trezor_bridge_enumerate() -> Result<Vec<BridgeDeviceInfo>, String> {
    let c = client()?;
    let res = c
        .post(format!("{BRIDGE_BASE}/enumerate"))
        .header("Origin", BRIDGE_ORIGIN)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| bridge_err("Bridge enumerate", e))?;
    if !res.status().is_success() {
        return Err(bridge_err(
            "Bridge enumerate",
            format!("HTTP {}", res.status()),
        ));
    }
    let raw = read_bridge_json(res)
        .await
        .map_err(|e| bridge_err("Bridge enumerate body", e))?;
    let arr = raw
        .as_array()
        .ok_or_else(|| "Bridge enumerate: expected JSON array".to_string())?;
    let mut out = Vec::new();
    for item in arr {
        let path = item
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        if path.is_empty() {
            continue;
        }
        let vendor = item
            .get("vendor")
            .and_then(|v| v.as_u64())
            .unwrap_or(0x1209) as u16;
        let product = item.get("product").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
        let session = item
            .get("session")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let debug = item.get("debug").and_then(|d| d.as_bool()).unwrap_or(false);
        out.push(BridgeDeviceInfo {
            path,
            vendor,
            product,
            session,
            debug,
        });
    }
    Ok(out)
}

/// POST /acquire/{path}/null → { session }
#[tauri::command]
pub async fn trezor_bridge_acquire(path: String) -> Result<String, String> {
    let c = client()?;
    let url = format!("{BRIDGE_BASE}/acquire/{}/null", urlencoding_path(&path));
    let res = c
        .post(&url)
        .header("Origin", BRIDGE_ORIGIN)
        .header("Content-Type", "application/json")
        .body(r#"{"sessionOwner":"optn-wallet"}"#)
        .send()
        .await
        .map_err(|e| bridge_err("Bridge acquire", e))?;
    if !res.status().is_success() {
        let text = read_bridge_body(res)
            .await
            .map_err(|e| bridge_err("Bridge acquire body", e))?;
        return Err(bridge_err(
            "Bridge acquire",
            if text.is_empty() {
                "device busy? Close Suite's exclusive session or unlock device.".into()
            } else {
                text
            },
        ));
    }
    let v = read_bridge_json(res)
        .await
        .map_err(|e| bridge_err("Bridge acquire JSON", e))?;
    v.get("session")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Bridge acquire: no session id".to_string())
}

/// POST /release/{session}
#[tauri::command]
pub async fn trezor_bridge_release(session: String) -> Result<(), String> {
    let c = client()?;
    let url = format!("{BRIDGE_BASE}/release/{}", urlencoding_path(&session));
    let _ = c
        .post(&url)
        .header("Origin", BRIDGE_ORIGIN)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await;
    Ok(())
}

/// POST /call/{session} body = hex message, response = hex (or JSON)
#[tauri::command]
pub async fn trezor_bridge_call(session: String, data_hex: String) -> Result<String, String> {
    let c = client()?;
    let url = format!("{BRIDGE_BASE}/call/{}", urlencoding_path(&session));
    let res = c
        .post(&url)
        .header("Origin", BRIDGE_ORIGIN)
        .header("Content-Type", "text/plain")
        .body(data_hex)
        .send()
        .await
        .map_err(|e| bridge_err("Bridge call", e))?;
    if !res.status().is_success() {
        let text = read_bridge_body(res)
            .await
            .map_err(|e| bridge_err("Bridge call body", e))?;
        return Err(bridge_err(
            "Bridge call",
            if text.is_empty() {
                "HTTP error".into()
            } else {
                text
            },
        ));
    }
    let text = read_bridge_body(res)
        .await
        .map_err(|e| bridge_err("Bridge call body", e))?
        .trim()
        .to_string();
    if text.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                return Ok(m.to_string());
            }
        }
    }
    Ok(text.trim_matches('"').to_string())
}

/// Minimal path encode (Bridge paths are usually hex-like; still escape /).
fn urlencoding_path(s: &str) -> String {
    // Bridge device paths are typically hex strings without reserved chars.
    // Encode anything non-unreserved for safety.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
#[tokio::test]
async fn bridge_http_responses_are_bounded_and_local() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;

    async fn response(c: &reqwest::Client, headers: &str, body: &[u8]) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/call/test", listener.local_addr().unwrap());
        let mut wire = format!("HTTP/1.1 {headers}\r\nConnection: close\r\n\r\n").into_bytes();
        wire.extend_from_slice(body);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
                assert!(request.len() < 4096);
            }
            let mut message = [0; 4];
            socket.read_exact(&mut message).await.unwrap();
            assert_eq!(&message, b"0000");
            // Oversized responses may be rejected before the server finishes writing.
            let _ = socket.write_all(&wire).await;
        });
        c.post(url).body("0000").send().await.unwrap()
    }

    timeout(Duration::from_secs(10), async {
        let c = client().unwrap();
        // The last byte exceeds the cumulative limit, even with no Content-Length.
        let chunked = format!(
            "{:x}\r\n{}\r\n1\r\nx\r\n0\r\n\r\n",
            MAX_BRIDGE_BODY_BYTES,
            "a".repeat(MAX_BRIDGE_BODY_BYTES)
        );
        for status in ["200 OK", "500 Internal Server Error"] {
            let headers = format!("{status}\r\nContent-Length: {}", MAX_BRIDGE_BODY_BYTES + 1);
            // No body is sent: the advertised length must be rejected before reading it.
            let res = response(&c, &headers, b"").await;
            assert!(read_bridge_body(res)
                .await
                .unwrap_err()
                .contains("wallet limit"));

            let headers = format!("{status}\r\nTransfer-Encoding: chunked");
            let res = response(&c, &headers, chunked.as_bytes()).await;
            assert!(read_bridge_body(res)
                .await
                .unwrap_err()
                .contains("wallet limit"));

            let headers = format!("{status}\r\nContent-Length: 1");
            let res = response(&c, &headers, &[0xff]).await;
            assert!(read_bridge_body(res).await.unwrap_err().contains("UTF-8"));
        }

        let res = response(&c, "200 OK\r\nContent-Length: 8", b"00010203").await;
        assert_eq!(read_bridge_body(res).await.unwrap(), "00010203");
        let res = response(
            &c,
            "500 Internal Server Error\r\nContent-Length: 4",
            b"busy",
        )
        .await;
        assert_eq!(read_bridge_body(res).await.unwrap(), "busy");
        let res = response(&c, "200 OK\r\nContent-Length: 1", b"{").await;
        assert!(read_bridge_json(res).await.unwrap_err().contains("JSON"));
        for body in [
            r#"{"version":"test"}"#,
            r#"[{"path":"test"}]"#,
            r#"{"session":"test"}"#,
        ] {
            let headers = format!("200 OK\r\nContent-Length: {}", body.len());
            let res = response(&c, &headers, body.as_bytes()).await;
            assert_eq!(read_bridge_json(res).await.unwrap().to_string(), body);
        }

        // A 1 MiB frame encoded as hex with JSON and padding fits exactly at the cap.
        let mut body = format!(r#"{{"message":"{}"}}"#, "00".repeat(1024 * 1024));
        body.push_str(&" ".repeat(MAX_BRIDGE_BODY_BYTES - body.len()));
        let headers = format!("200 OK\r\nContent-Length: {}", body.len());
        let res = response(&c, &headers, body.as_bytes()).await;
        assert_eq!(
            read_bridge_json(res).await.unwrap()["message"]
                .as_str()
                .unwrap()
                .len(),
            2 * 1024 * 1024
        );

        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        for status in [301, 302, 303, 307, 308] {
            let headers = format!(
                "{status} Redirect\r\nLocation: http://{}/capture\r\nContent-Length: 0",
                target.local_addr().unwrap()
            );
            let res = response(&c, &headers, b"").await;
            assert_eq!(res.status().as_u16(), status);
        }
        assert!(timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err());
    })
    .await
    .expect("loopback Bridge regression must finish promptly");
}
