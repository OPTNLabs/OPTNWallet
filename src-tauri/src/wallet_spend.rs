//! Send BCH through the shared Rust engine.
//!
//! The CLI has been able to do this for a while; the wallet interfaces could
//! not, so each one grew its own build-and-sign path. `optn-runtime` now owns
//! the shared one, and this module is the door onto it: it collects the coins
//! the runtime has already synchronized, removes the ones the hold record says
//! are not free to spend, asks the runtime for the unlocked wallet under the
//! spend authorization policy, and broadcasts through whichever route the
//! connection policy allows.
//!
//! Preparing and sending are separate commands on purpose. A preview that
//! quietly broadcast would be the worst possible surprise in a wallet.

use crate::chain_runtime::NativeChainRuntime;
use optn_core::{cashaddr::Address, coins::Outpoint};
use optn_runtime::{
    tx_broadcast::{BroadcastCoordinator, BroadcastState},
    wallet_spend::{prepare_spend, SpendRequest},
    WalletOperationGuard,
};
use optn_transport::security::{
    WalletBroadcastRequest, WalletBroadcastResponse, WalletBroadcastStatus,
};
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct PreparedSpendView {
    pub txid: String,
    pub raw_hex: String,
    pub fee_sats: u64,
    pub change_sats: u64,
    pub input_count: usize,
    pub size_bytes: usize,
    pub inputs: Vec<String>,
    /// Set only by the send command, once a route has accepted it.
    pub broadcast: bool,
}

/// Collect this account's spendable outputs with the path that signs each.
///
/// Outpoints this wallet may not spend, read from the durable hold record.
fn held_outpoints(
    wallet_id: Option<u32>,
    read: impl FnOnce(u32) -> Result<Vec<crate::coin_holds::CoinHoldView>, String>,
) -> Result<BTreeSet<String>, String> {
    let wallet_id = wallet_id
        .filter(|id| *id > 0)
        .ok_or("a wallet id is required to check coin holds")?;
    read(wallet_id).map(|holds| holds.into_iter().map(|hold| hold.outpoint).collect())
}

fn hold_owner(status: &optn_transport::WalletSecurityStatus, epoch: u64) -> Result<u32, String> {
    if status.epoch != epoch || status.active.is_none() {
        return Err("Wallet changed. Review the transaction again.".into());
    }
    status
        .legacy_source_id
        .filter(|id| *id > 0)
        .ok_or_else(|| "This wallet has no verified legacy hold-file owner.".into())
}

async fn session_holds(
    app: &tauri::AppHandle,
    runtime: &optn_runtime::AppRuntime,
    epoch: u64,
) -> Result<BTreeSet<String>, String> {
    let status = runtime
        .wallet_security(optn_transport::WalletSecurityRequest::Status)
        .await
        .map_err(|_| "Wallet session is unavailable. Reopen it.")?;
    let mut held = held_outpoints(Some(hold_owner(&status, epoch)?), |id| {
        crate::coin_holds::optn_coin_holds(app.clone(), id)
    })?;
    let state = runtime.state();
    if state.lock.unlock_epoch != epoch
        || state.wallet.is_none()
        || !state.wallet_sync.utxos_fresh
        || !state.wallet_sync.history_fresh
    {
        return Err("Wallet changed or needs a refresh. Review the transaction again.".into());
    }
    held.extend(
        state
            .coins
            .iter()
            .filter(|coin| coin.freeze().is_some())
            .map(|coin| coin.outpoint().to_string()),
    );
    Ok(held)
}

async fn build(
    app: &tauri::AppHandle,
    runtime: &optn_runtime::AppRuntime,
    to: &str,
    sats: u64,
    fee_rate: u64,
) -> Result<
    (
        optn_runtime::wallet_spend::PreparedSpend,
        u64,
        WalletOperationGuard,
    ),
    String,
> {
    let guard = runtime.wallet_operation_guard();
    let state = runtime.state();
    let epoch = state.lock.unlock_epoch;
    let network = state.network;
    let destination = Address::decode(to).map_err(|error| error.to_string())?;
    if destination.prefix != network.prefix() {
        return Err(format!(
            "that address is for another network; this wallet is on {network}"
        ));
    }

    let reconciliation = runtime.subscribe_wallet_sync().borrow().clone();
    let snapshot = reconciliation
        .authoritative
        .ok_or("synchronize this wallet before sending")?
        .value;
    let coins = optn_runtime::wallet_spend::snapshot_spendable_coins(&snapshot, network)?;
    if snapshot.hd.as_ref().map(|book| &book.account_xpub)
        != state
            .wallet
            .as_ref()
            .and_then(|wallet| wallet.account_xpub.as_ref())
    {
        return Err("Synchronized account does not match the open wallet.".into());
    }

    // Change goes to this account's own change branch, never to the
    // destination: paying the recipient twice is not a rounding error.
    let change_address = snapshot
        .hd
        .as_ref()
        .and_then(|book| book.branches[1].first().map(|entry| entry.address.clone()))
        .ok_or("this wallet has no change address yet")?;
    let change = Address::decode(&change_address).map_err(|error| error.to_string())?;

    let mut request = SpendRequest {
        destination_script: destination.script_pubkey(),
        amount_sats: sats,
        fee_per_byte: fee_rate.max(1),
        change_script: change.script_pubkey(),
        held: session_holds(app, runtime, epoch).await?,
    };

    // The unlocked wallet is borrowed for the signature and dropped with this
    // scope; the runtime applies its own spend-authorization policy first.
    let wallet = runtime
        .wallet_for_operation(optn_app::AuthScope::Spend)
        .await
        .map_err(|error| match error {
            optn_transport::TransportError::AuthenticationRequired => {
                "Confirm your password before sending.".to_string()
            }
            optn_transport::TransportError::Unsupported => {
                "This wallet cannot sign on this interface.".to_string()
            }
            other => format!("{other:?}"),
        })?;
    // Authorization can yield while a lock, wallet switch or hold is applied.
    // Re-read the bound record before any signature is created.
    request.held = session_holds(app, runtime, epoch).await?;
    let current = runtime.subscribe_wallet_sync().borrow().clone();
    if current
        .authoritative
        .as_ref()
        .map(|accepted| &accepted.value)
        != Some(&snapshot)
    {
        return Err("Wallet history changed. Review the transaction again.".into());
    }
    if guard.is_revoked() {
        return Err("Wallet changed. Review the transaction again.".into());
    }
    let prepared = prepare_spend(&wallet, &coins, &request).map_err(|error| error.to_string())?;
    if guard.is_revoked() {
        return Err("Wallet changed while signing. Review the transaction again.".into());
    }
    Ok((prepared, epoch, guard))
}

fn uncertain_broadcast(txid: &str) -> String {
    format!("Broadcast outcome for {txid} is unknown. Refresh history before retrying.")
}

async fn preflight_signed(
    app: &tauri::AppHandle,
    runtime: &optn_runtime::AppRuntime,
    request: &WalletBroadcastRequest,
    raw: &[u8],
) -> Result<optn_runtime::wallet_spend::PreparedSignedTransaction, String> {
    let status = runtime
        .wallet_security(optn_transport::WalletSecurityRequest::Status)
        .await
        .map_err(|_| "Wallet session is unavailable. Reopen it.")?;
    let held = session_holds(app, runtime, request.epoch).await?;
    optn_runtime::wallet_spend::validate_signed_submission(
        &runtime.state(),
        &status,
        request,
        raw,
        &held,
    )
    .map_err(|error| match error {
        optn_transport::TransportError::Other(message)
        | optn_transport::TransportError::InvalidData(message) => message,
        _ => "Wallet submission is unavailable.".into(),
    })
}

/// Relay the exact signed BCH/CashToken bytes reviewed in the retained UI.
/// This never signs, rebuilds, chooses a legacy server or bypasses Rust policy.
#[tauri::command]
pub async fn optn_wallet_broadcast(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    request: WalletBroadcastRequest,
) -> Result<WalletBroadcastResponse, String> {
    let guard = runtime.wallet_operation_guard();
    let attempt = async {
        if request.raw_hex.len() > 2 * optn_runtime::wallet_spend::MAX_SIGNED_TRANSACTION_BYTES {
            return Err("Signed transaction exceeds the submission limit.".to_string());
        }
        let raw = hex::decode(&request.raw_hex)
            .map_err(|_| "Signed transaction is not valid hexadecimal.".to_string())?;
        let prepared = preflight_signed(&app, &runtime, &request, &raw).await?;
        let service = native
            .with_service(Arc::clone)
            .await
            .ok_or("Chain source is still connecting. Retry when it is ready.")?;
        let mut service = service
            .try_lock()
            .map_err(|_| "A chain operation is already running. Please wait.")?;
        // Provider acquisition can yield. Bind the same bytes and reread durable
        // holds immediately before the coordinator is allowed to start I/O.
        preflight_signed(&app, &runtime, &request, &raw).await?;
        let outcome = BroadcastCoordinator
            .submit_guarded(&mut service, prepared.raw, prepared.wire_txid, &guard)
            .await;
        Ok::<_, String>((prepared.txid, outcome))
    }
    .await;
    Ok(match attempt {
        Ok((txid, outcome)) => {
            let (status, message) = match outcome {
                BroadcastState::Submitted { .. } | BroadcastState::Observed { .. } => {
                    (WalletBroadcastStatus::Accepted, None)
                }
                BroadcastState::Rejected { .. } => (
                    WalletBroadcastStatus::Rejected,
                    Some("The selected sources rejected the transaction.".into()),
                ),
                BroadcastState::Unavailable { .. } => (
                    WalletBroadcastStatus::Deferred,
                    Some("Wallet or permitted route changed. Refresh before retrying.".into()),
                ),
                _ => (
                    WalletBroadcastStatus::Uncertain,
                    Some(uncertain_broadcast(&txid)),
                ),
            };
            WalletBroadcastResponse {
                txid,
                status,
                message,
            }
        }
        Err(message) => WalletBroadcastResponse {
            txid: String::new(),
            status: WalletBroadcastStatus::Deferred,
            message: Some(message),
        },
    })
}

/// Build and sign, without sending. Nothing leaves the device.
#[tauri::command]
pub async fn optn_wallet_prepare_spend(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    to: String,
    sats: u64,
    fee_rate: Option<u64>,
) -> Result<PreparedSpendView, String> {
    let (prepared, _, _) = build(&app, &runtime, &to, sats, fee_rate.unwrap_or(1)).await?;
    Ok(PreparedSpendView {
        txid: prepared.txid,
        raw_hex: prepared.raw_hex,
        fee_sats: prepared.fee_sats,
        change_sats: prepared.change_sats,
        input_count: prepared.input_count,
        size_bytes: prepared.size_bytes,
        inputs: prepared.inputs,
        broadcast: false,
    })
}

/// Build, sign and broadcast through a policy-allowed route.
///
/// The transaction is rebuilt here rather than taking a previously previewed
/// one from the renderer: a raw transaction handed back across the boundary is
/// a raw transaction this host did not decide to make.
#[tauri::command]
pub async fn optn_wallet_send(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    to: String,
    sats: u64,
    fee_rate: Option<u64>,
) -> Result<PreparedSpendView, String> {
    let (prepared, epoch, guard) = build(&app, &runtime, &to, sats, fee_rate.unwrap_or(1)).await?;

    let raw = hex::decode(&prepared.raw_hex).map_err(|error| error.to_string())?;
    let txid = Outpoint::parse(&prepared.txid, 0)
        .map_err(|error| error.to_string())?
        .txid();
    // Wire order, which is the display txid reversed.
    let mut wire_txid = txid;
    wire_txid.reverse();

    let service = native
        .with_service(Arc::clone)
        .await
        .ok_or("Chain source is still connecting. Select a source in Settings and retry.")?;
    let mut service = service
        .try_lock()
        .map_err(|_| "A chain operation is already running. Please wait.")?;
    let held = session_holds(&app, &runtime, epoch).await?;
    if prepared.inputs.iter().any(|input| held.contains(input)) {
        return Err("A selected coin is frozen or reserved. Review the transaction again.".into());
    }
    match BroadcastCoordinator
        .submit_guarded(&mut service, raw, wire_txid, &guard)
        .await
    {
        BroadcastState::Submitted { .. } => Ok(PreparedSpendView {
            txid: prepared.txid,
            raw_hex: prepared.raw_hex,
            fee_sats: prepared.fee_sats,
            change_sats: prepared.change_sats,
            input_count: prepared.input_count,
            size_bytes: prepared.size_bytes,
            inputs: prepared.inputs,
            broadcast: true,
        }),
        BroadcastState::Unavailable { .. } => {
            Err("No route may broadcast under the current policy. Check Settings → Network.".into())
        }
        BroadcastState::Rejected { .. } => {
            Err("The selected sources rejected the transaction.".into())
        }
        _ => Err(uncertain_broadcast(&prepared.txid)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hold_owner_requires_the_authoritative_open_session() {
        let status = optn_transport::WalletSecurityStatus {
            active: Some("bound-wallet.optn".into()),
            epoch: 7,
            legacy_source_id: Some(42),
            ..Default::default()
        };
        assert_eq!(super::hold_owner(&status, 7), Ok(42));
        assert!(super::hold_owner(&status, 6).is_err());
        assert!(super::hold_owner(
            &optn_transport::WalletSecurityStatus {
                active: None,
                ..status.clone()
            },
            7
        )
        .is_err());
        for legacy_source_id in [None, Some(0)] {
            assert!(super::hold_owner(
                &optn_transport::WalletSecurityStatus {
                    legacy_source_id,
                    ..status.clone()
                },
                7
            )
            .is_err());
        }
    }

    #[test]
    fn coin_holds_require_a_wallet_and_propagate_read_errors() {
        for wallet_id in [None, Some(0)] {
            assert!(
                super::held_outpoints(wallet_id, |_| panic!("must not read without a wallet"))
                    .is_err()
            );
        }
        assert_eq!(
            super::held_outpoints(Some(42), |id| {
                assert_eq!(id, 42);
                Err("coin holds file is unreadable".into())
            }),
            Err("coin holds file is unreadable".into())
        );
        assert!(super::held_outpoints(Some(42), |_| Ok(Vec::new()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_token_output_is_never_offered_as_ordinary_change_or_input() {
        use optn_core::{
            cashaddr::Address,
            hd::{AccountPath, Wallet},
            network::Network,
            token::TokenData,
            tx::{self, Output, Transaction, Utxo},
            watch_only::{address_under_account, HdAddressBook},
        };
        use optn_runtime::{
            chain_service::{ObservedTransaction, WalletInterest},
            sync_worker::WalletNetworkSnapshot,
        };

        let network = Network::Chipnet;
        let wallet = Wallet::from_mnemonic(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "",
        ).unwrap();
        let account = AccountPath::default_for(network);
        let xpub = wallet.account_xpub_at(account).unwrap();
        let preview = address_under_account(network, &xpub, 0, 0).unwrap();
        let script = Address::decode(&preview.address).unwrap().script_pubkey();
        // Projection fixture only: both outputs pay the same derived script,
        // so the token prefix is the only reason to exclude output zero.
        let raw = Transaction::new(
            vec![Utxo {
                txid: [7; 32],
                vout: 0,
                value: 4_000,
                script_pubkey: script.clone(),
            }],
            vec![
                Output::with_tokens(
                    1_000,
                    script.clone(),
                    TokenData::fungible([9; 32], 1).encode_prefix().unwrap(),
                ),
                Output::new(2_000, script.clone()),
            ],
        )
        .sign(&[wallet.signing_key(&preview.path).unwrap()])
        .unwrap();
        let txid = tx::double_sha256(&raw);
        let snapshot = WalletNetworkSnapshot {
            hd: Some(HdAddressBook {
                account,
                account_xpub: xpub,
                branches: [vec![preview], vec![], vec![], vec![]],
                last_used: [Some(0), None, None, None],
            }),
            interests: vec![WalletInterest::script(script.clone())],
            transactions: vec![ObservedTransaction {
                txid,
                raw,
                block_height: None,
            }],
            tip: None,
        };

        let coins =
            optn_runtime::wallet_spend::snapshot_spendable_coins(&snapshot, network).unwrap();
        assert_eq!(
            coins.len(),
            1,
            "token output must never reach BCH selection"
        );
        assert_eq!(coins[0].utxo.txid, txid);
        assert_eq!(coins[0].utxo.vout, 1);
        assert_eq!(coins[0].utxo.value, 2_000);
        assert_eq!(coins[0].utxo.script_pubkey, script);
        assert_eq!(coins[0].path, "m/44'/1'/0'/0/0");
    }
}
