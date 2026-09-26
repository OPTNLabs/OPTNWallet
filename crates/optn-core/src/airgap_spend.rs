//! Build a single-coin Chipnet PSBT from an observed HD account and its parent transaction.
use crate::{
    cashaddr::Address,
    coins::Coin,
    error::{CliError, Result},
    hd::hash160,
    network::Network,
    psbt::{self, KeyOrigin, PsbtInputSpec, PsbtOutputSpec},
    spend::{assert_coin_is_spendable, SpendKind, SpendPlan},
    watch_only::{
        parse_account_xpub, HdAddressAllocation, HdAddressBook, HdBranch, HD_SCAN_BRANCHES,
    },
};
use bip32::ChildNumber;

#[derive(Debug, Clone)]
pub struct PreparedWatchOnlySpend {
    pub psbt: Vec<u8>,
    pub fee_sats: u64,
    pub change_address: Option<String>,
    pub change_sats: u64,
    /// The host must commit this allocation before exposing the PSBT.
    pub allocation: HdAddressAllocation,
}

fn invalid(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

/// The parent is mandatory: the signer must independently recover the input's value and script.
/// This first connected path uses the existing single-coin plan and ALL|FORKID policy.
pub fn prepare(
    plan: &SpendPlan,
    coin: &Coin,
    book: &HdAddressBook,
    fingerprint: Option<&str>,
    allocation: &HdAddressAllocation,
    previous_transaction: &[u8],
    network: Network,
) -> Result<PreparedWatchOnlySpend> {
    if network != Network::Chipnet || plan.kind != SpendKind::WatchOnlyUnsignedPsbt {
        return Err(invalid(
            "Air-gap sends require a Chipnet watch-only HD account.",
        ));
    }
    assert_coin_is_spendable(coin).map_err(|error| invalid(error.to_string()))?;
    if plan.selected != coin.outpoint() || u32::from(plan.sighash) != psbt::WATCH_ONLY_SIGHASH {
        return Err(invalid("The selected coin or signing policy changed."));
    }
    let destination = Address::decode(&plan.destination).map_err(invalid)?;
    if destination.prefix != network.prefix() || plan.amount_sats < 546 {
        return Err(invalid(
            "Enter a Chipnet destination and at least 546 satoshis.",
        ));
    }
    let mut parent_id = crate::tx::double_sha256(previous_transaction);
    parent_id.reverse();
    let (_, outputs) = crate::rpa::parse_transaction(previous_transaction)?;
    let (value, script) = outputs
        .get(coin.outpoint().vout() as usize)
        .ok_or_else(|| invalid("The parent transaction has no selected output."))?;
    if parent_id != coin.outpoint().txid() || *value != coin.value_sats() {
        return Err(invalid(
            "The selected coin disagrees with its parent transaction.",
        ));
    }
    let owner = book
        .branches
        .iter()
        .enumerate()
        .find_map(|(slot, addresses)| {
            addresses.iter().enumerate().find_map(|(index, address)| {
                Address::decode(&address.address)
                    .ok()
                    .filter(|address| address.script_pubkey() == *script)
                    .map(|_| (HD_SCAN_BRANCHES[slot], index as u32))
            })
        })
        .ok_or_else(|| invalid("The selected output is outside the synced HD account."))?;
    let xpub = parse_account_xpub(&book.account_xpub)?;
    if u32::from(xpub.attrs().child_number) & 0x7fff_ffff != book.account.account() {
        return Err(invalid("The account key and its origin disagree."));
    }
    let fingerprint = psbt::fingerprint_to_stamp(fingerprint)?;
    let origin = |branch, index| -> Result<KeyOrigin> {
        let key = xpub
            .derive_child(ChildNumber::new(branch, false).map_err(|e| invalid(e.to_string()))?)
            .and_then(|key| key.derive_child(ChildNumber::new(index, false)?))
            .map_err(|e| invalid(e.to_string()))?;
        Ok(KeyOrigin {
            pubkey: key.to_bytes(),
            fingerprint,
            path: vec![
                44 | 0x8000_0000,
                book.account.coin_type() | 0x8000_0000,
                book.account.account() | 0x8000_0000,
                branch,
                index,
            ],
        })
    };
    let input_origin = origin(owner.0, owner.1)?;
    let own_address = |key: &KeyOrigin| {
        Address::from_hash(
            network.prefix(),
            crate::cashaddr::AddressKind::P2pkh,
            hash160(&key.pubkey),
        )
    };
    if own_address(&input_origin).script_pubkey() != *script {
        return Err(invalid("The account key does not own the selected output."));
    }
    let two_output_fee = plan.fee_for_serialized_bytes(crate::tx::estimate_size(1, 2)? as u64);
    let needed = plan
        .amount_sats
        .checked_add(two_output_fee)
        .ok_or_else(|| invalid("Send amount and fee overflow."))?;
    let mut allocation = allocation.clone();
    let mut outputs = vec![PsbtOutputSpec {
        satoshis: plan.amount_sats,
        locking_bytecode: destination.script_pubkey(),
        ..Default::default()
    }];
    let (fee_sats, change_address, change_sats) = match coin.value_sats().checked_sub(needed) {
        Some(change) if change >= 546 => {
            let index =
                allocation.allocate(HdBranch::Change, book.allocation_last_used(), false)?;
            // Reserve only inside the freshly scanned horizon. The next refresh expands it.
            if index as usize >= book.branches[HdBranch::Change.slot()].len() {
                return Err(invalid(
                    "Refresh the HD account before reserving another change address.",
                ));
            }
            let change_origin = origin(HdBranch::Change.index(), index)?;
            let address = own_address(&change_origin);
            outputs.push(PsbtOutputSpec {
                satoshis: change,
                locking_bytecode: address.script_pubkey(),
                derivations: vec![change_origin],
                ..Default::default()
            });
            (two_output_fee, Some(address.encode()), change)
        }
        _ => {
            let remainder = coin
                .value_sats()
                .checked_sub(plan.amount_sats)
                .ok_or_else(|| invalid("The selected coin cannot cover this send."))?;
            let minimum = plan.fee_for_serialized_bytes(crate::tx::estimate_size(1, 1)? as u64);
            if remainder < minimum {
                return Err(invalid(
                    "The selected coin cannot cover the amount and fee.",
                ));
            }
            (remainder, None, 0)
        }
    };
    let psbt = psbt::encode_unsigned(
        &[PsbtInputSpec {
            txid_display: coin.outpoint().txid(),
            vout: coin.outpoint().vout(),
            sequence: None,
            satoshis: coin.value_sats(),
            locking_bytecode: script.clone(),
            previous_transaction: Some(previous_transaction.to_vec()),
            redeem_script: None,
            partial_signatures: vec![],
            derivations: vec![input_origin],
        }],
        &outputs,
        &[],
    )?;
    psbt::check_watch_only(&psbt, network)?;
    Ok(PreparedWatchOnlySpend {
        psbt,
        fee_sats,
        change_address,
        change_sats,
        allocation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coins::{CoinSet, FreezeReason, Outpoint},
        hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        spend::SpendingCapability,
        watch_only::address_under_account,
    };

    #[test]
    fn hd_export_binds_parent_origin_fee_and_reserved_change() {
        let network = Network::Chipnet;
        // SeedCash's BCH account origin is valid on Chipnet too; do not relabel it as coin type 1.
        let account = AccountPath::new(145, 0).unwrap();
        let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap();
        let xpub = wallet.account_xpub_at(account).unwrap();
        let book = HdAddressBook {
            account,
            account_xpub: xpub.clone(),
            last_used: [Some(0), None, None, None],
            branches: std::array::from_fn(|slot| {
                (0..3)
                    .map(|index| {
                        address_under_account(network, &xpub, HD_SCAN_BRANCHES[slot], index)
                            .unwrap()
                    })
                    .collect()
            }),
        };
        let address = &book.branches[0][0].address;
        let script = Address::decode(address).unwrap().script_pubkey();
        let parent =
            crate::tx::Transaction::new(vec![], vec![crate::tx::Output::new(20_000, script)])
                .sign(&[])
                .unwrap();
        let mut txid = crate::tx::double_sha256(&parent);
        txid.reverse();
        let coin = Coin::new(Outpoint::new(txid, 0), 20_000, address).unwrap();
        let mut coins = CoinSet::default();
        coins.insert(coin.clone()).unwrap();
        let plan = crate::spend::prepare_spend(
            &coins,
            network,
            address,
            10_000,
            SpendingCapability::WatchOnly,
        )
        .unwrap();
        let allocation = HdAddressAllocation::default();
        let prepared = prepare(
            &plan,
            &coin,
            &book,
            Some("73c5da0a"),
            &allocation,
            &parent,
            network,
        )
        .unwrap();
        assert_eq!(
            allocation.next_indexes(),
            [0, 0, 0],
            "pure preparation cannot reserve an address by itself"
        );
        assert_eq!(prepared.allocation.next_indexes(), [1, 1, 0]);
        assert_eq!(
            prepared.change_address.as_deref(),
            Some(book.branches[1][0].address.as_str())
        );
        assert_eq!(
            prepared.fee_sats + prepared.change_sats + plan.amount_sats,
            coin.value_sats()
        );
        let parsed = psbt::check_watch_only(&prepared.psbt, network).unwrap();
        assert_eq!(
            parsed.inputs[0].origins[0].path,
            vec![44 | 0x8000_0000, 145 | 0x8000_0000, 0x8000_0000, 0, 0]
        );
        let second = prepare(
            &plan,
            &coin,
            &book,
            None,
            &prepared.allocation,
            &parent,
            network,
        )
        .unwrap();
        assert_ne!(second.change_address, prepared.change_address);
        assert_eq!(second.allocation.next_indexes()[1], 2);
        assert!(prepare(
            &plan,
            &coin,
            &book,
            None,
            &allocation,
            &parent,
            Network::Mainnet
        )
        .is_err());
        let mut tampered = parent.clone();
        tampered[0] ^= 1;
        assert!(prepare(&plan, &coin, &book, None, &allocation, &tampered, network).is_err());
        let mut frozen = coin.clone();
        frozen.restore_freeze(Some(FreezeReason::User));
        assert!(prepare(&plan, &frozen, &book, None, &allocation, &parent, network).is_err());
        let mut insufficient = plan.clone();
        insufficient.amount_sats = 20_000;
        assert!(prepare(
            &insufficient,
            &coin,
            &book,
            None,
            &allocation,
            &parent,
            network
        )
        .is_err());
        insufficient.amount_sats = 545;
        assert!(prepare(
            &insufficient,
            &coin,
            &book,
            None,
            &allocation,
            &parent,
            network
        )
        .is_err());
    }
}
