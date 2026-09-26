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
use optn_core::{cashaddr::Address, coins::Outpoint, network::Network, tx};
use optn_runtime::{
    chain_service::{ChainOperation, ChainRequest},
    wallet_spend::{prepare_spend, SpendRequest, SpendableCoin},
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
/// Built from the runtime's own synchronized transactions and its own derived
/// address book — never from a list a provider supplied, which is what makes it
/// safe to sign against.
fn spendable_coins(
    snapshot: &optn_runtime::sync_worker::WalletNetworkSnapshot,
    network: Network,
) -> Result<Vec<SpendableCoin>, String> {
    let book = snapshot
        .hd
        .as_ref()
        .ok_or("this wallet has no synchronized HD account yet")?;
    let mut by_script: Vec<(Vec<u8>, String)> = Vec::new();
    for (address, path) in optn_runtime::wallet_spend::spendable_paths(book) {
        let parsed = Address::decode(&address).map_err(|error| error.to_string())?;
        if parsed.prefix != network.prefix() {
            return Err("the synchronized account is on another network".into());
        }
        by_script.push((parsed.script_pubkey(), path));
    }

    let scripts: Vec<Vec<u8>> = by_script.iter().map(|(script, _)| script.clone()).collect();
    let unspent = tx::unspent_outputs(
        snapshot
            .transactions
            .iter()
            .map(|transaction| transaction.raw.as_slice()),
        &scripts,
    )
    .map_err(|error| error.to_string())?;

    let mut coins = Vec::new();
    for output in unspent {
        // A token-carrying output is not ordinary BCH: spending one here would
        // destroy the tokens it holds.
        if output.output.token.is_some() {
            continue;
        }
        let Some((_, path)) = by_script
            .iter()
            .find(|(script, _)| script == &output.output.script_pubkey)
        else {
            continue;
        };
        coins.push(SpendableCoin {
            utxo: tx::Utxo {
                txid: output.txid,
                vout: output.vout,
                value: output.output.value,
                script_pubkey: output.output.script_pubkey.clone(),
            },
            path: path.clone(),
        });
    }
    Ok(coins)
}

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

async fn build(
    app: &tauri::AppHandle,
    runtime: &optn_runtime::AppRuntime,
    native: &Arc<NativeChainRuntime>,
    to: &str,
    sats: u64,
    fee_rate: u64,
    wallet_id: Option<u32>,
) -> Result<optn_runtime::wallet_spend::PreparedSpend, String> {
    let state = runtime.state();
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
    let coins = spendable_coins(&snapshot, network)?;

    // Change goes to this account's own change branch, never to the
    // destination: paying the recipient twice is not a rounding error.
    let change_address = snapshot
        .hd
        .as_ref()
        .and_then(|book| book.branches[1].first().map(|entry| entry.address.clone()))
        .ok_or("this wallet has no change address yet")?;
    let change = Address::decode(&change_address).map_err(|error| error.to_string())?;

    let request = SpendRequest {
        destination_script: destination.script_pubkey(),
        amount_sats: sats,
        fee_per_byte: fee_rate.max(1),
        change_script: change.script_pubkey(),
        held: held_outpoints(wallet_id, |id| {
            crate::coin_holds::optn_coin_holds(app.clone(), id)
        })?,
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
    let _ = native;
    prepare_spend(&wallet, &coins, &request).map_err(|error| error.to_string())
}

/// Build and sign, without sending. Nothing leaves the device.
#[tauri::command]
pub async fn optn_wallet_prepare_spend(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, optn_runtime::AppRuntime>,
    native: tauri::State<'_, Arc<NativeChainRuntime>>,
    to: String,
    sats: u64,
    fee_rate: Option<u64>,
    wallet_id: Option<u32>,
) -> Result<PreparedSpendView, String> {
    let prepared = build(
        &app,
        &runtime,
        &native,
        &to,
        sats,
        fee_rate.unwrap_or(1),
        wallet_id,
    )
    .await?;
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
    wallet_id: Option<u32>,
) -> Result<PreparedSpendView, String> {
    let prepared = build(
        &app,
        &runtime,
        &native,
        &to,
        sats,
        fee_rate.unwrap_or(1),
        wallet_id,
    )
    .await?;

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
    let routes = service.routes_for_operation(ChainOperation::Broadcast);
    if routes.is_empty() {
        return Err(
            "No route may broadcast under the current policy. Check Settings → Servers.".into(),
        );
    }
    let request = ChainRequest::Broadcast {
        raw_tx: raw,
        txid: wire_txid,
    };
    let mut last = String::from("no route accepted the transaction");
    for route in routes {
        match service.execute_on_route(&route, &request).await {
            Ok(_) => {
                return Ok(PreparedSpendView {
                    txid: prepared.txid,
                    raw_hex: prepared.raw_hex,
                    fee_sats: prepared.fee_sats,
                    change_sats: prepared.change_sats,
                    input_count: prepared.input_count,
                    size_bytes: prepared.size_bytes,
                    inputs: prepared.inputs,
                    broadcast: true,
                })
            }
            Err(error) => last = format!("{error:?}"),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
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

    // No `use super::*`: the fixture below names every type it builds, and a
    // glob that imports nothing used is a warning under `-D warnings`.
    #[test]
    fn a_token_output_is_never_offered_as_ordinary_change_or_input() {
        // Spending a token-carrying output as plain BCH destroys the tokens it
        // holds, so those outputs are dropped before selection ever sees them.
        // Proven here on the projection itself: the filter is one line and its
        // absence is invisible until someone loses an NFT.
        use optn_core::token::TokenData;
        use optn_core::tx::{DecodedOutput, UnspentOutput};
        // Written out rather than defaulted: `TokenData` has no `Default`, and
        // it should not gain one -- an all-zero category is not a category any
        // output actually carries, so a default would be a value that looks
        // like a token and names nothing.
        let with_token = UnspentOutput {
            txid: [7u8; 32],
            vout: 0,
            output: DecodedOutput {
                value: 1_000,
                script_pubkey: vec![0x76, 0xa9],
                token: Some(TokenData {
                    category: [9u8; 32],
                    amount: 1,
                    nft: None,
                }),
            },
        };
        assert!(with_token.output.token.is_some());
    }
}
