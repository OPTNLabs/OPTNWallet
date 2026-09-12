//! Session-bound unsigned export and verified signed import. No signing keys or broadcasts.
use crate::{AppRuntime, AppRuntimeDriver, PublicationGuard, RuntimeRequest};
use optn_app::{AppAction, AppEvent, AppState, OpenedWallet, SpendPlan, WalletKind};
use optn_core::{airgap_spend, coins::Outpoint, psbt};
use optn_transport::{AirgapRequest, AirgapResponse, TransportError};
use std::sync::atomic::Ordering;
use tokio::sync::oneshot;

fn failure(message: impl ToString) -> TransportError {
    TransportError::Other(message.to_string())
}

#[derive(Default)]
pub(super) struct AirgapSession {
    next_id: u64,
    pending: Option<Pending>,
}

struct Pending {
    wallet: OpenedWallet,
    epoch: u64,
    generation: u64,
    plan: SpendPlan,
    psbt: Vec<u8>,
    response: AirgapResponse,
}

impl Pending {
    fn matches(&self, state: &AppState, generation: u64) -> bool {
        self.generation == generation
            && self.epoch == state.lock.unlock_epoch
            && state.wallet.as_ref() == Some(&self.wallet)
            && state.spend.as_ref() == Some(&self.plan)
            && state.network == optn_app::Network::Chipnet
            && state
                .coins
                .get(self.plan.selected)
                .is_some_and(|coin| optn_core::spend::assert_coin_is_spendable(coin).is_ok())
    }
}

impl AirgapSession {
    pub(super) fn reconcile(&mut self, state: &AppState, generation: u64, fresh: bool) {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| !fresh || !pending.matches(state, generation))
        {
            self.pending = None;
        }
    }
}

impl AppRuntime {
    pub async fn airgap(&self, request: AirgapRequest) -> Result<AirgapResponse, TransportError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::Airgap(
                request,
                self.revocation.load(Ordering::SeqCst),
                reply,
            ))
            .await
            .map_err(|_| TransportError::Closed)?;
        received.await.map_err(|_| TransportError::Closed)?
    }
}

impl AppRuntimeDriver {
    pub(super) fn handle_airgap(
        &mut self,
        request: AirgapRequest,
        generation: u64,
        reply: oneshot::Sender<Result<AirgapResponse, TransportError>>,
    ) {
        if reply.is_closed() {
            return;
        }
        let outcome = self.apply_airgap(request, generation, &reply);
        self.expire_session();
        let _ = reply.send(outcome);
    }

    fn apply_airgap(
        &mut self,
        request: AirgapRequest,
        generation: u64,
        reply: &oneshot::Sender<Result<AirgapResponse, TransportError>>,
    ) -> Result<AirgapResponse, TransportError> {
        if matches!(request, AirgapRequest::Cancel) {
            self.airgap.pending = None;
            self.state.spend = None;
            self.publish(AppEvent::NoticeChanged);
            return Ok(AirgapResponse::default());
        }
        self.airgap.reconcile(
            &self.state,
            self.revocation.load(Ordering::SeqCst),
            self.wallet_sync.coins_are_fresh(),
        );
        let guard = PublicationGuard {
            generation,
            revocation: &self.revocation,
            now_ms: &|| crate::elapsed_ms(self.started),
        };
        if !guard.allows(&self.state, reply.is_closed()) {
            return Err(failure(
                "The wallet operation was cancelled. Prepare the transaction again.",
            ));
        }
        let security = self.security.as_ref().ok_or(TransportError::Unsupported)?;
        security.require_durable_session(&self.state)?;
        if !self.wallet_sync.coins_are_fresh() {
            return Err(failure(
                "Refresh the wallet before exporting or finalizing a transaction.",
            ));
        }
        match request {
            AirgapRequest::Prepare {
                destination,
                amount_sats,
                coin,
            } => {
                // A failed replacement cannot leave the previous approval available.
                self.airgap.pending = None;
                let mut candidate = self.state.clone();
                let wallet = candidate
                    .wallet
                    .as_ref()
                    .ok_or(TransportError::AuthenticationRequired)?;
                if wallet.kind != WalletKind::WatchOnly || wallet.multisig_policy.is_some() {
                    return Err(failure(
                        "Select a single-signature watch-only HD account for air-gap signing.",
                    ));
                }
                let coin = coin
                    .as_deref()
                    .map(|text| {
                        let (txid, index) = text
                            .rsplit_once(':')
                            .ok_or_else(|| failure("Invalid selected outpoint."))?;
                        Outpoint::parse(
                            txid,
                            index
                                .parse()
                                .map_err(|_| failure("Invalid output index."))?,
                        )
                        .map_err(failure)
                    })
                    .transpose()?;
                if candidate.reduce_intent(AppAction::PrepareSend {
                    destination,
                    amount_sats,
                    coin,
                }) != Some(AppEvent::SpendPrepared)
                {
                    return Err(failure(
                        candidate
                            .notice
                            .as_deref()
                            .unwrap_or("Could not prepare the send."),
                    ));
                }
                let plan = candidate
                    .spend
                    .as_ref()
                    .ok_or_else(|| failure("Missing spend plan."))?;
                let wallet = candidate
                    .wallet
                    .as_ref()
                    .ok_or(TransportError::AuthenticationRequired)?;
                let snapshot = self
                    .wallet_sync
                    .reconciliation()
                    .authoritative
                    .as_ref()
                    .ok_or_else(|| failure("Refresh the HD wallet first."))?;
                let book = snapshot
                    .value
                    .hd
                    .as_ref()
                    .ok_or_else(|| failure("Sync an HD account first."))?;
                if wallet.account_xpub.as_ref() != Some(&book.account_xpub)
                    || wallet.account_path != book.account.to_string()
                {
                    return Err(failure("The wallet and synced account differ."));
                }
                let parent = snapshot
                    .value
                    .transactions
                    .iter()
                    .find(|tx| {
                        let mut display = tx.txid;
                        display.reverse();
                        display == plan.selected.txid()
                    })
                    .ok_or_else(|| {
                        failure("The selected coin's parent transaction is unavailable.")
                    })?;
                let coin = candidate
                    .coins
                    .get(plan.selected)
                    .ok_or_else(|| failure("The selected coin is no longer available."))?;
                let prepared = airgap_spend::prepare(
                    plan,
                    coin,
                    book,
                    wallet.master_fingerprint.as_deref(),
                    candidate
                        .hd_addresses
                        .as_ref()
                        .ok_or_else(|| failure("Reopen the wallet to restore HD allocation."))?,
                    &parent.raw,
                    candidate.network,
                )
                .map_err(failure)?;
                let id = self
                    .airgap
                    .next_id
                    .checked_add(1)
                    .ok_or_else(|| failure("Reopen the wallet before another send."))?;
                candidate.hd_addresses = Some(prepared.allocation);
                let security = self.security.as_mut().ok_or(TransportError::Unsupported)?;
                let event = self.wallet_sync.persist_annotation(
                    &mut candidate,
                    self.state.clone(),
                    |app, sync| security.persist_checkpoint(app, sync),
                    |app| guard.allows(app, reply.is_closed()),
                );
                self.state = candidate;
                if event != AppEvent::CoinsChanged {
                    self.publish(event);
                    return Err(failure(
                        "The change reservation was not published. Reopen and refresh the wallet.",
                    ));
                }
                security.checkpoint_published();
                self.airgap.next_id = id;
                let response = AirgapResponse {
                    request_id: id,
                    psbt_hex: encode_hex(&prepared.psbt),
                    fee_sats: prepared.fee_sats,
                    change_address: prepared.change_address,
                    change_sats: prepared.change_sats,
                    raw_transaction_hex: None,
                    txid: None,
                };
                self.airgap.pending = Some(Pending {
                    wallet: self.state.wallet.clone().unwrap(),
                    epoch: self.state.lock.unlock_epoch,
                    generation,
                    plan: self.state.spend.clone().unwrap(),
                    psbt: prepared.psbt,
                    response: response.clone(),
                });
                self.publish(AppEvent::SpendPrepared);
                Ok(response)
            }
            AirgapRequest::Finalize {
                request_id,
                signed_psbt_hex,
            } => {
                let pending = self
                    .airgap
                    .pending
                    .as_ref()
                    .filter(|pending| pending.response.request_id == request_id)
                    .ok_or_else(|| {
                        failure("This signing request expired. Prepare the transaction again.")
                    })?;
                let signed = decode_hex(&signed_psbt_hex)?;
                let raw = psbt::finalize_p2pkh(&pending.psbt, &signed, self.state.network)
                    .map_err(failure)?;
                if pending.plan.fee_for_serialized_bytes(raw.len() as u64)
                    > pending.response.fee_sats
                {
                    return Err(failure(
                        "The signed transaction does not meet the approved fee rate.",
                    ));
                }
                // A blocking storage check or signature verification may cross revocation/idle.
                self.security
                    .as_ref()
                    .ok_or(TransportError::Unsupported)?
                    .require_durable_session(&self.state)?;
                if !guard.allows(&self.state, reply.is_closed()) {
                    return Err(failure("Signing request cancelled before publication."));
                }
                let mut response = pending.response.clone();
                response.raw_transaction_hex = Some(encode_hex(&raw));
                let mut txid = optn_core::tx::double_sha256(&raw);
                txid.reverse();
                response.txid = Some(encode_hex(&txid));
                Ok(response)
            }
            AirgapRequest::Cancel => unreachable!(),
        }
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(text: &str) -> Result<Vec<u8>, TransportError> {
    let text = text.trim();
    if text.is_empty()
        || text.len() > 2 * 1024 * 1024
        || !text.len().is_multiple_of(2)
        || !text.is_ascii()
    {
        return Err(failure("Signed PSBT must be bounded hexadecimal bytes."));
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| failure("Invalid signed PSBT hex."))?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| failure("Invalid signed PSBT hex."))?;
            Ok((high * 16 + low) as u8)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chain::{Evidence, SourceId},
        chain_service::ObservedTransaction,
        hd_sync::HdSyncLimits,
        reconciliation::ReconciliationDecision,
        sync_worker::WalletNetworkSnapshot,
        wallet_checkpoint::{WalletCheckpoint, WalletCheckpointStorage},
        wallet_security::{tests::Storage, WalletSecurity},
        wallet_sync::{WalletReconciliation, WalletSyncRequest},
        DirectTransport,
    };
    use optn_core::{
        cashaddr::Address,
        hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        network::Network,
    };
    use optn_transport::{AppTransport, WalletSecurityRequest};
    use std::sync::{atomic::AtomicBool, Arc, Mutex};

    type StoredCheckpoint = Option<(WalletCheckpoint, [u8; 32])>;

    #[derive(Default, Clone)]
    struct Checkpoints {
        saved: Arc<Mutex<StoredCheckpoint>>,
        fail: Arc<AtomicBool>,
    }
    impl WalletCheckpointStorage for Checkpoints {
        fn load(
            &self,
            _: &[u8; 32],
            _: &optn_core::wallet_pack::PackKey,
        ) -> Result<Option<(WalletCheckpoint, [u8; 32])>, String> {
            Ok(self.saved.lock().unwrap().clone())
        }
        fn store(
            &self,
            _: &[u8; 32],
            value: &WalletCheckpoint,
            _: &optn_core::wallet_pack::PackKey,
            expected: Option<[u8; 32]>,
        ) -> Result<[u8; 32], String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("test storage failure".into());
            }
            let mut saved = self.saved.lock().unwrap();
            if saved.as_ref().map(|(_, revision)| *revision) != expected {
                return Err("stale revision".into());
            }
            let revision =
                optn_core::tx::double_sha256(format!("{:?}", value.allocation).as_bytes());
            *saved = Some((value.clone(), revision));
            Ok(revision)
        }
    }

    fn fixture_parent(state: &AppState) -> Vec<u8> {
        // Reserving change also advances the displayed receive address past
        // observed history. This fixed parent always pays receive index zero.
        let address = optn_core::watch_only::address_under_account(
            Network::Chipnet,
            state
                .wallet
                .as_ref()
                .unwrap()
                .account_xpub
                .as_ref()
                .unwrap(),
            0,
            0,
        )
        .unwrap();
        let script = Address::decode(&address.address).unwrap().script_pubkey();
        optn_core::tx::Transaction::new(vec![], vec![optn_core::tx::Output::new(20_000, script)])
            .sign(&[])
            .unwrap()
    }

    // This signer exists only in the test: the runtime itself holds the public
    // account. Rebuild our known fixture with public codecs, and prove exact
    // byte equality before adding signatures so metadata cannot drift unnoticed.
    fn sign_fixture(state: &AppState, response: &AirgapResponse) -> (String, String) {
        use optn_core::{
            psbt::{PartialSignature, PsbtInputSpec, PsbtOutputSpec},
            tx::{self, Output, Transaction, Utxo},
        };

        let original = decode_hex(&response.psbt_hex).unwrap();
        let parsed = psbt::parse(&original).unwrap();
        let unsigned = tx::decode(&parsed.unsigned_tx).unwrap();
        assert_eq!(unsigned.inputs.len(), 1);
        assert_eq!(unsigned.outputs.len(), 2);
        let (txid, vout, sequence) = unsigned.inputs[0];
        let parent = fixture_parent(state);
        assert_eq!(txid, tx::double_sha256(&parent));
        assert_eq!(vout, 0);
        let prevout = tx::decode(&parent).unwrap().outputs.remove(0);
        let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap();
        let account =
            optn_core::hd::parse_account_path(&state.wallet.as_ref().unwrap().account_path)
                .unwrap();
        let input_origin = parsed.inputs[0].origins[0].clone();
        assert_eq!(
            input_origin.pubkey,
            wallet.public_key(&account.address_path(false, 0)).unwrap()
        );
        let change_index = state.hd_addresses.as_ref().unwrap().next_indexes()[1] - 1;
        let mut change_origin = input_origin.clone();
        change_origin.pubkey = wallet
            .public_key(&account.address_path(true, change_index))
            .unwrap();
        change_origin.path[3] = 1;
        change_origin.path[4] = change_index;
        assert_eq!(
            unsigned.outputs[1].script_pubkey,
            Address::decode(response.change_address.as_ref().unwrap())
                .unwrap()
                .script_pubkey()
        );
        let outputs: Vec<_> = unsigned
            .outputs
            .iter()
            .enumerate()
            .map(|(index, output)| {
                assert!(output.token.is_none());
                PsbtOutputSpec {
                    satoshis: output.value,
                    locking_bytecode: output.script_pubkey.clone(),
                    derivations: if index == 1 {
                        vec![change_origin.clone()]
                    } else {
                        vec![]
                    },
                    ..Default::default()
                }
            })
            .collect();
        let mut display_txid = txid;
        display_txid.reverse();
        let mut input = PsbtInputSpec {
            txid_display: display_txid,
            vout,
            sequence: Some(sequence),
            satoshis: prevout.value,
            locking_bytecode: prevout.script_pubkey.clone(),
            previous_transaction: Some(parent),
            redeem_script: None,
            partial_signatures: vec![],
            derivations: vec![input_origin.clone()],
        };
        assert_eq!(
            psbt::encode_unsigned(std::slice::from_ref(&input), &outputs, &[]).unwrap(),
            original
        );
        let transaction = Transaction {
            version: unsigned.version,
            inputs: vec![Utxo {
                txid,
                vout,
                value: prevout.value,
                script_pubkey: prevout.script_pubkey,
            }],
            outputs: unsigned
                .outputs
                .into_iter()
                .map(|output| Output::new(output.value, output.script_pubkey))
                .collect(),
            locktime: unsigned.locktime,
            sequence,
        };
        let key = wallet.signing_key(&account.address_path(false, 0)).unwrap();
        let (raw, scripts) = transaction.sign_detailed(&[key]).unwrap();
        // sign_detailed emits two minimal pushes; extract its signature, not
        // an untrusted script supplied by a signer or a second PSBT parser.
        let signature_len = usize::from(scripts[0][0]);
        assert!(signature_len <= 75);
        assert_eq!(scripts[0][signature_len + 1], 33);
        assert_eq!(scripts[0][signature_len + 2..], input_origin.pubkey);
        input.partial_signatures.push(PartialSignature {
            pubkey: input_origin.pubkey,
            signature: scripts[0][1..=signature_len].to_vec(),
        });
        let signed = psbt::encode_unsigned(&[input], &outputs, &[]).unwrap();
        assert_eq!(
            psbt::finalize_p2pkh(&original, &signed, Network::Chipnet).unwrap(),
            raw
        );
        (encode_hex(&signed), encode_hex(&raw))
    }

    async fn sync_fixture(runtime: &AppRuntime) {
        let state = runtime.state();
        let xpub = state.wallet.as_ref().unwrap().account_xpub.clone().unwrap();
        let (reply, received) = oneshot::channel();
        runtime
            .action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::BeginHd(
                xpub,
                HdSyncLimits::default(),
                reply,
            )))
            .await
            .unwrap();
        let (lease, scan) = received.await.unwrap().unwrap();
        let parent = fixture_parent(&state);
        let mut book = scan.address_book();
        book.last_used[0] = Some(0);
        let mut result = WalletReconciliation::default();
        result.reconcile_candidate(
            WalletNetworkSnapshot {
                hd: Some(book),
                interests: scan.interests(),
                transactions: vec![ObservedTransaction {
                    txid: optn_core::tx::double_sha256(&parent),
                    raw: parent,
                    block_height: None,
                }],
                tip: None,
            },
            SourceId::new("offline-fixture"),
            Evidence::ServerAssertion,
            None,
            true,
        );
        let (reply, received) = oneshot::channel();
        runtime
            .action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Finish(
                lease,
                Box::new(result),
                reply,
            )))
            .await
            .unwrap();
        assert_eq!(
            received.await.unwrap().unwrap(),
            ReconciliationDecision::Accepted
        );
    }

    #[tokio::test]
    async fn airgap_actor_reserves_before_export_and_rejects_stale_or_unsaved_intent() {
        let storage = Storage::default();
        let checkpoints = Checkpoints::default();
        let account = AccountPath::default_for(Network::Chipnet);
        let public = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(account)
            .unwrap();
        let security = WalletSecurity::new(Box::new(storage), None)
            .with_checkpoints(Box::new(checkpoints.clone()));
        let (runtime, driver) =
            AppRuntime::new_with_security(AppState::default(), security).unwrap();
        tokio::spawn(driver.run());
        let transport = DirectTransport::new(runtime.clone());
        let secret = |value: &str| optn_app::SecretText::new(value.into());
        let opened = transport
            .wallet_security(WalletSecurityRequest::ImportWatchOnly {
                name: "Public airgap actor fixture".into(),
                account_xpub: secret(&public),
                master_fingerprint: String::new(),
                password: secret(""),
                confirmation: secret(""),
                network: "chipnet".into(),
                account_path: account.to_string(),
            })
            .await
            .unwrap();
        let prepare = || AirgapRequest::Prepare {
            destination: runtime
                .state()
                .wallet
                .as_ref()
                .unwrap()
                .receive_address
                .clone(),
            amount_sats: 10_000,
            coin: None,
        };
        assert!(
            transport.airgap(prepare()).await.is_err(),
            "restored/unsynced coins cannot be exported"
        );
        sync_fixture(&runtime).await;
        let first = transport.airgap(prepare()).await.unwrap();
        assert_eq!(
            runtime
                .state()
                .hd_addresses
                .as_ref()
                .unwrap()
                .next_indexes()[1],
            1
        );
        assert_eq!(
            checkpoints
                .saved
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .0
                .allocation
                .as_ref()
                .unwrap()
                .next_indexes()[1],
            1
        );
        assert!(first.raw_transaction_hex.is_none());
        assert_eq!(first.change_sats + first.fee_sats, 10_000);
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: first.request_id,
                signed_psbt_hex: first.psbt_hex.clone()
            })
            .await
            .is_err());
        let (first_signed, first_raw) = sign_fixture(&runtime.state(), &first);
        let finalized = transport
            .airgap(AirgapRequest::Finalize {
                request_id: first.request_id,
                signed_psbt_hex: first_signed.clone(),
            })
            .await
            .unwrap();
        assert_eq!(
            finalized.raw_transaction_hex.as_deref(),
            Some(first_raw.as_str())
        );
        let mut txid = optn_core::tx::double_sha256(&decode_hex(&first_raw).unwrap());
        txid.reverse();
        assert_eq!(finalized.txid, Some(encode_hex(&txid)));
        assert_eq!(finalized.psbt_hex, first.psbt_hex);
        let second = transport.airgap(prepare()).await.unwrap();
        assert_ne!(first.request_id, second.request_id);
        assert_ne!(first.change_address, second.change_address);
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: first.request_id,
                signed_psbt_hex: first_signed.clone()
            })
            .await
            .is_err());
        // Also reject a cryptographically valid return under the replacement's
        // current ID: this must fail exact intent binding, not ID validation.
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: second.request_id,
                signed_psbt_hex: first_signed,
            })
            .await
            .is_err());
        let (second_signed, second_raw) = sign_fixture(&runtime.state(), &second);
        assert_eq!(
            transport
                .airgap(AirgapRequest::Finalize {
                    request_id: second.request_id,
                    signed_psbt_hex: second_signed.clone(),
                })
                .await
                .unwrap()
                .raw_transaction_hex
                .as_deref(),
            Some(second_raw.as_str())
        );
        let coin = runtime.state().spend.as_ref().unwrap().selected;
        runtime.dispatch(AppAction::FreezeCoin(coin)).await.unwrap();
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: second.request_id,
                signed_psbt_hex: second_signed
            })
            .await
            .is_err());
        runtime
            .dispatch(AppAction::UnfreezeCoin(coin))
            .await
            .unwrap();
        checkpoints.fail.store(true, Ordering::SeqCst);
        assert!(
            transport.airgap(prepare()).await.is_err(),
            "storage failure must not expose a PSBT"
        );
        assert!(!runtime.state().wallet_sync.utxos_fresh);
        assert_eq!(
            runtime
                .state()
                .hd_addresses
                .as_ref()
                .unwrap()
                .next_indexes()[1],
            2
        );
        checkpoints.fail.store(false, Ordering::SeqCst);
        sync_fixture(&runtime).await;
        let third = transport.airgap(prepare()).await.unwrap();
        let (third_signed, third_raw) = sign_fixture(&runtime.state(), &third);
        assert_eq!(
            transport
                .airgap(AirgapRequest::Finalize {
                    request_id: third.request_id,
                    signed_psbt_hex: third_signed.clone(),
                })
                .await
                .unwrap()
                .raw_transaction_hex
                .as_deref(),
            Some(third_raw.as_str())
        );
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        transport
            .wallet_security(WalletSecurityRequest::Open {
                handle: opened.active.unwrap(),
                password: secret(""),
            })
            .await
            .unwrap();
        assert_eq!(
            runtime
                .state()
                .hd_addresses
                .as_ref()
                .unwrap()
                .next_indexes()[1],
            3,
            "restart keeps consumed change indexes"
        );
        assert!(
            transport.airgap(prepare()).await.is_err(),
            "restart never restores spend freshness"
        );
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: third.request_id,
                signed_psbt_hex: third_signed.clone()
            })
            .await
            .is_err());
        // Freshness alone cannot resurrect a request from the previous epoch.
        sync_fixture(&runtime).await;
        assert!(transport
            .airgap(AirgapRequest::Finalize {
                request_id: third.request_id,
                signed_psbt_hex: third_signed,
            })
            .await
            .is_err());
        assert_eq!(
            transport.airgap(AirgapRequest::Cancel).await.unwrap(),
            AirgapResponse::default()
        );
    }
}
