//! Freeze and release coins, as the wallet's own reservation primitive.
//!
//! `optn_core::coins` already says what a hold means — a held coin is out of
//! ordinary send, Fusion selection and new pledges — and which holds the user
//! may lift. `optn_runtime::coin_holds` keeps that decision across restarts.
//! This module is only the door: it names the file for a wallet and passes
//! requests through. No screen decides whether a coin may be released.

use optn_chain_native::coin_holds_file::CoinHoldsFile;
use optn_core::coins::FreezeReason;
use optn_runtime::coin_holds::{parse_reason, CoinHolds, HostHoldStore};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct CoinHoldView {
    pub outpoint: String,
    pub txid: String,
    pub vout: u32,
    pub reason: String,
    pub note: Option<String>,
    /// Whether this hold can be lifted from the coin list. A pledge, an
    /// authhead and a running fusion each belong to something else.
    pub user_reversible: bool,
}

/// Where every wallet's hold file lives.
pub fn holds_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("coin-holds"))
}

/// One file per wallet: a hold belongs to the wallet whose coin it is.
fn wallet_holds_file(directory: &Path, wallet_id: u32) -> CoinHoldsFile {
    CoinHoldsFile::new(directory.join(format!("wallet-{wallet_id}.json")))
}

fn holds_file(app: &tauri::AppHandle, wallet_id: u32) -> Result<CoinHoldsFile, String> {
    Ok(wallet_holds_file(&holds_directory(app)?, wallet_id))
}

/// The hold files, as the wallet runtime reads them for a wallet migrated
/// from this desktop: the same files the send screen and the broadcast check
/// read, so a coin held here is one the runtime will not fuse.
pub struct DesktopHostHolds {
    directory: PathBuf,
}

impl DesktopHostHolds {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
}

impl HostHoldStore for DesktopHostHolds {
    fn load(&self, wallet_id: u32) -> Result<CoinHolds, String> {
        wallet_holds_file(&self.directory, wallet_id).load()
    }
}

fn views(holds: &CoinHolds) -> Vec<CoinHoldView> {
    holds
        .holds
        .iter()
        .filter_map(|hold| {
            let reason = parse_reason(&hold.reason).ok()?;
            Some(CoinHoldView {
                outpoint: format!("{}:{}", hold.txid, hold.vout),
                txid: hold.txid.clone(),
                vout: hold.vout,
                reason: hold.reason.clone(),
                note: hold.note.clone(),
                user_reversible: reason.is_user_reversible(),
            })
        })
        .collect()
}

/// The coins a fusion round in this process is using, beside the file's own
/// holds. They live only in the runtime, so a crash mid-round cannot leave a
/// coin frozen under a hold nothing would ever lift.
fn with_round_holds(mut views: Vec<CoinHoldView>, in_round: BTreeSet<String>) -> Vec<CoinHoldView> {
    for outpoint in in_round {
        if views
            .iter()
            .any(|view| view.outpoint.eq_ignore_ascii_case(&outpoint))
        {
            continue;
        }
        let Some((txid, vout)) = outpoint
            .split_once(':')
            .and_then(|(txid, vout)| Some((txid.to_owned(), vout.parse().ok()?)))
        else {
            continue;
        };
        views.push(CoinHoldView {
            outpoint,
            txid,
            vout,
            reason: FreezeReason::FusionInFlight.as_str().to_owned(),
            note: None,
            user_reversible: false,
        });
    }
    views
}

#[tauri::command]
pub fn optn_coin_holds(app: tauri::AppHandle, wallet_id: u32) -> Result<Vec<CoinHoldView>, String> {
    let held = views(&holds_file(&app, wallet_id)?.load()?);
    let in_round = app
        .try_state::<optn_runtime::AppRuntime>()
        .map(|runtime| runtime.fusion_holds(wallet_id))
        .unwrap_or_default();
    Ok(with_round_holds(held, in_round))
}

fn edit_holds(
    app: &tauri::AppHandle,
    wallet_id: u32,
    edit: impl FnOnce(&mut optn_runtime::coin_holds::CoinHolds) -> Result<(), String>,
) -> Result<Vec<CoinHoldView>, String> {
    let runtime = app.state::<optn_runtime::AppRuntime>();
    // Refuse new work throughout the edit, not just before and after it.
    // The guard also cancels prior work and releases on every error path.
    let _mutation = runtime.begin_wallet_mutation();
    let result = holds_file(app, wallet_id).and_then(|file| file.update(edit));
    result.map(|holds| views(&holds))
}

/// Freeze a coin. Only the user's own reason is accepted from a renderer:
/// a pledge or a fusion round takes its hold through the code that owns it,
/// so a screen cannot mint a hold that nothing will ever release.
#[tauri::command]
pub fn optn_coin_freeze(
    app: tauri::AppHandle,
    wallet_id: u32,
    txid: String,
    vout: u32,
    note: Option<String>,
) -> Result<Vec<CoinHoldView>, String> {
    edit_holds(&app, wallet_id, |holds| {
        holds
            .hold(&txid, vout, FreezeReason::User, note.clone())
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub fn optn_coin_unfreeze(
    app: tauri::AppHandle,
    wallet_id: u32,
    txid: String,
    vout: u32,
) -> Result<Vec<CoinHoldView>, String> {
    edit_holds(&app, wallet_id, |holds| {
        holds
            .release_user_hold(&txid, vout)
            .map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::coin_holds::CoinHolds;

    const TXID: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    #[test]
    fn a_view_says_which_holds_the_user_may_lift() {
        // The coin list uses this to decide whether to offer an unfreeze
        // control at all, so it has to come from the same rule that would
        // refuse the release rather than from the screen's own guess.
        let mut holds = CoinHolds::default();
        holds.hold(TXID, 0, FreezeReason::User, None).unwrap();
        holds
            .hold(TXID, 1, FreezeReason::FusionInFlight, None)
            .unwrap();

        let rendered = views(&holds);
        assert_eq!(rendered.len(), 2);
        let user = rendered.iter().find(|view| view.vout == 0).unwrap();
        let fusion = rendered.iter().find(|view| view.vout == 1).unwrap();
        assert!(user.user_reversible);
        assert!(!fusion.user_reversible);
        assert_eq!(fusion.reason, "fusion-in-flight");
        assert_eq!(user.outpoint, format!("{TXID}:0"));
    }

    /// A coin a round is using shows as held, and not as one the user may
    /// lift; a coin the file already holds keeps its own reason.
    #[test]
    fn a_coin_in_a_round_is_shown_held_beside_the_files_holds() {
        let mut holds = CoinHolds::default();
        holds.hold(TXID, 0, FreezeReason::User, None).unwrap();
        let in_round: BTreeSet<String> = [format!("{TXID}:0"), format!("{TXID}:4")]
            .into_iter()
            .collect();
        let shown = with_round_holds(views(&holds), in_round);
        assert_eq!(shown.len(), 2);
        let user = shown.iter().find(|view| view.vout == 0).unwrap();
        assert_eq!(user.reason, "user");
        let round = shown.iter().find(|view| view.vout == 4).unwrap();
        assert_eq!(round.reason, "fusion-in-flight");
        assert!(!round.user_reversible);
        assert_eq!(round.outpoint, format!("{TXID}:4"));
    }

    /// The runtime reads the same file the send screen does.
    #[test]
    fn the_runtime_reads_the_same_per_wallet_file() {
        let directory = std::env::temp_dir().join(format!(
            "optn-host-holds-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        wallet_holds_file(&directory, 9)
            .update(|holds| {
                holds
                    .hold(TXID, 2, FreezeReason::User, None)
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let store = DesktopHostHolds::new(directory.clone());
        assert!(store.load(9).unwrap().is_held(TXID, 2));
        assert!(!store.load(10).unwrap().is_held(TXID, 2));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
