//! Trezor Bridge (trezord) HTTP — Electron Cash / trezorlib model.
//!
//! EC: `trezorlib.transport.enumerate_devices()` + `get_transport(path)`
//! talks to Bridge **from the native process**, never from a browser WebView.
//!
//! Safe 5 / Model T are WebUSB → only visible via Bridge (Suite starts it on
//! 127.0.0.1:21325). Model One may also appear as HID (session.rs).
//!
//! Protocol: https://github.com/trezor/trezord-go (HTTP API)

use serde::{Deserialize, Serialize};
use std::time::Duration;

const BRIDGE_BASE: &str = "http://127.0.0.1:21325";
/// Suite / trezorlib-style Origin so Bridge CORS accepts us.
const BRIDGE_ORIGIN: &str = "https://suite.trezor.io";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Trezor Bridge HTTP client: {e}"))
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
    let v: serde_json::Value = res
        .json()
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
    let raw: serde_json::Value = res
        .json()
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
        let text = res.text().await.unwrap_or_default();
        return Err(bridge_err(
            "Bridge acquire",
            if text.is_empty() {
                "device busy? Close Suite's exclusive session or unlock device.".into()
            } else {
                text
            },
        ));
    }
    let v: serde_json::Value = res
        .json()
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
        let text = res.text().await.unwrap_or_default();
        return Err(bridge_err(
            "Bridge call",
            if text.is_empty() {
                "HTTP error".into()
            } else {
                text
            },
        ));
    }
    let text = res
        .text()
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
