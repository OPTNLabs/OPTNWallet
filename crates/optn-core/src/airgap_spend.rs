//! Build Chipnet PSBTs for an air-gapped signer: a single-coin BCH send from
//! an observed HD account, or a token spend planned by
//! [`crate::spend::prepare_token_spend`]. Either way every input carries its
//! complete parent transaction.
use crate::{
    cashaddr::{Address, AddressKind},
    coins::{Coin, Outpoint},
    error::{CliError, Result},
    hd::{hash160, AccountPath},
    network::Network,
    psbt::{self, KeyOrigin, P2pkhReview, PsbtInputSpec, PsbtOutputSpec},
    spend::{assert_coin_is_spendable, SpendKind, SpendPlan, TokenSpendPlan},
    tx,
    watch_only::{
        parse_account_xpub, HdAddressAllocation, HdAddressBook, HdBranch, HD_SCAN_BRANCHES,
    },
};
use bip32::ChildNumber;
use std::collections::BTreeMap;

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

/// The key that controls one wallet coin, and where it sits under the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoinKey {
    pub pubkey: [u8; 33],
    /// The HD branch: 0 receives, 1 is change.
    pub branch: u32,
    pub index: u32,
}

/// A token spend as the PSBT an air-gapped signer is shown, with the review of
/// those exact bytes the holder approves.
#[derive(Debug, Clone)]
pub struct PreparedTokenPsbt {
    pub psbt: Vec<u8>,
    pub review: P2pkhReview,
}

/// Turn a token spend plan into the PSBT an air-gapped signer is shown.
///
/// The plan was made from the wallet's coin list, which a server reports and
/// can get wrong; the transaction that created each coin cannot. So every
/// input is bound to its complete parent, matched by hash, and a parent whose
/// output disagrees with the plan about the coin's value, script or tokens
/// refuses the PSBT rather than being signed around. `keys` names the key and
/// path for each input's coin, and each key must control its coin's script.
///
/// The result is reviewed before it is returned, with the same
/// [`psbt::review_p2pkh`] the holder approves and the signed return is later
/// finalized against: it must say exactly what the plan says, and leave every
/// token unchanged. Chipnet only, like every air-gap PSBT.
pub fn prepare_token_psbt(
    plan: &TokenSpendPlan,
    parents: &[Vec<u8>],
    keys: &BTreeMap<Outpoint, CoinKey>,
    account: AccountPath,
    fingerprint: Option<&str>,
    network: Network,
) -> Result<PreparedTokenPsbt> {
    if network != Network::Chipnet {
        return Err(invalid(
            "CashToken sends through an air-gapped signer are Chipnet-only while that path is \
             being proven.",
        ));
    }
    let fingerprint = psbt::fingerprint_to_stamp(fingerprint)?;
    let by_txid: BTreeMap<[u8; 32], &[u8]> = parents
        .iter()
        .map(|parent| {
            let mut txid = tx::double_sha256(parent);
            txid.reverse();
            (txid, parent.as_slice())
        })
        .collect();
    let inputs = plan
        .inputs
        .iter()
        .map(|input| {
            let coin = input.outpoint;
            let parent = by_txid.get(&coin.txid()).ok_or_else(|| {
                invalid(format!(
                    "The parent transaction of coin {coin} was not supplied."
                ))
            })?;
            let created = tx::decode(parent)?;
            let output = usize::try_from(coin.vout())
                .ok()
                .and_then(|vout| created.outputs.get(vout))
                .ok_or_else(|| invalid(format!("Coin {coin}'s parent has no such output.")))?;
            let address = Address::decode(&input.address).map_err(invalid)?;
            if !matches!(address.kind, AddressKind::P2pkh | AddressKind::P2pkhToken) {
                return Err(invalid(format!(
                    "Coin {coin} is not a single-key coin an air-gapped signer can sign."
                )));
            }
            if output.value != input.sats || output.script_pubkey != address.script_pubkey() {
                return Err(invalid(format!(
                    "Coin {coin} disagrees with the transaction that created it. Refresh the \
                     wallet and build again."
                )));
            }
            if output.token != input.token {
                return Err(invalid(format!(
                    "Coin {coin} carries different tokens than the coin list reported. \
                     Refresh the wallet and build again; nothing was signed."
                )));
            }
            let key = keys
                .get(&coin)
                .ok_or_else(|| invalid(format!("No key is known for coin {coin}.")))?;
            if hash160(&key.pubkey) != address.hash {
                return Err(invalid(format!(
                    "The key given for coin {coin} does not control it."
                )));
            }
            Ok(PsbtInputSpec {
                txid_display: coin.txid(),
                vout: coin.vout(),
                sequence: None,
                satoshis: input.sats,
                locking_bytecode: output.script_pubkey.clone(),
                previous_transaction: Some(parent.to_vec()),
                redeem_script: None,
                partial_signatures: vec![],
                derivations: vec![KeyOrigin {
                    pubkey: key.pubkey,
                    fingerprint,
                    path: vec![
                        44 | 0x8000_0000,
                        account.coin_type() | 0x8000_0000,
                        account.account() | 0x8000_0000,
                        key.branch,
                        key.index,
                    ],
                }],
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let outputs = plan
        .outputs
        .iter()
        .map(|output| {
            Ok(PsbtOutputSpec {
                satoshis: output.sats,
                locking_bytecode: output.script_pubkey.clone(),
                token_prefix: output
                    .token
                    .as_ref()
                    .map(crate::token::TokenData::encode_prefix)
                    .transpose()?,
                ..Default::default()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let psbt = psbt::encode_unsigned(&inputs, &outputs, &[])?;
    psbt::check_watch_only(&psbt, network)?;
    let review = psbt::review_p2pkh(&psbt, network)?;
    let agrees = review.tokens_unchanged
        && review.fee_satoshis == plan.fee_sats
        && review.spent_outputs.len() == plan.inputs.len()
        && review
            .spent_outputs
            .iter()
            .zip(&plan.inputs)
            .all(|(spent, input)| spent.satoshis == input.sats && spent.token == input.token)
        && review.outputs.len() == plan.outputs.len()
        && review
            .outputs
            .iter()
            .zip(&plan.outputs)
            .all(|(paid, output)| {
                paid.satoshis == output.sats
                    && paid.locking_bytecode_hex == crate::coins::hex_encode(&output.script_pubkey)
                    && paid.token == output.token
            });
    if !agrees {
        return Err(CliError::Internal(
            "the PSBT does not say what the plan does; refusing to show it".into(),
        ));
    }
    Ok(PreparedTokenPsbt { psbt, review })
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

    mod tokens {
        use super::*;
        use crate::{
            fee::FeeRate,
            psbt::PartialSignature,
            spend::{prepare_token_spend, CoinChoice, Payment, TokenSpendRequest},
            token::{Capability, Nft, TokenData},
        };
        use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature};

        /// The published BIP39 vector's account, as SeedCash's harness uses
        /// it. Unfunded; these are offline templates and never broadcast.
        fn path(branch: u32, index: u32) -> String {
            format!("m/44'/145'/0'/{branch}/{index}")
        }

        fn wallet() -> &'static Wallet {
            static WALLET: std::sync::OnceLock<Wallet> = std::sync::OnceLock::new();
            WALLET.get_or_init(|| Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap())
        }

        fn address(branch: u32, index: u32) -> Address {
            wallet()
                .address(Network::Chipnet, &path(branch, index))
                .unwrap()
        }

        fn key(branch: u32, index: u32) -> CoinKey {
            CoinKey {
                pubkey: wallet().public_key(&path(branch, index)).unwrap(),
                branch,
                index,
            }
        }

        const A: [u8; 32] = [0xa1; 32];

        struct Fixture {
            parent: Vec<u8>,
            coins: CoinSet,
            keys: BTreeMap<Outpoint, CoinKey>,
        }

        /// One parent paying the wallet a fungible-token coin, an NFT coin
        /// that also holds fungible tokens, and a BCH coin.
        fn fixture() -> Fixture {
            let held = [
                (0, Some(TokenData::fungible(A, 300)), 1_000),
                (
                    1,
                    Some(TokenData {
                        category: A,
                        amount: 40,
                        nft: Some(Nft {
                            capability: Capability::Mutable,
                            commitment: vec![0xc0, 0xde],
                        }),
                    }),
                    800,
                ),
                (2, None, 20_000),
            ];
            let outputs = held
                .iter()
                .map(|(index, token, sats)| {
                    let script = address(0, *index).script_pubkey();
                    match token {
                        Some(token) => {
                            tx::Output::with_tokens(*sats, script, token.encode_prefix().unwrap())
                        }
                        None => tx::Output::new(*sats, script),
                    }
                })
                .collect();
            let funding = tx::Utxo {
                txid: [0x5a; 32],
                vout: 0,
                value: 0,
                script_pubkey: Vec::new(),
            };
            let parent = tx::Transaction::new(vec![funding], outputs)
                .serialize_with_sequences(&[Vec::new()], &[u32::MAX])
                .unwrap();
            let mut txid = tx::double_sha256(&parent);
            txid.reverse();
            let mut coins = CoinSet::new();
            let mut keys = BTreeMap::new();
            for (index, token, sats) in held {
                let outpoint = Outpoint::new(txid, index);
                coins
                    .insert(
                        Coin::from_observation(outpoint, sats, address(0, index).encode(), token)
                            .unwrap(),
                    )
                    .unwrap();
                keys.insert(outpoint, key(0, index));
            }
            Fixture {
                parent,
                coins,
                keys,
            }
        }

        fn request(payment: Payment) -> TokenSpendRequest {
            TokenSpendRequest {
                destination: Address {
                    kind: AddressKind::P2pkhToken,
                    ..address(0, 9)
                }
                .encode(),
                payment,
                coins: CoinChoice::Automatic,
                change: address(1, 0).encode(),
            }
        }

        fn prepared(
            fixture: &Fixture,
            plan: &TokenSpendPlan,
            network: Network,
        ) -> Result<PreparedTokenPsbt> {
            prepare_token_psbt(
                plan,
                std::slice::from_ref(&fixture.parent),
                &fixture.keys,
                AccountPath::new(145, 0).unwrap(),
                Some("73c5da0a"),
                network,
            )
        }

        #[test]
        fn a_token_psbt_says_what_the_plan_says_and_finalizes_to_the_same_transaction() {
            let fixture = fixture();
            for payment in [
                Payment::Fungible {
                    category: A,
                    amount: 120,
                },
                Payment::AllFungible { category: A },
                Payment::Nft {
                    outpoint: Outpoint::new(
                        fixture.coins.iter().nth(1).unwrap().outpoint().txid(),
                        1,
                    ),
                },
            ] {
                let plan = prepare_token_spend(
                    &fixture.coins,
                    Network::Chipnet,
                    &request(payment.clone()),
                    FeeRate::from_satoshis_per_kb(1_100),
                )
                .unwrap();
                let prepared = prepared(&fixture, &plan, Network::Chipnet).unwrap();
                let review = &prepared.review;
                assert!(review.tokens_unchanged, "{payment:?}");
                assert_eq!(review.fee_satoshis, plan.fee_sats);
                assert!(review
                    .categories
                    .iter()
                    .all(|category| category.burned_fungible == "0"));
                let parsed = psbt::check_watch_only(&prepared.psbt, Network::Chipnet).unwrap();
                for (input, planned) in parsed.inputs.iter().zip(&plan.inputs) {
                    let key = fixture.keys[&planned.outpoint];
                    assert_eq!(input.origins[0].pubkey, key.pubkey);
                    assert_eq!(
                        input.origins[0].path,
                        [0x8000_002c, 0x8000_0091, 0x8000_0000, 0, key.index]
                    );
                    assert_eq!(input.origins[0].fingerprint, [0x73, 0xc5, 0xda, 0x0a]);
                }

                // Sign as a device would: over each input's token-aware
                // preimage, returned as partial signatures in an otherwise
                // identical PSBT. The finalizer must accept it and assemble
                // exactly what seed signing of the same plan produces.
                let transaction = tx::Transaction::new(
                    plan.inputs
                        .iter()
                        .map(|input| {
                            let mut txid = input.outpoint.txid();
                            txid.reverse();
                            tx::Utxo {
                                txid,
                                vout: input.outpoint.vout(),
                                value: input.sats,
                                script_pubkey: Address::decode(&input.address)
                                    .unwrap()
                                    .script_pubkey(),
                            }
                        })
                        .collect(),
                    plan.transaction_outputs().unwrap(),
                );
                let signing_keys: Vec<_> = plan
                    .inputs
                    .iter()
                    .map(|input| {
                        let key = fixture.keys[&input.outpoint];
                        wallet().signing_key(&path(key.branch, key.index)).unwrap()
                    })
                    .collect();
                let sequences = vec![u32::MAX; plan.inputs.len()];
                let mut signed_inputs = Vec::new();
                for (index, input) in plan.inputs.iter().enumerate() {
                    let prefix = input
                        .token
                        .as_ref()
                        .map(|token| token.encode_prefix().unwrap())
                        .unwrap_or_default();
                    let digest = tx::double_sha256(
                        &transaction
                            .sighash_preimage_with_token(index, &sequences, &prefix)
                            .unwrap(),
                    );
                    let signature: Signature = signing_keys[index].sign_prehash(&digest).unwrap();
                    let mut der = signature
                        .normalize_s()
                        .unwrap_or(signature)
                        .to_der()
                        .as_bytes()
                        .to_vec();
                    der.push(0x41);
                    let key = fixture.keys[&input.outpoint];
                    signed_inputs.push(PsbtInputSpec {
                        txid_display: input.outpoint.txid(),
                        vout: input.outpoint.vout(),
                        sequence: None,
                        satoshis: input.sats,
                        locking_bytecode: transaction.inputs[index].script_pubkey.clone(),
                        previous_transaction: Some(fixture.parent.clone()),
                        redeem_script: None,
                        partial_signatures: vec![PartialSignature {
                            pubkey: key.pubkey,
                            signature: der,
                        }],
                        derivations: vec![KeyOrigin {
                            pubkey: key.pubkey,
                            fingerprint: [0x73, 0xc5, 0xda, 0x0a],
                            path: vec![0x8000_002c, 0x8000_0091, 0x8000_0000, 0, key.index],
                        }],
                    });
                }
                let signed_outputs: Vec<_> = plan
                    .outputs
                    .iter()
                    .map(|output| PsbtOutputSpec {
                        satoshis: output.sats,
                        locking_bytecode: output.script_pubkey.clone(),
                        token_prefix: output
                            .token
                            .as_ref()
                            .map(|token| token.encode_prefix().unwrap()),
                        ..Default::default()
                    })
                    .collect();
                let signed = psbt::encode_unsigned(&signed_inputs, &signed_outputs, &[]).unwrap();
                let raw =
                    psbt::finalize_cash_tokens_p2pkh(&prepared.psbt, &signed, Network::Chipnet)
                        .unwrap();
                assert_eq!(
                    raw,
                    transaction
                        .sign_spending_tokens(&signing_keys, &plan.spent_tokens())
                        .unwrap(),
                    "{payment:?}"
                );
                let decoded = tx::decode(&raw).unwrap();
                let tokens: Vec<_> = decoded.outputs.iter().map(|o| o.token.clone()).collect();
                let planned: Vec<_> = plan.outputs.iter().map(|o| o.token.clone()).collect();
                assert_eq!(tokens, planned);
            }
        }

        #[test]
        fn the_parent_not_the_coin_list_decides_what_a_coin_carries() {
            let fixture = fixture();
            let plan = prepare_token_spend(
                &fixture.coins,
                Network::Chipnet,
                &request(Payment::Fungible {
                    category: A,
                    amount: 10,
                }),
                FeeRate::from_satoshis_per_kb(1_000),
            )
            .unwrap();
            assert!(prepared(&fixture, &plan, Network::Chipnet).is_ok());

            // A server that dropped the token from its coin list: the plan
            // treats the coin as plain BCH, and the parent refuses it.
            let mut stripped = plan.clone();
            stripped.inputs[0].token = None;
            let error = prepared(&fixture, &stripped, Network::Chipnet).unwrap_err();
            assert!(error.to_string().contains("different tokens"), "{error}");

            let mut richer = plan.clone();
            richer.inputs[0].sats += 1;
            assert!(prepared(&fixture, &richer, Network::Chipnet).is_err());

            let missing = prepare_token_psbt(
                &plan,
                &[],
                &fixture.keys,
                AccountPath::new(145, 0).unwrap(),
                None,
                Network::Chipnet,
            )
            .unwrap_err();
            assert!(missing.to_string().contains("not supplied"), "{missing}");

            let mut wrong_key = Fixture {
                parent: fixture.parent.clone(),
                coins: fixture.coins.clone(),
                keys: fixture.keys.clone(),
            };
            let stranger = key(0, 7).pubkey;
            for coin_key in wrong_key.keys.values_mut() {
                coin_key.pubkey = stranger;
            }
            assert!(prepared(&wrong_key, &plan, Network::Chipnet).is_err());
            wrong_key.keys.clear();
            assert!(prepared(&wrong_key, &plan, Network::Chipnet).is_err());

            assert!(prepared(&fixture, &plan, Network::Mainnet).is_err());
        }
    }

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
