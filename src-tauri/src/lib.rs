#[allow(dead_code)] // menu bar is built on the JS side now; kept for reference
mod menu;

pub mod fusion;
pub mod electrum_tcp;
pub mod spv;

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

#[derive(serde::Deserialize)]
struct FusionRunInputReq {
    prev_txid: String,
    prev_index: u32,
    pubkey: String,
    value: u64,
    privkey: String,
}

/// Run a full CashFusion round (Phase 1.7): contribute `inputs` (each with the
/// key to sign it) and fresh `outputs`, join `tier`, and fuse. Returns the
/// assembled transaction on success. Same Tor requirement as the other fusion
/// commands. A round only COMPLETES with >=2 players in the tier — run several
/// wallet instances to fuse with yourself for testing. Private keys are used only
/// to sign locally and are never logged or sent over the network.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // command args map 1:1 to the JS invoke call
async fn fusion_run(
    host: String,
    port: u16,
    use_ssl: bool,
    tier: u64,
    inputs: Vec<FusionRunInputReq>,
    output_scripts: Vec<String>,
    output_values: Vec<u64>,
    tor_host: Option<String>,
    tor_port: Option<u16>,
) -> Result<fusion::run::FusionOutcome, String> {
    if !fusion::fusion_execution_ready() {
        return Err(fusion::FUSION_EXECUTION_PAUSED_MESSAGE.into());
    }

    let transport = match (tor_host.as_deref(), tor_port) {
        (Some(h), Some(p)) => fusion::Transport::Tor { host: h, port: p },
        _ if fusion::is_local_server(&host) => fusion::Transport::Direct,
        _ => {
            return Err(
                "CashFusion needs Tor for remote servers — without it the server \
                 can link your coins together by IP address."
                    .into(),
            )
        }
    };

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

    fusion::run::run_fusion(fusion::run::FusionRunParams {
        host: &host,
        port,
        use_ssl,
        tier,
        inputs: keyed_inputs,
        output_scripts: scripts,
        output_values,
        transport,
        timing: fusion::run::FusionTiming::default(),
    })
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
    let watched: std::collections::HashSet<[u8; 20]> =
        pubkey_hashes.iter().map(|h| parse_pkh(h)).collect::<Result<_, _>>()?;
    let blocks: Vec<[u8; 32]> =
        block_hashes.iter().map(|h| parse_block_hash(h)).collect::<Result<_, _>>()?;
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
            geoip: std::env::var("OPTN_TOR_GEOIP").ok().map(std::path::PathBuf::from),
            geoip6: std::env::var("OPTN_TOR_GEOIP6").ok().map(std::path::PathBuf::from),
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

// Open an external URL in the user's default browser. A Tauri webview silently
// blocks `target="_blank"` links, so faucet/explorer/etc. links never open; the
// frontend intercepts those clicks and routes them here. Restricted to http(s).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs may be opened externally".into());
    }
    #[cfg(target_os = "windows")]
    let spawn = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawn = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawn.map(|_| ()).map_err(|e| format!("could not open browser: {e}"))
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
            open_external,
            read_wallet_file,
            write_wallet_file,
            fusion_server_status,
            fusion_join_status,
            fusion_run,
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
            electrum_tcp::electrum_tcp_close
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
