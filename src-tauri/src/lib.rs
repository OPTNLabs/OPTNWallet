#[allow(dead_code)] // menu bar is built on the JS side now; kept for reference
mod menu;

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
            write_wallet_file
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
