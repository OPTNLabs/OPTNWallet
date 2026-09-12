//! Read-only live test, explicitly opt-in. Uses the production Tor route and
//! exact Chipnet source, with no keys, signing, broadcasting, or mainnet mode.
//! Run: cargo test --manifest-path crates/optn-cli/Cargo.toml --test chipnet_wallet_runtime -- --ignored --nocapture

use optn_app::{AppAction, AppState, OpenedWallet, WalletKind};
use optn_chain_native::{build_native_chain_stack, NativeChainSecrets};
use optn_core::{
    cashaddr::Address,
    hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
};
use optn_runtime::{
    chain::{
        ChainSource, ConnectionPolicy, Endpoint, EndpointKind, Evidence, ProtocolFamily,
        SourceCatalog, SourceDisposition, SourceId, SourceOrigin, VerificationState,
    },
    hd_sync::HdSyncLimits,
    network_config::{NetworkConfigEnvelope, NetworkConfigStore, UserNetworkOverlay},
    reconciliation::ReconciliationDecision,
    sync_worker::ProgressiveSyncWorker,
    AppRuntime, DirectTransport,
};
use optn_transport::{AppTransport, WireState};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires explicit Chipnet live-test authorization and a local Tor SOCKS proxy"]
async fn chipnet_hd_account_reaches_shared_runtime_and_transport() {
    // Public account override, or a published BIP39 fixture. Never read user
    // wallet/seed files. The runtime and CLI receive only the public account.
    let account = std::env::var("OPTN_CHIPNET_TEST_ACCOUNT")
        .map(|path| optn_core::hd::parse_account_path(&path).unwrap())
        .unwrap_or_else(|_| AccountPath::default_for(Network::Chipnet));
    let xpub = std::env::var("OPTN_CHIPNET_TEST_XPUB").unwrap_or_else(|_| {
        Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(account)
            .unwrap()
    });
    let address = optn_core::watch_only::address_under_account(Network::Chipnet, &xpub, 0, 0)
        .unwrap()
        .address;
    let source = SourceId::new("chipnet-live-exact");
    let mut catalog = SourceCatalog::default();
    catalog
        .insert(ChainSource {
            id: source.clone(),
            label: "Chipnet live test".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: Network::Chipnet.default_host().into(),
                port: Some(Network::Chipnet.default_port()),
            }],
            capabilities: Default::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        })
        .unwrap();
    let stack = tokio::time::timeout(
        Duration::from_secs(60),
        build_native_chain_stack(
            catalog.clone(),
            ConnectionPolicy::exact(source.clone(), ProtocolFamily::Electrum),
            "chipnet",
            &NativeChainSecrets::default(),
        ),
    )
    .await
    .expect("bounded source probe");
    assert!(
        stack.failures.is_empty(),
        "Chipnet probe failed: {:?}",
        stack.failures
    );
    let initial_wallet = AppState {
        network: Network::Chipnet,
        wallet: Some(OpenedWallet {
            kind: WalletKind::WatchOnly,
            name: "Live Chipnet HD account".into(),
            receive_address: address.clone(),
            master_fingerprint: None,
            account_path: account.to_string(),
            multisig_policy: None,
            account_xpub: Some(xpub.clone()),
        }),
        ..Default::default()
    };
    let runtime = AppRuntime::spawn(initial_wallet.clone());
    let transport = DirectTransport::new(runtime.clone());
    let mut worker = ProgressiveSyncWorker::new(Default::default());
    let mut service = stack.service.lock().await;
    let decision = tokio::time::timeout(
        Duration::from_secs(300),
        runtime.sync_hd_wallet(
            &mut service,
            &mut worker,
            xpub.clone(),
            HdSyncLimits::default(),
        ),
    )
    .await
    .expect("bounded wallet refresh")
    .expect("runtime publication");
    assert_eq!(decision, ReconciliationDecision::Accepted);
    let status = runtime.subscribe_wallet_sync().borrow().clone();
    assert!(status.sync.history_fresh && status.sync.utxos_fresh);
    assert_eq!(status.sync.verification, VerificationState::Discovered);
    let observed = status.authoritative.as_ref().unwrap();
    assert_eq!(observed.source, source);
    assert_eq!(observed.evidence, Evidence::ServerAssertion);
    assert!(observed
        .value
        .tip
        .as_ref()
        .is_some_and(|tip| tip.height > 0));
    let book = observed
        .value
        .hd
        .as_ref()
        .expect("complete HD address book");
    assert_eq!(book.account, account);
    assert!(book.branches.iter().all(|branch| branch.len() >= 20));
    let (confirmed, pending) =
        book.branches
            .iter()
            .flatten()
            .fold((0i64, 0i64), |(confirmed, pending), entry| {
                let script = Address::decode(&entry.address).unwrap().script_pubkey();
                let (c, p) = observed.value.script_balance(&script).unwrap();
                (
                    confirmed.checked_add(c).unwrap(),
                    pending.checked_add(p).unwrap(),
                )
            });
    let app = transport.snapshot().await.unwrap();
    assert_eq!(
        i64::try_from(app.coins.iter().map(|coin| coin.value_sats()).sum::<u64>()).unwrap(),
        confirmed + pending
    );
    let wire = WireState::from(&app);
    let restored = AppState::try_from(wire).expect("typed transport round trip");
    assert_eq!(restored.coins, app.coins);

    // Persist the real observation through the same atomic encrypted adapter
    // used by the native GUI and saved-wallet CLI. The random key protects only
    // this disposable public-account checkpoint; it grants no spending authority.
    let checkpoint_dir = tempfile::tempdir().unwrap();
    let checkpoint_file = optn_chain_native::wallet_checkpoint::WalletCheckpointFile::new(
        checkpoint_dir.path().join("live.state"),
    );
    // Drawn straight from the OS rather than zero-initialised and then
    // overwritten. The two are identical at runtime -- `fill_bytes` replaces
    // every byte -- but taint analysis follows the `[0u8; N]` literal into
    // `derive_key` and reports a hard-coded salt, because it cannot see that
    // the placeholder never survives. Writing it this way removes the
    // placeholder rather than the warning, so the finding stays meaningful if
    // a real constant ever does reach a salt.
    let password: [u8; 32] = rand::random();
    let salt: [u8; optn_core::wallet_pack::SALT_LEN] = rand::random();
    let password: String = password.iter().map(|byte| format!("{byte:02x}")).collect();
    let key = optn_core::wallet_pack::derive_key(&password, &salt).unwrap();
    checkpoint_file
        .store(&runtime.wallet_checkpoint().await.unwrap(), &key, None)
        .unwrap();

    // A real successful observation followed by route loss must retain coins
    // and evidence, with stale status rather than a fresh empty wallet.
    *service.catalog_mut() = SourceCatalog::default();
    assert!(runtime
        .sync_hd_wallet(
            &mut service,
            &mut worker,
            xpub.clone(),
            HdSyncLimits::default()
        )
        .await
        .is_err());
    assert_eq!(runtime.state().coins, app.coins);
    assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
    runtime.dispatch(AppAction::LockWallet).await.unwrap();
    assert!(runtime.state().coins.is_empty());
    assert!(runtime
        .subscribe_wallet_sync()
        .borrow()
        .authoritative
        .is_none());
    drop(transport);
    drop(runtime);
    drop(service);

    let restarted = AppRuntime::spawn(initial_wallet);
    let (checkpoint, _) = checkpoint_file
        .load(&key)
        .unwrap()
        .expect("saved checkpoint");
    restarted
        .restore_wallet_checkpoint(checkpoint)
        .await
        .unwrap();
    let before_refresh = restarted.state();
    assert_eq!(before_refresh.coins, app.coins);
    assert_eq!(before_refresh.wallet_sync.history, app.wallet_sync.history);
    assert!(!before_refresh.wallet_sync.utxos_fresh);
    assert!(!before_refresh.wallet_sync.history_fresh);
    assert!(!before_refresh.fusion.session_armed);
    let restart_stack = tokio::time::timeout(
        Duration::from_secs(60),
        build_native_chain_stack(
            catalog.clone(),
            ConnectionPolicy::exact(source.clone(), ProtocolFamily::Electrum),
            "chipnet",
            &NativeChainSecrets::default(),
        ),
    )
    .await
    .expect("bounded restart probe");
    assert!(
        restart_stack.failures.is_empty(),
        "{:?}",
        restart_stack.failures
    );
    let mut restart_service = restart_stack.service.lock().await;
    let mut restart_worker = ProgressiveSyncWorker::new(Default::default());
    let resumed = tokio::time::timeout(
        Duration::from_secs(300),
        restarted.sync_hd_wallet(
            &mut restart_service,
            &mut restart_worker,
            xpub.clone(),
            HdSyncLimits::default(),
        ),
    )
    .await
    .expect("bounded resume")
    .expect("resumed publication");
    assert_eq!(resumed, ReconciliationDecision::Accepted);
    assert!(restarted.state().wallet_sync.utxos_fresh);
    assert!(restarted.state().wallet_sync.history_fresh);
    // Exercise the actual command dispatcher with the same persisted selection.
    let directory = std::env::temp_dir().join(format!(
        "optn-chipnet-live-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let config = directory.join("network-chipnet.json");
    optn_chain_native::network_config::NetworkConfigFile::new(config.clone())
        .store_atomic(&NetworkConfigEnvelope::current(
            "live-test",
            UserNetworkOverlay {
                user_sources: catalog.iter().cloned().collect(),
                connection_policy: ConnectionPolicy::exact(
                    source.clone(),
                    ProtocolFamily::Electrum,
                ),
                ..Default::default()
            },
        ))
        .unwrap();
    let output = {
        std::process::Command::new(env!("CARGO_BIN_EXE_optn"))
            .args([
                "--json",
                "--network",
                "chipnet",
                "--timeout",
                "300",
                "--network-config-dir",
            ])
            .arg(&directory)
            .args([
                "rescan",
                "--xpub",
                &xpub,
                "--account-path",
                &account.to_string(),
                "--all",
            ])
            .env_remove("OPTN_MNEMONIC")
            // Rescan retains its conservative Secret capability classification;
            // with --xpub this invocation cannot read a stored wallet secret.
            .env("OPTN_POLICY", "secret")
            .output()
            .unwrap()
    };
    std::fs::remove_file(config.with_extension("lock")).unwrap();
    std::fs::remove_file(config).unwrap();
    std::fs::remove_dir(directory).unwrap();
    {
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("CLI JSON");
        assert!(output.status.success(), "CLI read failed: {value}");
        assert_eq!(value["selection"], "shared-native-policy");
        assert_eq!(value["source"], source.as_str());
        assert_eq!(value["evidence"], "ServerAssertion");
        assert_eq!(value["total"], confirmed + pending);
        assert_eq!(value["hd"], true);
        assert_eq!(value["complete"], true);
        assert_eq!(value["account_path"], account.to_string());
        assert!(value["scanned_addresses"].as_u64().unwrap() >= 60);
    }
    println!("Chipnet HD/Tor: height={}, transactions={}, outputs={}, evidence=ServerAssertion; CLI HD rescan, transport parity, encrypted restart/resume, outage retention, and lock clearing passed",
        observed.value.tip.as_ref().unwrap().height, observed.value.transactions.len(), app.coins.len());
}
