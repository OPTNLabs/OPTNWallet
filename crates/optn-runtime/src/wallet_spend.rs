//! Build and sign an ordinary BCH spend from a synchronized HD account.
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

use optn_core::{
    error::{CliError, Result},
    hd::Wallet,
    tx::{self, Output, Transaction, Utxo},
    watch_only::HdAddressBook,
};
use std::collections::BTreeSet;

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
