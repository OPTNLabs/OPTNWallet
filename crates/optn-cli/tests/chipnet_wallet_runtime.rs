//! Read-only live test, explicitly opt-in. Uses the production Tor route and
//! exact Chipnet source, with no keys, signing, broadcasting, or mainnet mode.
//! Run: cargo test --manifest-path crates/optn-cli/Cargo.toml --test chipnet_wallet_runtime -- --ignored --nocapture

use optn_app::{AppAction, AppState, SecretText, WalletKind};
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
use optn_transport::{AppTransport, WalletSecurityRequest as Request, WireState};
use std::io::{Read, Write};
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
    let wallet_dir = tempfile::tempdir().unwrap();
    let managed_runtime = || {
        let security = optn_runtime::wallet_security::WalletSecurity::new(
            Box::new(
                optn_platform_native::wallet_storage::NativeWalletStorage::new(
                    wallet_dir.path().to_owned(),
                ),
            ),
            None,
        )
        .with_checkpoints(Box::new(
            optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(
                wallet_dir.path().join(".state"),
            ),
        ));
        let (runtime, driver) =
            AppRuntime::new_with_security(AppState::default(), security).unwrap();
        tokio::spawn(driver.run());
        runtime
    };
    let runtime = managed_runtime();
    let imported = runtime
        .wallet_security(Request::ImportWatchOnly {
            name: "Live Chipnet HD account".into(),
            account_xpub: SecretText::new(xpub.clone()),
            master_fingerprint: String::new(),
            network: "chipnet".into(),
            account_path: account.to_string(),
            password: SecretText::new("public-live-fixture".into()),
            confirmation: SecretText::new("public-live-fixture".into()),
        })
        .await
        .unwrap();
    let handle = imported.active.unwrap();
    assert_eq!(
        runtime.state().wallet.as_ref().unwrap().kind,
        WalletKind::WatchOnly
    );
    let transport = DirectTransport::new(runtime.clone());
    let mut worker =
        ProgressiveSyncWorker::new(Default::default()).with_accepted_headers(stack.headers.clone());
    let mut service = stack.service.lock().await;
    let decision = tokio::time::timeout(
        Duration::from_secs(300),
        runtime.sync_hd_wallet_from_floor(
            &mut service,
            &mut worker,
            xpub.clone(),
            HdSyncLimits::default(),
            Some(1),
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
    let coverage = app
        .wallet_sync
        .scan_coverage
        .expect("requested scan coverage");
    assert_eq!(coverage.from_height, 1);
    assert_eq!(coverage.skipped_below, Some(1));
    assert!(coverage.chosen_by_holder);
    assert_eq!(app.wallet_sync.rescan_requested, None);
    assert_eq!(
        i64::try_from(app.coins.iter().map(|coin| coin.value_sats()).sum::<u64>()).unwrap(),
        confirmed + pending
    );
    let wire = WireState::from(&app);
    let restored = AppState::try_from(wire).expect("typed transport round trip");
    assert_eq!(restored.coins, app.coins);
    assert_eq!(restored.wallet_sync.scan_coverage, Some(coverage));

    let wallet_bytes = std::fs::read(wallet_dir.path().join(&handle)).unwrap();
    assert!(!String::from_utf8_lossy(&wallet_bytes).contains(&xpub));

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

    let restarted = managed_runtime();
    assert!(restarted.state().wallet.is_none());
    let listed = restarted.wallet_security(Request::Status).await.unwrap();
    assert!(listed.wallets.iter().any(|wallet| wallet.handle == handle));
    restarted
        .wallet_security(Request::Open {
            handle: handle.clone(),
            password: SecretText::new("public-live-fixture".into()),
        })
        .await
        .unwrap();
    let before_refresh = restarted.state();
    assert_eq!(before_refresh.coins, app.coins);
    assert_eq!(before_refresh.wallet_sync.history, app.wallet_sync.history);
    assert_eq!(before_refresh.wallet_sync.scan_coverage, Some(coverage));
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
    let mut restart_worker = ProgressiveSyncWorker::new(Default::default())
        .with_accepted_headers(restart_stack.headers.clone());
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
    assert_eq!(restarted.state().wallet_sync.scan_coverage, Some(coverage));
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
                "--from-height",
                "1",
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
    {
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("CLI JSON");
        assert!(output.status.success(), "CLI read failed: {value}");
        assert_eq!(value["selection"], "shared-native-policy");
        assert_eq!(value["source"], source.as_str());
        assert_eq!(value["evidence"], "ServerAssertion");
        assert_eq!(value["total"], confirmed + pending);
        assert_eq!(value["hd"], true);
        assert_eq!(value["complete"], false);
        assert_eq!(value["wallet_sync"]["scan_coverage"]["from_height"], 1);
        assert_eq!(value["account_path"], account.to_string());
        assert!(value["scanned_addresses"].as_u64().unwrap() >= 60);
    }
    restarted.dispatch(AppAction::LockWallet).await.unwrap();
    drop(restarted);
    let mut console = std::process::Command::new(env!("CARGO_BIN_EXE_optn"))
        .args([
            "--json",
            "--network",
            "chipnet",
            "--timeout",
            "300",
            "--network-config-dir",
        ])
        .arg(&directory)
        .arg("--wallet-directory")
        .arg(wallet_dir.path())
        .args(["wallet", "--stdio"])
        .env_remove("OPTN_MNEMONIC")
        .env_remove("OPTN_PASSPHRASE")
        .env("OPTN_POLICY", "secret")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        serde_json::json!({"request":{"command":"open","handle":handle,"password":"public-live-fixture"}}),
        serde_json::json!({"chain":"sync"}),
        serde_json::json!({"chain":"history"}),
    ];
    {
        let mut input = console.stdin.take().unwrap();
        for request in requests {
            writeln!(input, "{request}").unwrap();
        }
    }
    // Drain both pipes while the child runs: several history replies can
    // exceed the platform pipe capacity before the process reaches EOF.
    let mut stdout = console.stdout.take().unwrap();
    let mut stderr = console.stderr.take().unwrap();
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(360);
    while console.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            console.kill().unwrap();
            let _ = console.wait();
            panic!("managed CLI live sync exceeded its deadline");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut output = console.wait_with_output().unwrap();
    output.stdout = stdout_reader.join().unwrap();
    output.stderr = stderr_reader.join().unwrap();
    assert!(output.status.success(), "managed CLI process failed");
    let replies: Vec<serde_json::Value> = serde_json::Deserializer::from_slice(&output.stdout)
        .into_iter()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(replies.len(), 4);
    assert!(replies.iter().all(|reply| reply["ok"] == true));
    assert_eq!(replies[0]["wallet_sync"]["history_fresh"], false);
    assert_eq!(replies[2]["wallet_sync"]["history_fresh"], true);
    assert_eq!(replies[2]["wallet_sync"]["utxos_fresh"], true);
    assert_eq!(replies[2]["wallet_sync"]["confirmed_sats"], confirmed);
    assert_eq!(replies[2]["wallet_sync"]["pending_sats"], pending);
    assert_eq!(replies[2]["wallet_sync"]["scan_coverage"]["from_height"], 1);
    assert_eq!(replies[3]["locked"], true);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&xpub));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("public-live-fixture"));
    std::fs::remove_file(config.with_extension("lock")).unwrap();
    std::fs::remove_file(config).unwrap();
    std::fs::remove_dir(directory).unwrap();
    println!("Chipnet HD/Tor: height={}, transactions={}, outputs={}, evidence=ServerAssertion; CLI HD rescan, managed watch-only import/sync/restart/CLI resume, transport parity, outage retention, and lock clearing passed",
        observed.value.tip.as_ref().unwrap().height, observed.value.transactions.len(), app.coins.len());
}
