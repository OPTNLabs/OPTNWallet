// Manages an app-launched Tor process (the "bundled Tor" / integrated client,
// like Electron Cash). Spawns the tor binary with a SOCKS port and a private
// data directory, watches its log for the bootstrap progress, and stops it on
// request or app exit. The rest of the app then routes through that SOCKS port
// exactly as it would an externally-run Tor.
//
// Tor binaries are platform-specific and large, so the actual binary is shipped
// as a resource (or pointed at via OPTN_TOR_BIN for dev); this module only
// drives whatever binary path it's given.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU8, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

static CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));
static BOOTSTRAP: AtomicU8 = AtomicU8::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);
static SOCKS_PORT: AtomicU16 = AtomicU16::new(0);

/// Where to find the tor binary and its geoip data.
#[derive(Debug, Clone)]
pub struct TorPaths {
    pub binary: PathBuf,
    pub data_dir: PathBuf,
    pub geoip: Option<PathBuf>,
    pub geoip6: Option<PathBuf>,
}

/// Live status for the UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TorStatus {
    pub running: bool,
    pub bootstrap_percent: u8,
    pub socks_port: u16,
}

/// Parse the bootstrap percentage out of a tor log line, e.g.
/// "... Bootstrapped 100% (done): Done" -> 100.
fn parse_bootstrap(line: &str) -> Option<u8> {
    let idx = line.find("Bootstrapped ")?;
    let rest = &line[idx + "Bootstrapped ".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Start tor and wait until it has bootstrapped (or the timeout elapses).
/// Returns the SOCKS port it's listening on. Idempotent: if tor is already
/// running, returns the existing port.
pub async fn start(paths: TorPaths, socks_port: u16, bootstrap_timeout: Duration) -> Result<u16, String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Ok(SOCKS_PORT.load(Ordering::SeqCst));
    }

    std::fs::create_dir_all(&paths.data_dir)
        .map_err(|e| format!("could not create tor data dir: {e}"))?;

    let mut cmd = Command::new(&paths.binary);
    cmd.arg("--SocksPort")
        .arg(socks_port.to_string())
        .arg("--DataDirectory")
        .arg(&paths.data_dir)
        .arg("--ClientOnly")
        .arg("1")
        .arg("--Log")
        .arg("notice stdout")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(g) = &paths.geoip {
        cmd.arg("--GeoIPFile").arg(g);
    }
    if let Some(g6) = &paths.geoip6 {
        cmd.arg("--GeoIPv6File").arg(g6);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start tor ({}): {e}", paths.binary.display()))?;
    let stdout = child.stdout.take().ok_or("tor produced no stdout")?;

    BOOTSTRAP.store(0, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
    SOCKS_PORT.store(socks_port, Ordering::SeqCst);

    // Drain tor's log in the background: track bootstrap and signal when done.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut ready_tx = Some(ready_tx);
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(pct) = parse_bootstrap(&line) {
                BOOTSTRAP.store(pct, Ordering::SeqCst);
                if pct >= 100 {
                    RUNNING.store(true, Ordering::SeqCst);
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        }
        // stdout closed => tor exited.
        RUNNING.store(false, Ordering::SeqCst);
    });

    *CHILD.lock().await = Some(child);

    match tokio::time::timeout(bootstrap_timeout, ready_rx).await {
        Ok(Ok(())) => Ok(socks_port),
        _ => {
            // Bootstrap stalled — tear the process down so we don't leak it.
            let _ = stop().await;
            Err("tor did not finish bootstrapping in time".into())
        }
    }
}

/// Stop the managed tor process, if any.
pub async fn stop() -> Result<(), String> {
    RUNNING.store(false, Ordering::SeqCst);
    BOOTSTRAP.store(0, Ordering::SeqCst);
    if let Some(mut child) = CHILD.lock().await.take() {
        let _ = child.kill().await;
    }
    Ok(())
}

pub fn status() -> TorStatus {
    TorStatus {
        running: RUNNING.load(Ordering::SeqCst),
        bootstrap_percent: BOOTSTRAP.load(Ordering::SeqCst),
        socks_port: SOCKS_PORT.load(Ordering::SeqCst),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bootstrap_percentages() {
        assert_eq!(
            parse_bootstrap("Jul 13 00:00:00.000 [notice] Bootstrapped 0% (starting)"),
            Some(0)
        );
        assert_eq!(
            parse_bootstrap("[notice] Bootstrapped 45% (requesting_descriptors): ..."),
            Some(45)
        );
        assert_eq!(
            parse_bootstrap("[notice] Bootstrapped 100% (done): Done"),
            Some(100)
        );
        assert_eq!(parse_bootstrap("[notice] Opening Socks listener"), None);
    }
}
