//! CashFusion on the desktop, through the shared driver
//! (`optn_fusion_native::driver`) -- the loop the CLI and the docker lab run.
//!
//! The renderer asks for a run and may stop it. Everything else happens here
//! and in the runtime: coin choice, keys, holds, the round on a server or over
//! Nostr, the depth record and Auto's timing. No key and no coin list crosses
//! to the renderer. The holder's Electrum selection and verified Tor proxy are
//! read here too, never taken from the renderer.
//!
//! Progress reaches the renderer as `optn://fusion-event` events (the driver's
//! JSON lines), and the end of a run as `optn://fusion-finished`.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use optn_fusion_native::driver::{self, DriverOptions, FusionHost, FusionWallet, Venue};
use optn_fusion_native::p2p_round::{relay_host, P2pRoundSettings, FUSION_CORE_RELAYS};
use optn_fusion_native::server_round::{ServerRoundSettings, ServerTarget};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::chain_runtime::NativeChainRuntime;
use crate::electrum_selection;
use crate::network_config::NetworkSettingsStore;

pub const FUSION_EVENT: &str = "optn://fusion-event";
pub const FUSION_FINISHED: &str = "optn://fusion-finished";

/// Where the holder chose to fuse.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FusionVenueRequest {
    /// CashFusion servers, `host[:port][:s|:t]`: the holder's choice, then
    /// the rest they configured, tried in that order before each round.
    Server {
        #[serde(default)]
        selected: Option<String>,
        configured: Vec<String>,
        #[serde(default)]
        only_tiers: Option<Vec<u64>>,
    },
    /// Peer to peer over Nostr; the desktop's relay set unless named.
    P2p {
        #[serde(default)]
        relays: Option<Vec<String>>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FusionStartRequest {
    pub venue: FusionVenueRequest,
    /// Keep fusing as Auto Fusion, rather than run once.
    pub auto: bool,
    #[serde(default)]
    pub rounds: Option<u32>,
    /// Rounds each coin goes through before Auto leaves it alone.
    pub fuse_depth: u32,
}

/// Stopping a run: the flag the driver checks, the wait it wakes, and the
/// round it cancels.
#[derive(Default)]
struct Control {
    stopped: AtomicBool,
    wake: tokio::sync::Notify,
    round: Mutex<Option<String>>,
}

impl Control {
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(id) = self
            .round
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            crate::fusion::round_cancel::cancel_round(&id);
        }
        self.wake.notify_waiters();
    }
}

/// The one run allowed at a time.
#[derive(Default)]
pub struct FusionDriverState {
    running: Mutex<Option<Arc<Control>>>,
}

/// The desktop's side of the driver: the chain runtime brings the wallet's
/// coins up to date, the wallet's hold file supplies its holds, and progress
/// goes to the renderer as events.
struct DesktopHost {
    app: tauri::AppHandle,
    runtime: optn_runtime::AppRuntime,
    chain: Arc<NativeChainRuntime>,
    control: Arc<Control>,
}

impl FusionHost for DesktopHost {
    async fn refresh(&self) -> Result<&dyn FusionWallet, String> {
        self.chain.refresh_wallet().await?;
        Ok(&self.runtime as &dyn FusionWallet)
    }

    async fn held(&self) -> Result<BTreeSet<String>, String> {
        let status = self
            .runtime
            .wallet_security(optn_transport::WalletSecurityRequest::Status)
            .await
            .map_err(|_| "Wallet session is unavailable. Reopen it.".to_string())?;
        // Only a wallet migrated from this desktop has a hold file here.
        let Some(id) = status.legacy_source_id.filter(|id| *id > 0) else {
            return Ok(BTreeSet::new());
        };
        Ok(crate::coin_holds::optn_coin_holds(self.app.clone(), id)?
            .into_iter()
            .map(|hold| hold.outpoint.to_ascii_lowercase())
            .collect())
    }

    fn report(&self, event: Value) {
        let _ = self.app.emit(FUSION_EVENT, event);
    }

    async fn pause(&self, ms: u64) -> bool {
        // Registered before the check, so a stop between the two still wakes
        // this wait.
        let woken = self.control.wake.notified();
        if self.stopped() {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(ms)) => !self.stopped(),
            _ = woken => false,
        }
    }

    fn round_started(&self, round_id: &str) {
        *self
            .control
            .round
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(round_id.to_owned());
    }

    fn stopped(&self) -> bool {
        self.control.stopped.load(Ordering::SeqCst)
    }
}

/// The holder's choice first, then the rest, each once
/// (`orderedFusionServerCandidates`).
fn ordered_servers(selected: Option<&str>, configured: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    selected
        .into_iter()
        .chain(configured.iter().map(String::as_str))
        .map(str::trim)
        .filter(|server| !server.is_empty() && seen.insert(server.to_owned()))
        .map(str::to_owned)
        .collect()
}

/// Every relay must name a host: the Tor rule is decided per host.
fn relay_hosts(relays: &[String]) -> Result<Vec<String>, String> {
    relays
        .iter()
        .map(|relay| {
            relay_host(relay).ok_or_else(|| format!("{relay} is not a Nostr relay address"))
        })
        .collect()
}

/// The venue, with the holder's own Electrum selection and verified proxy.
async fn venue(
    runtime: &optn_runtime::AppRuntime,
    settings: &NetworkSettingsStore,
    request: FusionVenueRequest,
    auto: bool,
) -> Result<Venue, String> {
    let network = runtime.state().network;
    let pool = electrum_selection::electrum_pool(runtime, settings, network).await?;
    let lookups = electrum_selection::fusion_lookup_endpoints(
        &pool,
        std::iter::empty(),
        electrum_selection::FUSION_LOOKUP_LIMIT,
    );
    if lookups.is_empty() {
        let why = pool.reason.unwrap_or_else(|| {
            "No Electrum server selected for this network can check this round's inputs.".into()
        });
        return Err(format!("{}: {why}", electrum_selection::NOT_SELECTED));
    }
    let lookup_hosts: Vec<&str> = lookups.iter().map(|server| server.host.as_str()).collect();
    let lookup_servers = crate::lookup_endpoints(&lookups);
    let status = runtime
        .wallet_security(optn_transport::WalletSecurityRequest::Status)
        .await
        .map_err(|_| "Wallet session is unavailable. Reopen it.".to_string())?;
    let wallet_tag = status.active.clone().ok_or("Open a wallet to fuse it.")?;
    Ok(match request {
        FusionVenueRequest::Server {
            selected,
            configured,
            only_tiers,
        } => {
            let servers = ordered_servers(selected.as_deref(), &configured);
            if servers.is_empty() {
                return Err("no fusion server selected".into());
            }
            let mut candidates = Vec::with_capacity(servers.len());
            for server in servers {
                let target = ServerTarget::parse(&server)?;
                // Each candidate meets the Tor rule on its own, with the
                // lookup servers its rounds use.
                let destinations: Vec<&str> = std::iter::once(target.host.as_str())
                    .chain(lookup_hosts.iter().copied())
                    .collect();
                let verified_proxy =
                    crate::verified_fusion_proxy_for_network(&destinations, settings, network)
                        .await?;
                candidates.push(ServerRoundSettings {
                    network,
                    server: target,
                    verified_proxy,
                    lookup_servers: lookup_servers.clone(),
                    wallet_tag: wallet_tag.clone(),
                    join_inactive_timeout: auto
                        .then_some(crate::fusion::run::EC_AUTOFUSE_INACTIVE_TIMEOUT),
                    only_tiers: only_tiers.clone(),
                });
            }
            Venue::Failover(candidates)
        }
        FusionVenueRequest::P2p { relays } => {
            let relays = relays.unwrap_or_else(|| {
                FUSION_CORE_RELAYS
                    .iter()
                    .map(|relay| relay.to_string())
                    .collect()
            });
            let hosts = relay_hosts(&relays)?;
            let destinations: Vec<&str> = hosts
                .iter()
                .map(String::as_str)
                .chain(lookup_hosts.iter().copied())
                .collect();
            let verified_proxy =
                crate::verified_fusion_proxy_for_network(&destinations, settings, network).await?;
            Venue::P2p(P2pRoundSettings {
                network,
                relays,
                verified_proxy,
                lookup_servers,
                auto,
            })
        }
    })
}

/// Start fusing the open wallet. Returns once the run is under way; progress
/// and the result arrive as events. One run at a time.
#[tauri::command]
pub async fn optn_fusion_start(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    chain: tauri::State<'_, Arc<NativeChainRuntime>>,
    network_settings: tauri::State<'_, NetworkSettingsStore>,
    state: tauri::State<'_, FusionDriverState>,
    request: FusionStartRequest,
) -> Result<(), String> {
    if !crate::fusion::fusion_execution_ready() {
        return Err(crate::fusion::FUSION_EXECUTION_PAUSED_MESSAGE.into());
    }
    let options = DriverOptions {
        auto: request.auto,
        rounds: request.rounds,
        fuse_depth: request.fuse_depth,
    };
    let venue = venue(&runtime, &network_settings, request.venue, request.auto).await?;
    let control = Arc::new(Control::default());
    {
        let mut running = state
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if running.is_some() {
            return Err("CashFusion is already running for this wallet.".into());
        }
        *running = Some(Arc::clone(&control));
    }
    let host = DesktopHost {
        app: app.clone(),
        runtime: runtime.inner().clone(),
        chain: Arc::clone(chain.inner()),
        control: Arc::clone(&control),
    };
    tauri::async_runtime::spawn(async move {
        let outcome = driver::run(&host, &venue, options).await;
        let mut finished = venue.describe();
        match outcome {
            Ok(outcome) => {
                finished["ok"] = json!(true);
                finished["rounds"] = json!(outcome.fused);
                finished["stopped"] = json!(outcome.stopped);
            }
            Err(error) => {
                finished["ok"] = json!(false);
                finished["error"] = json!(error.to_string());
            }
        }
        // Clear this run, and only this run, before saying it finished.
        let state = host.app.state::<FusionDriverState>();
        let mut running = state
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if running
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &host.control))
        {
            *running = None;
        }
        drop(running);
        let _ = host.app.emit(FUSION_FINISHED, finished);
    });
    Ok(())
}

/// Stop the run, cancelling its round. The engine still finishes what it must
/// once components are disclosed. `false` when nothing was running.
#[tauri::command]
pub fn optn_fusion_stop(state: tauri::State<'_, FusionDriverState>) -> bool {
    match state
        .running
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        Some(control) => {
            control.stop();
            true
        }
        None => false,
    }
}

/// Whether a run is under way.
#[tauri::command]
pub fn optn_fusion_running(state: tauri::State<'_, FusionDriverState>) -> bool {
    state
        .running
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_renderer_names_a_venue_and_nothing_else() {
        let server: FusionStartRequest = serde_json::from_value(json!({
            "venue": {"mode": "server", "selected": "fusion.example:8788:s", "configured": ["b.example"]},
            "auto": true,
            "fuseDepth": 3,
        }))
        .unwrap();
        assert!(matches!(
            server.venue,
            FusionVenueRequest::Server { ref configured, .. } if configured.len() == 1
        ));
        let p2p: FusionStartRequest = serde_json::from_value(json!({
            "venue": {"mode": "p2p"},
            "auto": false,
            "fuseDepth": 3,
        }))
        .unwrap();
        assert!(matches!(
            p2p.venue,
            FusionVenueRequest::P2p { relays: None }
        ));
        // No keys, coins or lookup servers are accepted from the renderer.
        for smuggled in [
            json!({"venue": {"mode": "p2p"}, "auto": false, "fuseDepth": 3, "inputs": []}),
            json!({"venue": {"mode": "server", "configured": ["h:1"], "lookupHost": "x"}, "auto": false, "fuseDepth": 3}),
        ] {
            assert!(serde_json::from_value::<FusionStartRequest>(smuggled).is_err());
        }
    }

    #[test]
    fn the_chosen_server_comes_first_and_each_appears_once() {
        let configured = vec!["b:1".into(), " a:1 ".into(), "".into(), "c:1".into()];
        assert_eq!(
            ordered_servers(Some("a:1"), &configured),
            ["a:1", "b:1", "c:1"]
        );
        assert_eq!(ordered_servers(None, &configured), ["b:1", "a:1", "c:1"]);
        assert!(ordered_servers(None, &[]).is_empty());
    }

    #[test]
    fn a_relay_without_a_host_is_refused() {
        assert!(relay_hosts(&["wss://relay.example".into()]).is_ok());
        assert!(relay_hosts(&["not a url".into()]).is_err());
    }

    #[test]
    fn stopping_wakes_a_wait_and_names_no_round_when_none_ran() {
        let control = Control::default();
        control.stop();
        assert!(control.stopped.load(Ordering::SeqCst));
    }
}
