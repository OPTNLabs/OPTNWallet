//! Freeze and release coins, as the wallet's own reservation primitive.
//!
//! `optn_core::coins` already says what a hold means — a held coin is out of
//! ordinary send, Fusion selection and new pledges — and which holds the user
//! may lift. `optn_runtime::coin_holds` keeps that decision across restarts.
//! This module is only the door: it names the file for a wallet and passes
//! requests through. No screen decides whether a coin may be released.

use optn_chain_native::coin_holds_file::CoinHoldsFile;
use optn_core::coins::FreezeReason;
use optn_runtime::coin_holds::parse_reason;
use serde::Serialize;
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

/// One file per wallet: a hold belongs to the wallet whose coin it is.
fn holds_file(app: &tauri::AppHandle, wallet_id: u32) -> Result<CoinHoldsFile, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("coin-holds");
    Ok(CoinHoldsFile::new(
        directory.join(format!("wallet-{wallet_id}.json")),
    ))
}

fn views(holds: &optn_runtime::coin_holds::CoinHolds) -> Vec<CoinHoldView> {
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

#[tauri::command]
pub fn optn_coin_holds(
    app: tauri::AppHandle,
    wallet_id: u32,
) -> Result<Vec<CoinHoldView>, String> {
    Ok(views(&holds_file(&app, wallet_id)?.load()?))
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
    let holds = holds_file(&app, wallet_id)?.update(|holds| {
        holds
            .hold(&txid, vout, FreezeReason::User, note.clone())
            .map_err(|error| error.to_string())
    })?;
    Ok(views(&holds))
}

#[tauri::command]
pub fn optn_coin_unfreeze(
    app: tauri::AppHandle,
    wallet_id: u32,
    txid: String,
    vout: u32,
) -> Result<Vec<CoinHoldView>, String> {
    let holds = holds_file(&app, wallet_id)?.update(|holds| {
        holds
            .release_user_hold(&txid, vout)
            .map_err(|error| error.to_string())
    })?;
    Ok(views(&holds))
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
}
