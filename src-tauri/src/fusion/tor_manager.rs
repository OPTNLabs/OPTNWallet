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
/// True from the moment a tor process is spawned until its stdout closes (i.e.
/// the process exits). Distinct from RUNNING (which is only set at 100%
/// bootstrap): lets a waiter tell "still bootstrapping" from "process died".
static SPAWNED: AtomicBool = AtomicBool::new(false);

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

fn observe_child_log(line: &str) {
    if let Some(percent) = parse_bootstrap(line) {
        BOOTSTRAP.store(percent, Ordering::SeqCst);
        if percent >= 100 {
            RUNNING.store(true, Ordering::SeqCst);
        }
    }
}

fn observe_child_exit() {
    RUNNING.store(false, Ordering::SeqCst);
    SPAWNED.store(false, Ordering::SeqCst);
    BOOTSTRAP.store(0, Ordering::SeqCst);
}

/// Start tor and wait until it has bootstrapped (or the timeout elapses).
/// Returns the SOCKS port it's listening on. Idempotent: if tor is already
/// running, returns the existing port.
pub async fn start(
    paths: TorPaths,
    socks_port: u16,
    bootstrap_timeout: Duration,
) -> Result<u16, String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Ok(SOCKS_PORT.load(Ordering::SeqCst));
    }

    // Spawn exactly one tor process. The CHILD lock is the critical section:
    // two concurrent starts (a double-click, a re-fired effect) must never
    // launch rival tor processes — they share one DataDirectory, whose lock
    // file only one process can hold, so the loser dies and NEITHER bootstraps.
    // Whoever finds no live child spawns; everyone else falls through to wait.
    {
        let mut child_guard = CHILD.lock().await;
        if child_guard.is_none() {
            // Integrated Tor is app-owned. Never adopt an existing listener: it
            // could be unrelated or hostile. Only this spawned child's bootstrap
            // output may mark the managed route ready.
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], socks_port));
            let reservation = std::net::TcpListener::bind(addr)
                .map_err(|_| format!("integrated Tor SOCKS port {socks_port} is already in use"))?;
            drop(reservation);

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
            SPAWNED.store(true, Ordering::SeqCst);
            SOCKS_PORT.store(socks_port, Ordering::SeqCst);

            // Drain tor's log in the background: track bootstrap % and flip
            // RUNNING at 100%. When stdout closes the process has exited.
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    observe_child_log(&line);
                }
                // stdout closed => tor exited.
                observe_child_exit();
            });

            *child_guard = Some(child);
        }
    }

    // Wait for bootstrap by polling the flags the log task maintains. On
    // timeout we deliberately DO NOT kill tor: bootstrapping over a slow or
    // filtered network can exceed the deadline, and killing throws away all
    // progress (and the warmed consensus in the data dir) so the next attempt
    // restarts from 0% — a loop that never completes. Leave it running; the
    // UI polls tor_status and will see it reach 100%.
    let deadline = tokio::time::Instant::now() + bootstrap_timeout;
    loop {
        if RUNNING.load(Ordering::SeqCst) {
            return Ok(socks_port);
        }
        if !SPAWNED.load(Ordering::SeqCst) {
            // The process exited before reaching 100% (bad binary, port clash,
            // locked data dir). Clear the dead child so a retry can respawn.
            *CHILD.lock().await = None;
            return Err("tor exited before finishing bootstrap — check the tor binary and that the SOCKS port is free".into());
        }
        if tokio::time::Instant::now() >= deadline {
            let pct = BOOTSTRAP.load(Ordering::SeqCst);
            return Err(format!(
                "tor still bootstrapping ({pct}%) — it's left running, open Tor status again in a moment"
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Stop the managed tor process, if any.
pub async fn stop() -> Result<(), String> {
    RUNNING.store(false, Ordering::SeqCst);
    SPAWNED.store(false, Ordering::SeqCst);
    BOOTSTRAP.store(0, Ordering::SeqCst);
    SOCKS_PORT.store(0, Ordering::SeqCst);
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

    fn reset_status() {
        RUNNING.store(false, Ordering::SeqCst);
        SPAWNED.store(false, Ordering::SeqCst);
        BOOTSTRAP.store(0, Ordering::SeqCst);
        SOCKS_PORT.store(0, Ordering::SeqCst);
    }

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

    #[tokio::test]
    async fn occupied_managed_port_fails_closed() {
        reset_status();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let paths = TorPaths {
            binary: PathBuf::from("unused"),
            data_dir: std::env::temp_dir().join("optn-tor-occupied-port-test"),
            geoip: None,
            geoip6: None,
        };
        let error = start(paths, port, Duration::from_millis(10))
            .await
            .unwrap_err();
        assert!(error.contains("already in use"));
        assert!(!status().running);
    }

    #[tokio::test]
    async fn status_does_not_promote_an_open_socket_to_ready() {
        reset_status();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        SOCKS_PORT.store(listener.local_addr().unwrap().port(), Ordering::SeqCst);
        let observed = status();
        assert!(!observed.running);
        assert_eq!(observed.bootstrap_percent, 0);
        reset_status();
    }

    #[test]
    fn child_log_and_exit_control_the_readiness_lifecycle() {
        reset_status();
        SPAWNED.store(true, Ordering::SeqCst);

        observe_child_log("[notice] Bootstrapped 100% (done): Done");
        assert!(status().running);
        assert_eq!(status().bootstrap_percent, 100);

        observe_child_exit();
        assert!(!status().running);
        assert_eq!(status().bootstrap_percent, 0);
        assert!(!SPAWNED.load(Ordering::SeqCst));
    }
}
