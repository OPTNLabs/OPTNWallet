//! Build ordinary BCH spends and preflight already signed wallet transactions.
//!
//! The CLI could already do this; the wallet interfaces could not, because the
//! code lived in the CLI binary and every other surface had to reimplement it.
//! That is how two implementations of the same money path start. This module is
//! the shared one: the same `optn_core` selection, sighash and signing, over
//! whatever the runtime has already synchronized, with the outputs a caller may
//! not spend removed before selection rather than after.
//!
//! It performs no I/O and holds no keys of its own: the caller supplies the
//! unlocked wallet for as long as the signature takes, and broadcasts the
//! result through whichever chain route policy allows.

use optn_app::AppState;
use optn_core::{
    cashaddr::Address,
    coins::Outpoint,
    error::{CliError, Result},
    hd::Wallet,
    network::Network,
    tx::{self, Output, Transaction, Utxo},
    watch_only::HdAddressBook,
};
use optn_transport::{security::WalletBroadcastRequest, TransportError, WalletSecurityStatus};
use std::collections::BTreeSet;

/// The same bound used by the native signed-transaction relay. Hosts must also
/// check the hex length before allocating decoded bytes.
pub const MAX_SIGNED_TRANSACTION_BYTES: usize = 100_000;

/// Exact bytes and identities of a transaction that passed wallet preflight.
/// This is neither a signature-verification result nor a broadcast receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSignedTransaction {
    pub raw: Vec<u8>,
    /// Display-order hash, matching the wallet's outbound tracker.
    pub txid: String,
    /// Internal/wire hash for the shared broadcast coordinator.
    pub wire_txid: [u8; 32],
    /// Display-order `txid:vout` values derived from the actual raw inputs.
    pub inputs: Vec<String>,
}

/// Preflight signed bytes without rebuilding outputs or obtaining signing keys.
///
/// `state` and `status` must come from the same authenticated runtime, protected
/// by its retained operation guard across all host awaits and submission. The
/// current fresh coin set is the ownership scope, including CashTokens. Unknown
/// inputs are not presumed to be external contracts: they may be stale wallet
/// inputs. Uncovered contracts, RPA and multisig require their own authenticated
/// coverage before this scope can admit them. Hardware/watch-only single-account
/// wallets may submit externally signed bytes under the same checks.
pub fn validate_signed_submission(
    state: &AppState,
    status: &WalletSecurityStatus,
    request: &WalletBroadcastRequest,
    raw: &[u8],
    held: &BTreeSet<String>,
) -> std::result::Result<PreparedSignedTransaction, TransportError> {
    if state.surface.is_viewer_only() {
        return Err(TransportError::Unsupported);
    }
    if !status.available
        || status
            .active
            .as_ref()
            .is_none_or(|handle| handle.is_empty())
        || request.wallet_id == 0
        || status.legacy_source_id != Some(request.wallet_id)
        || status.epoch != request.epoch
        || state.lock.unlock_epoch != request.epoch
    {
        return Err(TransportError::Other(
            "The signed transaction does not belong to the authenticated wallet session.".into(),
        ));
    }
    let network = request
        .network
        .parse::<Network>()
        .map_err(TransportError::InvalidData)?;
    if network != state.network {
        return Err(TransportError::Other(
            "The wallet network changed. Review the transaction again.".into(),
        ));
    }
    let wallet = state.wallet.as_ref().ok_or_else(|| {
        TransportError::Other("Unlock the wallet before submitting a transaction.".into())
    })?;
    if !state.wallet_sync.utxos_fresh
        || !state.wallet_sync.history_fresh
        || state.wallet_sync.refreshing
    {
        return Err(TransportError::Other(
            "Refresh the wallet before submitting a transaction.".into(),
        ));
    }
    if wallet.multisig_policy.is_some()
        || wallet.account_xpub.is_none()
        || state.hd_addresses.is_none()
    {
        return Err(TransportError::Other(
            "This wallet has no authenticated single-account submission coverage.".into(),
        ));
    }
    if raw.is_empty()
        || raw.len() > MAX_SIGNED_TRANSACTION_BYTES
        || request.raw_hex.len() != raw.len() * 2
        || !request.raw_hex.eq_ignore_ascii_case(&hex_lower(raw))
    {
        return Err(TransportError::InvalidData(
            "Transaction bytes must match the bounded hexadecimal request.".into(),
        ));
    }
    let decoded =
        tx::decode(raw).map_err(|error| TransportError::InvalidData(error.to_string()))?;
    if decoded.inputs.is_empty() || decoded.outputs.is_empty() {
        return Err(TransportError::InvalidData(
            "A wallet transaction must have inputs and outputs.".into(),
        ));
    }
    let mut unique = BTreeSet::new();
    let mut inputs = Vec::with_capacity(decoded.inputs.len());
    for (mut txid, vout, _) in decoded.inputs {
        if !unique.insert((txid, vout)) || (txid == [0; 32] && vout == u32::MAX) {
            return Err(TransportError::InvalidData(
                "Duplicate or coinbase inputs cannot be submitted as a wallet spend.".into(),
            ));
        }
        txid.reverse();
        let outpoint = Outpoint::new(txid, vout);
        let displayed = outpoint.to_string();
        let coin = state.coins.get(outpoint).ok_or_else(|| {
            TransportError::Other(
                "An input is outside the wallet's fresh owned coins. Refresh or use a supported submission scope."
                    .into(),
            )
        })?;
        if coin.freeze().is_some() || held.contains(&displayed) {
            return Err(TransportError::Other(
                "A transaction input is frozen or reserved.".into(),
            ));
        }
        if coin.is_rpa() {
            return Err(TransportError::Other(
                "RPA input coverage is unavailable for this submission scope.".into(),
            ));
        }
        let address = Address::decode(coin.address()).map_err(TransportError::InvalidData)?;
        if address.prefix != network.prefix() {
            return Err(TransportError::InvalidData(
                "A transaction input belongs to another network.".into(),
            ));
        }
        inputs.push(displayed);
    }
    let wire_txid = tx::double_sha256(raw);
    let mut display = wire_txid;
    display.reverse();
    Ok(PreparedSignedTransaction {
        raw: raw.to_vec(),
        txid: hex_lower(&display),
        wire_txid,
        inputs,
    })
}

/// A spendable output together with the path whose key controls it.
#[derive(Debug, Clone)]
pub struct SpendableCoin {
    pub utxo: Utxo,
    /// Derivation path of the key that signs this input.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendRequest {
    /// Locking script of the destination, already parsed from its address.
    pub destination_script: Vec<u8>,
    pub amount_sats: u64,
    pub fee_per_byte: u64,
    /// Where change goes. Reusing the destination would pay the recipient twice.
    pub change_script: Vec<u8>,
    /// Outpoints the wallet is not free to spend, as `txid:vout` in display
    /// order: frozen coins, Flipstarter pledges, coins committed to a running
    /// fusion. Excluded before selection, because a spend that "accidentally"
    /// picked one would double-spend that round's own inputs. The spelling is
    /// the one the hold record and every renderer already use.
    pub held: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSpend {
    /// Display-order txid, as every wallet surface shows it.
    pub txid: String,
    pub raw_hex: String,
    pub fee_sats: u64,
    pub change_sats: u64,
    pub input_count: usize,
    pub size_bytes: usize,
    /// The exact outpoints this transaction spends, `txid:vout`, so a caller
    /// can hold them while it is in flight instead of guessing which went.
    pub inputs: Vec<String>,
}

/// Dust, as the network's relay rule counts it.
///
/// Change below this cannot be relayed, so it is given to the fee instead of
/// creating an output that makes the transaction unbroadcastable.
const DUST_LIMIT: u64 = 546;

/// Every address this account watches, paired with the path that controls it.
///
/// The address book is the runtime's own derivation, never a provider's claim,
/// which is what makes it safe to sign against.
pub fn spendable_paths(book: &HdAddressBook) -> Vec<(String, String)> {
    book.branches
        .iter()
        .flatten()
        .map(|preview| (preview.address.clone(), preview.path.clone()))
        .collect()
}

/// Build and sign a spend.
///
/// Returns the raw transaction rather than broadcasting it: whether a
/// transaction may leave this device is a policy question about routes, and
/// this function is the part that is the same everywhere.
pub fn prepare_spend(
    wallet: &Wallet,
    coins: &[SpendableCoin],
    request: &SpendRequest,
) -> Result<PreparedSpend> {
    if request.amount_sats == 0 {
        return Err(CliError::Usage("enter an amount to send".into()));
    }
    if request.destination_script.is_empty() {
        return Err(CliError::Usage(
            "the destination has no locking script".into(),
        ));
    }

    let available: Vec<Utxo> = coins
        .iter()
        .filter(|coin| !request.held.contains(&display_outpoint(&coin.utxo)))
        .map(|coin| coin.utxo.clone())
        .collect();
    if available.is_empty() {
        return Err(CliError::Usage(
            "no spendable coins: every output is frozen, reserved, or the account has none".into(),
        ));
    }

    let (chosen, fee) = tx::select_coins(&available, request.amount_sats, request.fee_per_byte, 2)?;
    let input_total: u64 = chosen
        .iter()
        .try_fold(0u64, |sum, utxo| sum.checked_add(utxo.value))
        .ok_or_else(|| CliError::Protocol("funding total exceeds the amount range".into()))?;
    let change = input_total
        .checked_sub(request.amount_sats)
        .and_then(|rest| rest.checked_sub(fee))
        .ok_or_else(|| CliError::Usage("not enough funds for that amount and fee".into()))?;

    let mut outputs = vec![Output {
        value: request.amount_sats,
        script_pubkey: request.destination_script.clone(),
        token_prefix: None,
    }];
    // Dust change cannot be relayed. Paying it as fee keeps the transaction
    // broadcastable instead of producing one the network will not carry.
    if change >= DUST_LIMIT {
        outputs.push(Output {
            value: change,
            script_pubkey: request.change_script.clone(),
            token_prefix: None,
        });
    }
    let change_sats = if change >= DUST_LIMIT { change } else { 0 };

    let keys = chosen
        .iter()
        .map(|utxo| {
            let coin = coins
                .iter()
                .find(|candidate| {
                    candidate.utxo.txid == utxo.txid && candidate.utxo.vout == utxo.vout
                })
                .ok_or_else(|| {
                    CliError::Internal("selected an output with no known signing path".into())
                })?;
            wallet.signing_key(&coin.path)
        })
        .collect::<Result<Vec<_>>>()?;

    let transaction = Transaction::new(chosen.clone(), outputs);
    let raw = transaction.sign(&keys)?;
    let mut txid = tx::double_sha256(&raw);
    txid.reverse();

    Ok(PreparedSpend {
        txid: hex_lower(&txid),
        raw_hex: hex_lower(&raw),
        fee_sats: input_total - request.amount_sats - change_sats,
        change_sats,
        input_count: chosen.len(),
        size_bytes: raw.len(),
        inputs: chosen.iter().map(display_outpoint).collect(),
    })
}

/// `txid:vout` in display order, the spelling the hold record and the
/// interfaces use. The wire keeps txids reversed; mixing the two orders is how
/// a hold silently fails to match the coin it was taken on.
fn display_outpoint(utxo: &Utxo) -> String {
    let mut display = utxo.txid;
    display.reverse();
    format!("{}:{}", hex_lower(&display), utxo.vout)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Derive ordinary spendable coins from reconciled raw history. Token outputs are excluded.
pub fn snapshot_spendable_coins(
    snapshot: &crate::sync_worker::WalletNetworkSnapshot,
    network: Network,
) -> std::result::Result<Vec<SpendableCoin>, String> {
    let book = snapshot
        .hd
        .as_ref()
        .ok_or("this wallet has no synchronized HD account yet")?;
    let mut by_script: Vec<(Vec<u8>, String)> = Vec::new();
    for (address, path) in spendable_paths(book) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hd_sync::{HdAccountScan, HdSyncLimits};
    use optn_core::hd::AccountPath;
    use optn_core::network::Network;

    const MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn wallet() -> Wallet {
        Wallet::from_mnemonic(MNEMONIC, "").unwrap()
    }

    #[derive(Clone)]
    struct SubmissionFixture {
        state: AppState,
        status: WalletSecurityStatus,
        request: WalletBroadcastRequest,
        raw: Vec<u8>,
        outpoint: Outpoint,
        input: Utxo,
    }

    impl SubmissionFixture {
        fn new() -> Self {
            let wallet = wallet();
            let path = "m/44'/1'/0'/0/0";
            let address = wallet.address(Network::Chipnet, path).unwrap();
            let input = Utxo {
                // Asymmetric hashes catch display/wire-order hold bypasses.
                txid: std::array::from_fn(|index| index as u8),
                vout: 0,
                value: 50_000,
                script_pubkey: address.script_pubkey(),
            };
            let token = optn_core::token::TokenData::fungible(input.txid, 42);
            let raw = Transaction::new(
                vec![input.clone()],
                vec![Output::with_tokens(
                    49_000,
                    address.script_pubkey(),
                    token.encode_prefix().unwrap(),
                )],
            )
            .sign(&[wallet.signing_key(path).unwrap()])
            .unwrap();
            let mut display = input.txid;
            display.reverse();
            let outpoint = Outpoint::new(display, input.vout);
            let mut state = AppState {
                network: Network::Chipnet,
                ..Default::default()
            };
            state.reduce(optn_app::AppAction::OpenImportedWallet {
                name: "Public raw submission fixture".into(),
                receive_address: address.encode(),
                account_path: "m/44'/1'/0'".into(),
            });
            state.wallet.as_mut().unwrap().account_xpub =
                Some(wallet.account_xpub(Network::Chipnet, 0).unwrap());
            state.hd_addresses = Some(Default::default());
            state.wallet_sync.utxos_fresh = true;
            state.wallet_sync.history_fresh = true;
            state
                .coins
                .insert(
                    optn_core::coins::Coin::new(outpoint, input.value, address.encode()).unwrap(),
                )
                .unwrap();
            let status = WalletSecurityStatus {
                available: true,
                active: Some("public-fixture.optn".into()),
                legacy_source_id: Some(42),
                epoch: state.lock.unlock_epoch,
                ..Default::default()
            };
            let request = WalletBroadcastRequest {
                wallet_id: 42,
                epoch: status.epoch,
                network: "chipnet".into(),
                raw_hex: hex_lower(&raw),
            };
            Self {
                state,
                status,
                request,
                raw,
                outpoint,
                input,
            }
        }

        fn validate(
            &self,
            held: BTreeSet<String>,
        ) -> std::result::Result<PreparedSignedTransaction, TransportError> {
            validate_signed_submission(&self.state, &self.status, &self.request, &self.raw, &held)
        }

        fn replace_raw(&mut self, raw: Vec<u8>) {
            self.request.raw_hex = hex_lower(&raw);
            self.raw = raw;
        }
    }

    #[test]
    fn signed_submission_preserves_signature_and_token_bytes_for_covered_wallet_kinds() {
        let mut fixture = SubmissionFixture::new();
        // Hardware and airgap signatures are opaque to submission. No signing
        // key is requested and the original bytes remain the hash commitment.
        fixture.request.raw_hex.make_ascii_uppercase();
        for kind in [
            optn_app::WalletKind::Seed,
            optn_app::WalletKind::Hardware,
            optn_app::WalletKind::WatchOnly,
        ] {
            fixture.state.wallet.as_mut().unwrap().kind = kind;
            let prepared = fixture.validate(BTreeSet::new()).unwrap();
            assert_eq!(prepared.raw, fixture.raw);
            assert_eq!(prepared.wire_txid, tx::double_sha256(&fixture.raw));
            let mut expected = prepared.wire_txid;
            expected.reverse();
            assert_eq!(prepared.txid, hex_lower(&expected));
            assert_eq!(prepared.inputs, [fixture.outpoint.to_string()]);
            assert!(tx::decode(&prepared.raw).unwrap().outputs[0]
                .token
                .is_some());
        }
        // Token custody in the accepted coin set must not filter a submitted
        // input as the ordinary BCH builder does. This preflight is not a
        // token-conservation or signature-verification result.
        let token_coin = fixture
            .state
            .coins
            .get(fixture.outpoint)
            .unwrap()
            .clone()
            .with_token(optn_core::token::TokenData::fungible([7; 32], 42));
        fixture.state.coins.clear();
        fixture.state.coins.insert(token_coin).unwrap();
        assert_eq!(fixture.validate(BTreeSet::new()).unwrap().raw, fixture.raw);
    }

    #[test]
    fn signed_submission_binds_status_epoch_network_and_fresh_coverage() {
        let original = SubmissionFixture::new();
        let changes: &[fn(&mut SubmissionFixture)] = &[
            |f| f.state.surface = optn_app::AppSurface::Extension,
            |f| f.status.available = false,
            |f| f.status.active = None,
            |f| f.status.legacy_source_id = None,
            |f| f.request.wallet_id = 0,
            |f| f.request.wallet_id = 43,
            |f| f.request.epoch += 1,
            |f| f.status.epoch += 1,
            |f| f.state.lock.unlock_epoch += 1,
            |f| f.state.wallet = None,
            |f| f.request.network = "testnet4".into(),
            |f| f.request.network = "bchtest".into(),
            |f| f.state.wallet_sync.utxos_fresh = false,
            |f| f.state.wallet_sync.history_fresh = false,
            |f| f.state.wallet_sync.refreshing = true,
            |f| f.state.hd_addresses = None,
            |f| f.state.wallet.as_mut().unwrap().account_xpub = None,
            |f| f.state.wallet.as_mut().unwrap().multisig_policy = Some("2 of 3".into()),
        ];
        for (index, change) in changes.iter().enumerate() {
            let mut fixture = original.clone();
            change(&mut fixture);
            assert!(fixture.validate(BTreeSet::new()).is_err(), "case {index}");
        }
    }

    #[test]
    fn signed_submission_rejects_frozen_held_unknown_and_uncovered_rpa_inputs() {
        let mut fixture = SubmissionFixture::new();
        let mut held = BTreeSet::from([fixture.outpoint.to_string()]);
        assert!(fixture.validate(held.clone()).is_err());
        held.clear();
        fixture
            .state
            .coins
            .freeze(fixture.outpoint, optn_core::coins::FreezeReason::User)
            .unwrap();
        assert!(fixture.validate(held.clone()).is_err());
        fixture.state.coins.unfreeze(fixture.outpoint).unwrap();
        assert!(fixture.validate(held.clone()).is_ok());
        // An omitted input cannot silently be treated as an external contract.
        fixture.state.coins.clear();
        assert!(fixture.validate(held.clone()).is_err());
        let rpa = optn_core::coins::Coin::from_rpa_payment(
            fixture.outpoint,
            fixture.input.value,
            fixture
                .state
                .wallet
                .as_ref()
                .unwrap()
                .receive_address
                .clone(),
            "01".repeat(32),
            0,
            format!("02{}", "01".repeat(32)),
        )
        .unwrap();
        fixture.state.coins.insert(rpa).unwrap();
        assert!(fixture.validate(held).is_err());
    }

    #[test]
    fn signed_submission_checks_every_input_not_just_one_owned_input() {
        let mut fixture = SubmissionFixture::new();
        let key = wallet().signing_key("m/44'/1'/0'/0/0").unwrap();
        let additional = Utxo {
            vout: 1,
            ..fixture.input.clone()
        };
        let raw = Transaction::new(
            vec![fixture.input.clone(), additional.clone()],
            vec![Output::new(90_000, additional.script_pubkey.clone())],
        )
        .sign(&[key.clone(), key])
        .unwrap();
        fixture.replace_raw(raw);
        assert!(fixture.validate(BTreeSet::new()).is_err());
        let second = Outpoint::new(fixture.outpoint.txid(), 1);
        fixture
            .state
            .coins
            .insert(
                optn_core::coins::Coin::new(
                    second,
                    additional.value,
                    fixture
                        .state
                        .wallet
                        .as_ref()
                        .unwrap()
                        .receive_address
                        .clone(),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(fixture.validate(BTreeSet::new()).is_ok());
        assert!(fixture
            .validate(BTreeSet::from([second.to_string()]))
            .is_err());
    }

    #[test]
    fn signed_submission_rejects_duplicate_inputs_and_malformed_or_unbound_bytes() {
        let mut fixture = SubmissionFixture::new();
        let original = fixture.raw.clone();
        let key = wallet().signing_key("m/44'/1'/0'/0/0").unwrap();
        let duplicate = Transaction::new(
            vec![fixture.input.clone(), fixture.input.clone()],
            vec![Output::new(10_000, fixture.input.script_pubkey.clone())],
        )
        .sign(&[key.clone(), key.clone()])
        .unwrap();
        fixture.replace_raw(duplicate);
        assert!(matches!(
            fixture.validate(BTreeSet::new()),
            Err(TransportError::InvalidData(_))
        ));
        for raw in [
            Vec::new(),
            Transaction::new(Vec::new(), vec![Output::new(1, vec![0x51])])
                .sign(&[])
                .unwrap(),
            Transaction::new(vec![fixture.input.clone()], Vec::new())
                .sign(&[key])
                .unwrap(),
            original[..original.len() - 1].to_vec(),
            [original.as_slice(), &[0]].concat(),
            vec![0; MAX_SIGNED_TRANSACTION_BYTES + 1],
        ] {
            fixture.replace_raw(raw);
            assert!(matches!(
                fixture.validate(BTreeSet::new()),
                Err(TransportError::InvalidData(_))
            ));
        }
        fixture.replace_raw(original);
        fixture.request.raw_hex.replace_range(..2, "ff");
        assert!(fixture.validate(BTreeSet::new()).is_err());
    }

    #[test]
    fn spendable_paths_derive_the_scanned_addresses_on_all_four_branches() {
        let wallet = wallet();
        // Nondefault coin type and account must survive the public scan too.
        let account = AccountPath::new(145, 3).unwrap();
        let scan = HdAccountScan::new(
            Network::Chipnet,
            wallet.account_xpub_at(account).unwrap(),
            account,
            HdSyncLimits {
                gap_limit: 2,
                addresses_per_branch: 2,
            },
            BTreeSet::new(),
        )
        .unwrap();
        let paths = spendable_paths(&scan.address_book());
        assert_eq!(paths.len(), 8);
        let expected = [0, 1, 7, 2]
            .into_iter()
            .flat_map(|branch| (0..2).map(move |index| (branch, index)));
        for ((address, path), (branch, index)) in paths.iter().zip(expected) {
            assert_eq!(path, &format!("m/44'/145'/3'/{branch}/{index}"));
            assert_eq!(
                wallet.address(Network::Chipnet, path).unwrap().encode(),
                *address,
                "advertised signing path must derive its scanned address"
            );
        }
    }

    fn coin(seed: u8, value: u64, path: &str, wallet: &Wallet) -> SpendableCoin {
        let address = wallet.address(Network::Chipnet, path).unwrap();
        SpendableCoin {
            utxo: Utxo {
                txid: [seed; 32],
                vout: 0,
                value,
                script_pubkey: address.script_pubkey(),
            },
            path: path.to_owned(),
        }
    }

    fn request(destination: &Wallet, amount: u64, held: BTreeSet<String>) -> SpendRequest {
        SpendRequest {
            destination_script: destination
                .address(Network::Chipnet, "m/44'/1'/0'/0/9")
                .unwrap()
                .script_pubkey(),
            amount_sats: amount,
            fee_per_byte: 1,
            change_script: destination
                .address(Network::Chipnet, "m/44'/1'/0'/1/0")
                .unwrap()
                .script_pubkey(),
            held,
        }
    }

    #[test]
    fn signs_a_spend_whose_inputs_and_change_add_up() {
        let wallet = wallet();
        let coins = vec![
            coin(1, 50_000, "m/44'/1'/0'/0/0", &wallet),
            coin(2, 30_000, "m/44'/1'/0'/0/1", &wallet),
        ];
        let prepared =
            prepare_spend(&wallet, &coins, &request(&wallet, 40_000, BTreeSet::new())).unwrap();

        assert_eq!(prepared.input_count, 1, "largest-first covers this alone");
        assert_eq!(prepared.inputs.len(), 1);
        // Value in equals value out plus fee, which is the only arithmetic a
        // spend must never get wrong.
        assert_eq!(50_000, 40_000 + prepared.change_sats + prepared.fee_sats);
        assert_eq!(prepared.txid.len(), 64);
        assert!(prepared.raw_hex.len() > 100);
        assert!(prepared.fee_sats > 0);
    }

    #[test]
    fn never_spends_a_held_coin_even_when_it_is_the_only_one_that_covers_the_amount() {
        // A hold may belong to a Flipstarter pledge or a running fusion round:
        // spending it double-spends that round's own inputs.
        let wallet = wallet();
        let coins = vec![
            coin(3, 100_000, "m/44'/1'/0'/0/0", &wallet),
            coin(4, 5_000, "m/44'/1'/0'/0/1", &wallet),
        ];
        let mut held = BTreeSet::new();
        held.insert(display_outpoint(&coins[0].utxo));

        let error = prepare_spend(&wallet, &coins, &request(&wallet, 40_000, held.clone()))
            .expect_err("the only coin large enough is held");
        assert!(format!("{error}").contains("not enough funds"), "{error}");

        // The same spend succeeds once the hold is lifted, so the refusal was
        // the hold rather than a broken selection.
        let prepared =
            prepare_spend(&wallet, &coins, &request(&wallet, 40_000, BTreeSet::new())).unwrap();
        assert_eq!(prepared.input_count, 1);
    }

    #[test]
    fn dust_change_is_paid_as_fee_rather_than_made_unrelayable() {
        let wallet = wallet();
        // Leave a few hundred satoshis after the fee: an output that small
        // cannot be relayed, so the transaction would be built and rejected.
        let coins = vec![coin(5, 10_000, "m/44'/1'/0'/0/0", &wallet)];
        let prepared = prepare_spend(
            &wallet,
            &coins,
            &request(&wallet, 10_000 - 192 - 300, BTreeSet::new()),
        )
        .unwrap();
        assert_eq!(prepared.change_sats, 0);
        assert!(prepared.fee_sats > 300);
        assert_eq!(10_000, prepared.fee_sats + (10_000 - 192 - 300));
    }

    #[test]
    fn refuses_a_spend_it_cannot_sign_rather_than_producing_a_broken_transaction() {
        let wallet = wallet();
        let mut coins = vec![coin(6, 50_000, "m/44'/1'/0'/0/0", &wallet)];
        coins[0].path = "not-a-path".into();
        assert!(
            prepare_spend(&wallet, &coins, &request(&wallet, 10_000, BTreeSet::new())).is_err()
        );

        assert!(prepare_spend(&wallet, &[], &request(&wallet, 10_000, BTreeSet::new())).is_err());
        assert!(prepare_spend(&wallet, &coins, &request(&wallet, 0, BTreeSet::new())).is_err());
    }
}
