//! Offline actor tests using published keys and authenticated checkpoint storage.
use super::*;
use crate::{
    chain::{Evidence, SourceId},
    chain_service::ObservedTransaction,
    hd_sync::HdSyncLimits,
    reconciliation::ReconciliationDecision,
    sync_worker::WalletNetworkSnapshot,
    wallet_checkpoint::{WalletCheckpoint, WalletCheckpointStorage},
    wallet_security::{
        tests::{Storage, TestCheckpoints},
        WalletSecurity,
    },
    wallet_sync::{WalletReconciliation, WalletSyncRequest},
};
use optn_core::{
    hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
};
use optn_transport::WalletSecurityRequest as Request;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub(crate) struct Checkpoints {
    store: TestCheckpoints,
    pub(crate) fail: Arc<AtomicBool>,
}
impl WalletCheckpointStorage for Checkpoints {
    fn load(
        &self,
        id: &[u8; 32],
        key: &optn_core::wallet_pack::PackKey,
    ) -> Result<Option<(WalletCheckpoint, [u8; 32])>, String> {
        self.store.load(id, key)
    }
    fn store(
        &self,
        id: &[u8; 32],
        value: &WalletCheckpoint,
        key: &optn_core::wallet_pack::PackKey,
        expected: Option<[u8; 32]>,
    ) -> Result<[u8; 32], String> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("fixture write failed".into());
        }
        self.store.store(id, value, key, expected)
    }
}
pub(crate) fn start(storage: Storage, checkpoints: Checkpoints) -> AppRuntime {
    let security =
        WalletSecurity::new(Box::new(storage), None).with_checkpoints(Box::new(checkpoints));
    let (runtime, driver) = AppRuntime::new_with_security(AppState::default(), security).unwrap();
    tokio::spawn(driver.run());
    runtime
}
pub(crate) fn secret(s: &str) -> optn_app::SecretText {
    optn_app::SecretText::new(s.into())
}
pub(crate) async fn fixture() -> (AppRuntime, Storage, Checkpoints, String) {
    let storage = Storage::default();
    let checkpoints = Checkpoints::default();
    let runtime = start(storage.clone(), checkpoints.clone());
    let opened = runtime
        .wallet_security(Request::Create {
            name: "Public payment fixture".into(),
            mnemonic: secret(BIP39_TEST_VECTOR_MNEMONIC),
            bip39_passphrase: secret(""),
            password: secret(""),
            confirmation: secret(""),
            network: "chipnet".into(),
            account_path: AccountPath::default_for(Network::Chipnet).to_string(),
            draft: None,
        })
        .await
        .unwrap();
    (runtime, storage, checkpoints, opened.active.unwrap())
}
fn intent(id: &str) -> PaymentIntent {
    let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap();
    PaymentIntent {
        id: id.into(),
        binding: [42; 32],
        destination: wallet
            .address(Network::Chipnet, "m/44'/1'/5'/0/0")
            .unwrap()
            .encode(),
        amount_sats: 10_000,
        fee_per_byte: 1,
        max_fee_sats: 1_000,
    }
}
pub(crate) async fn prepare(
    runtime: &AppRuntime,
    id: &str,
) -> Result<PaymentRecord, TransportError> {
    runtime
        .external_payment(PaymentOperation::Prepare {
            intent: intent(id),
            signed_hex: None,
        })
        .await
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

pub(crate) async fn sync_fixture(runtime: &AppRuntime) {
    let state = runtime.state();
    let xpub = state.wallet.as_ref().unwrap().account_xpub.clone().unwrap();
    let (reply, received) = oneshot::channel();
    runtime
        .action_tx
        .send(RuntimeRequest::WalletSync(WalletSyncRequest::BeginHd(
            xpub,
            HdSyncLimits::default(),
            None,
            runtime.revocation.load(std::sync::atomic::Ordering::SeqCst),
            reply,
        )))
        .await
        .unwrap();
    let (mut lease, scan) = received.await.unwrap().unwrap();
    let view = crate::header_view::VerifiedHeaderView::new(
        Network::Chipnet,
        crate::header_verifier::shipped_header_verifier(Network::Chipnet).unwrap(),
    );
    lease.capture_header_progress(Some(&view)).unwrap();
    let (height, hash) = view.tip().unwrap();
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
            tip: Some(crate::chain_service::ChainTip { height, hash }),
        },
        SourceId::new("offline-fixture"),
        Evidence::ServerAssertion,
        Some((height, hash)),
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
async fn saved_payment_survives_restart_reuses_bytes_and_keeps_reservations() {
    let (runtime, storage, checkpoints, handle) = fixture().await;
    assert!(prepare(&runtime, "first").await.is_err());
    sync_fixture(&runtime).await;
    let before = runtime.state().hd_addresses.unwrap().next_indexes();
    let record = prepare(&runtime, "first").await.unwrap();
    assert!(!record.released);
    assert_eq!(record.inputs.len(), 1);
    assert_eq!(
        runtime.state().hd_addresses.unwrap().next_indexes()[1],
        before[1] + 1
    );
    assert!(runtime
        .state()
        .coins
        .iter()
        .all(|c| c.freeze() == Some(FreezeReason::ExternalPayment)));
    assert_eq!(prepare(&runtime, "first").await.unwrap(), record);
    let mut changed = intent("first");
    changed.binding[0] ^= 1;
    assert!(runtime
        .external_payment(PaymentOperation::Prepare {
            intent: changed,
            signed_hex: None
        })
        .await
        .is_err());
    assert!(prepare(&runtime, "second").await.is_err());
    let wire = serde_json::to_string(&optn_transport::WireState::from(&runtime.state())).unwrap();
    assert!(!wire.contains(&record.raw_hex));
    let released = runtime
        .external_payment(PaymentOperation::Release { id: "first".into() })
        .await
        .unwrap();
    assert!(released.released);
    runtime
        .external_payment(PaymentOperation::Response {
            id: "first".into(),
            status: 200,
        })
        .await
        .unwrap();
    runtime
        .dispatch(optn_app::AppAction::LockWallet)
        .await
        .unwrap();
    assert!(runtime.state().payment_outbox.is_empty());
    let reopened = start(storage, checkpoints);
    reopened
        .wallet_security(Request::Open {
            handle,
            password: secret(""),
        })
        .await
        .unwrap();
    assert!(!reopened.state().wallet_sync.utxos_fresh);
    assert_eq!(reopened.state().payment_outbox[0].raw_hex, record.raw_hex);
    assert_eq!(
        reopened.state().payment_outbox[0].response_status,
        Some(200)
    );
    sync_fixture(&reopened).await;
    let retry = prepare(&reopened, "first").await.unwrap();
    assert_eq!(retry.raw_hex, record.raw_hex);
    assert!(retry.released);
    assert!(prepare(&reopened, "third").await.is_err());
}

#[tokio::test]
async fn failed_checkpoint_and_stale_revision_never_publish_payment_bytes() {
    let (runtime, storage, checkpoints, handle) = fixture().await;
    sync_fixture(&runtime).await;
    let allocation = runtime.state().hd_addresses;
    checkpoints.fail.store(true, Ordering::SeqCst);
    assert!(prepare(&runtime, "failed").await.is_err());
    assert!(runtime.state().payment_outbox.is_empty());
    assert_eq!(runtime.state().hd_addresses, allocation);
    checkpoints.fail.store(false, Ordering::SeqCst);
    runtime
        .wallet_security(Request::Open {
            handle: handle.clone(),
            password: secret(""),
        })
        .await
        .unwrap();
    sync_fixture(&runtime).await;
    let other = start(storage, checkpoints);
    other
        .wallet_security(Request::Open {
            handle,
            password: secret(""),
        })
        .await
        .unwrap();
    sync_fixture(&other).await;
    assert!(prepare(&runtime, "stale").await.is_err());
    assert!(runtime.state().payment_outbox.is_empty());
    assert!(prepare(&other, "winner").await.is_ok());
}

#[tokio::test]
async fn signed_import_is_verified_before_reservation_and_respects_session_changes() {
    let (signer, _, _, _) = fixture().await;
    sync_fixture(&signer).await;
    let signed = prepare(&signer, "signed").await.unwrap();
    let (runtime, _, _, _) = fixture().await;
    sync_fixture(&runtime).await;
    let mut broken = optn_core::payment::decode_hex(&signed.raw_hex).unwrap();
    broken[50] ^= 1;
    assert!(runtime
        .external_payment(PaymentOperation::Prepare {
            intent: intent("signed"),
            signed_hex: Some(optn_core::payment::hex(&broken))
        })
        .await
        .is_err());
    assert!(runtime.state().payment_outbox.is_empty());
    let mutation = runtime.begin_wallet_mutation();
    assert!(prepare(&runtime, "revoked").await.is_err());
    drop(mutation);
    let imported = runtime
        .external_payment(PaymentOperation::Prepare {
            intent: intent("signed"),
            signed_hex: Some(signed.raw_hex.clone()),
        })
        .await
        .unwrap();
    assert_eq!(imported.raw_hex, signed.raw_hex);
    assert!(prepare(&runtime, "overlap").await.is_err());
    let mut corrupted = imported.clone();
    corrupted.fee_sats += 1;
    assert!(optn_core::payment::validate_outbox(&[corrupted]).is_err());
}

#[tokio::test]
async fn watch_only_import_and_legacy_refusal_preserve_wallet_authority() {
    let (signer, storage, checkpoints, handle) = fixture().await;
    sync_fixture(&signer).await;
    let xpub = signer.state().wallet.unwrap().account_xpub.unwrap();
    let signed = prepare(&signer, "external").await.unwrap();
    let watcher = start(Storage::default(), Checkpoints::default());
    watcher
        .wallet_security(Request::ImportWatchOnly {
            name: "Public watch payment fixture".into(),
            account_xpub: secret(&xpub),
            master_fingerprint: String::new(),
            password: secret(""),
            confirmation: secret(""),
            network: "chipnet".into(),
            account_path: AccountPath::default_for(Network::Chipnet).to_string(),
        })
        .await
        .unwrap();
    sync_fixture(&watcher).await;
    assert!(matches!(
        prepare(&watcher, "automatic").await,
        Err(TransportError::Unsupported)
    ));
    assert!(watcher.state().payment_outbox.is_empty());
    let mut expensive = intent("expensive");
    expensive.max_fee_sats = 1;
    assert!(watcher
        .external_payment(PaymentOperation::Prepare {
            intent: expensive,
            signed_hex: Some(signed.raw_hex.clone())
        })
        .await
        .is_err());
    let imported = watcher
        .external_payment(PaymentOperation::Prepare {
            intent: intent("external"),
            signed_hex: Some(signed.raw_hex),
        })
        .await
        .unwrap();
    assert_eq!(imported.txid, signed.txid);

    // Keep the persisted legacy owner: it must not become permission to bypass
    // that host's separate reservation store.
    use optn_platform::WalletStorage;
    let original = storage.read(&handle).unwrap();
    let mut file = optn_core::wallet_file::WalletFile::parse(&original).unwrap();
    file.extra
        .insert("legacySourceId".into(), serde_json::json!(7));
    storage
        .save(&handle, Some(&original), &file.encode().unwrap())
        .unwrap();
    let legacy = start(storage, checkpoints);
    legacy
        .wallet_security(Request::Open {
            handle,
            password: secret(""),
        })
        .await
        .unwrap();
    sync_fixture(&legacy).await;
    let error = prepare(&legacy, "legacy").await.unwrap_err();
    assert!(
        matches!(error,TransportError::Other(ref message) if message.contains("legacy reservations"))
    );
}
