#[allow(dead_code)] // menu bar is built on the JS side now; kept for reference
mod menu;

pub mod fusion;

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
    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ if fusion::is_local_server(&host) => fusion::Transport::Direct,
        _ => {
            return Err(
                "No Tor proxy configured. CashFusion needs Tor for remote servers — \
                 without it the server can link your coins together by IP address, \
                 which is exactly what fusing is meant to prevent."
                    .into(),
            )
        }
    };

    // genesis_hash is optional in the protocol; omitting it lets a server that
    // checks chain identity apply its own default rather than us asserting one.
    fusion::server_status(&host, port, use_ssl, transport, None).await
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
            read_wallet_file,
            write_wallet_file,
            fusion_server_status,
            fusion_tor_detect,
            fusion_tor_check
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(log_level)
                    // Stdout so the terminal shows logs during dev
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    // Rolling log file in the OS app-log directory:
                    //   Windows: %APPDATA%\com.optilabs.wallet\logs\
                    //   macOS:   ~/Library/Logs/com.optilabs.wallet/
                    //   Linux:   ~/.local/share/com.optilabs.wallet/logs/
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("optn-wallet".into()),
                        },
                    ))
                    .max_file_size(5_000_000) // 5 MB per file
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
