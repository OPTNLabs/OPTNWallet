//! Opt-in connected runtime and CLI proof, using two loopback regtest peers on
//! the same chain. One must serve SHV, one must be ordinary BIP37. Mine at least
//! 32 blocks to the published BIP39 fixture's m/44'/1'/0'/0/0 address first.
//! No user wallet, public peer discovery, signing or broadcast is involved.
use optn_app::{AppState, SecretText};
use optn_chain_native::{Bip37Backend, Bip37Config};
use optn_core::{
    hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
};
use optn_runtime::{
    chain::{
        CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily,
        ProviderHealth, SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
    },
    chain_service::{
        BackendObservation, ChainBackend, ChainFuture, ChainOperation, ChainRequest, ChainService,
    },
    hd_sync::HdSyncLimits,
    header_store::{BlockHeaderSource, SharedHeaders},
    header_verifier::shipped_header_verifier,
    reconciliation::ReconciliationDecision,
    sync_worker::{ProgressiveSyncConfig, ProgressiveSyncWorker},
    wallet_security::WalletSecurity,
    AppRuntime,
};
use optn_transport::WalletSecurityRequest;
use rand::RngCore;
use std::{
    net::SocketAddr,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

struct ObservedPeer {
    peer: Bip37Backend,
    requests: Arc<Mutex<Vec<ChainRequest>>>,
}

impl ChainBackend for ObservedPeer {
    fn source_id(&self) -> &SourceId {
        self.peer.source_id()
    }
    fn protocol(&self) -> ProtocolFamily {
        self.peer.protocol()
    }
    fn endpoint(&self) -> Option<&Endpoint> {
        self.peer.endpoint()
    }
    fn capabilities(&self) -> &CapabilitySet {
        self.peer.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.peer.health()
    }
    fn supports(&self, operation: ChainOperation) -> bool {
        self.peer.supports(operation)
    }
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        self.requests.lock().unwrap().push(request.clone());
        self.peer.execute(request)
    }
}

fn endpoint(variable: &str) -> Endpoint {
    let socket: SocketAddr = std::env::var(variable)
        .unwrap_or_else(|_| panic!("set {variable} to the disposable regtest peer"))
        .parse()
        .expect("literal loopback IP:port");
    assert!(socket.ip().is_loopback(), "live fixture is loopback-only");
    Endpoint {
        kind: EndpointKind::BchP2p,
        host: socket.ip().to_string(),
        port: Some(socket.port()),
    }
}

fn runtime(directory: &Path) -> (AppRuntime, tokio::task::JoinHandle<()>) {
    let security = WalletSecurity::new(
        Box::new(optn_platform_native::wallet_storage::NativeWalletStorage::new(directory.into())),
        None,
    )
    .with_checkpoints(Box::new(
        optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(directory.join(".state")),
    ));
    let (runtime, driver) = AppRuntime::new_with_security(
        AppState {
            network: Network::Regtest,
            ..Default::default()
        },
        security,
    )
    .unwrap();
    (runtime, tokio::spawn(driver.run()))
}

async fn stack(
    endpoint: Endpoint,
    shv: bool,
) -> (
    ChainService,
    Arc<SharedHeaders>,
    Arc<Mutex<Vec<ChainRequest>>>,
) {
    let id = SourceId::new("local-regtest");
    let store = Arc::new(SharedHeaders::default());
    let genesis = shipped_header_verifier(Network::Regtest)
        .unwrap()
        .last_hash()
        .unwrap();
    store.write(|retained| retained.insert_hash_only(0, genesis));
    let peer = Bip37Backend::connect(
        Bip37Config::new(id.clone(), endpoint.clone(), "regtest"),
        store.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        peer.supports(ChainOperation::HistoricalHeaderProof),
        shv,
        "fixture peer has the wrong SHV capability"
    );
    let mut catalog = SourceCatalog::default();
    catalog
        .insert(ChainSource {
            id: id.clone(),
            label: "Disposable regtest".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![endpoint],
            capabilities: Default::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        })
        .unwrap();
    let mut service =
        ChainService::new(catalog, ConnectionPolicy::exact(id, ProtocolFamily::Bip37));
    let requests = Arc::new(Mutex::new(Vec::new()));
    service.register(Arc::new(ObservedPeer {
        peer,
        requests: requests.clone(),
    }));
    (service, store, requests)
}

async fn worker(runtime: &AppRuntime, store: Arc<SharedHeaders>) -> ProgressiveSyncWorker {
    let worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig {
        retained_header_window: 4,
        ..Default::default()
    })
    .with_accepted_headers(store);
    if let Some(progress) = runtime.restored_header_progress().await.unwrap() {
        worker
            .with_stored_header_progress(Network::Regtest, &progress)
            .unwrap()
    } else {
        worker
            .with_header_view(
                optn_runtime::header_view::VerifiedHeaderView::with_anchor_interval(
                    Network::Regtest,
                    shipped_header_verifier(Network::Regtest).unwrap(),
                    16,
                ),
            )
            .unwrap()
    }
}

async fn sync(
    runtime: &AppRuntime,
    service: &mut ChainService,
    worker: &mut ProgressiveSyncWorker,
    xpub: &str,
) {
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        runtime.sync_hd_wallet_from_floor(
            service,
            worker,
            xpub.into(),
            HdSyncLimits {
                gap_limit: 1,
                addresses_per_branch: 4,
            },
            Some(1),
        ),
    )
    .await
    .expect("bounded loopback sync")
    .expect("accepted real-node observations");
    assert_eq!(result, ReconciliationDecision::Accepted);
    assert!(runtime.state().wallet_sync.history_fresh);
    assert!(runtime.state().wallet_sync.utxos_fresh);
}

async fn stop(runtime: AppRuntime, driver: tokio::task::JoinHandle<()>) {
    drop(runtime);
    tokio::time::timeout(Duration::from_secs(5), driver)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
#[ignore = "requires peered loopback SHV and ordinary BIP37 regtest nodes with public fixture rewards"]
async fn encrypted_reopen_prunes_recovers_and_cli_accepts_both_peers() {
    let proof_endpoint = endpoint("OPTN_BCHN_SHV_P2P");
    let plain_endpoint = endpoint("OPTN_REGTEST_P2P");
    assert_ne!(
        proof_endpoint, plain_endpoint,
        "two distinct peers are required"
    );
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join(".auto-lock"), "0").unwrap();
    let fixture = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap();
    let xpub = fixture
        .account_xpub_at(AccountPath::new(1, 0).unwrap())
        .unwrap();
    let mut entropy = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut entropy);
    let password: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
    let secret = || SecretText::new(password.clone());
    let (first, driver) = runtime(directory.path());
    let opened = first
        .wallet_security(WalletSecurityRequest::ImportWatchOnly {
            name: "Regtest public fixture".into(),
            account_xpub: SecretText::new(xpub.clone()),
            master_fingerprint: String::new(),
            password: secret(),
            confirmation: secret(),
            network: "regtest".into(),
            account_path: "m/44'/1'/0'".into(),
        })
        .await
        .unwrap();
    let handle = opened.active.unwrap();
    let (mut service, store, _) = stack(proof_endpoint.clone(), true).await;
    let mut headers = worker(&first, store.clone()).await;
    sync(&first, &mut service, &mut headers, &xpub).await;
    let balance = first.state().wallet_sync.confirmed_sats.unwrap();
    let history = first.state().wallet_sync.history;
    assert!(
        balance > 0 && !history.is_empty(),
        "mine fixture rewards before running"
    );
    let checkpoint = headers.header_view().unwrap().checkpoint();
    assert!(checkpoint.height >= 32);
    let birthday_time = headers.header_view().unwrap().times().anchors()[0].median_time_past;
    assert_eq!(store.write(|retained| retained.header_at(1).cloned()), None);
    assert!(
        store.hash_at(1).is_some(),
        "advertisement alone cannot prune locator hashes"
    );
    stop(first, driver).await;

    let (reopened, driver) = runtime(directory.path());
    reopened
        .wallet_security(WalletSecurityRequest::Open {
            handle: handle.clone(),
            password: secret(),
        })
        .await
        .unwrap();
    assert_eq!(reopened.state().wallet_sync.confirmed_sats, Some(balance));
    assert!(
        !reopened.state().wallet_sync.utxos_fresh,
        "reopen is stale until refreshed"
    );
    let (mut service, store, requests) = stack(proof_endpoint.clone(), true).await;
    let mut headers = worker(&reopened, store.clone()).await;
    assert_eq!(headers.header_view().unwrap().checkpoint(), checkpoint);
    sync(&reopened, &mut service, &mut headers, &xpub).await;
    assert!(requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| matches!(request, ChainRequest::HistoricalHeaderProof { .. })));
    assert!(
        store.hash_at(1).is_none(),
        "proved history is now outside the retention window"
    );
    assert!(store.write(|retained| retained.len()) <= 4);
    requests.lock().unwrap().clear();
    sync(&reopened, &mut service, &mut headers, &xpub).await;
    assert!(requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| matches!(request, ChainRequest::HistoricalHeaderProof { .. })));
    assert_eq!(reopened.state().wallet_sync.confirmed_sats, Some(balance));
    assert_eq!(reopened.state().wallet_sync.history, history);
    stop(reopened, driver).await;

    let (plain, driver) = runtime(directory.path());
    plain
        .wallet_security(WalletSecurityRequest::Open {
            handle: handle.clone(),
            password: secret(),
        })
        .await
        .unwrap();
    let (mut service, store, requests) = stack(plain_endpoint.clone(), false).await;
    let mut headers = worker(&plain, store.clone()).await;
    sync(&plain, &mut service, &mut headers, &xpub).await;
    assert!(!requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| matches!(request, ChainRequest::HistoricalHeaderProof { .. })));
    assert_eq!(plain.state().wallet_sync.confirmed_sats, Some(balance));
    assert_eq!(plain.state().wallet_sync.history, history);
    assert!(store.hash_at(1).is_some());
    assert_eq!(store.write(|retained| retained.header_at(1).cloned()), None);
    stop(plain, driver).await;

    // The real one-shot CLI reopens the same encrypted record and uses the
    // selected peer, first SHV then ordinary. No host override or fallback.
    use optn_runtime::network_config::{
        add_user_source, encode_envelope_json, NetworkConfigEnvelope, SHIPPED_CATALOG_VERSION,
    };
    let config = directory.path().join("network");
    std::fs::create_dir_all(&config).unwrap();
    for selected in [proof_endpoint.clone(), plain_endpoint.clone()] {
        let mut envelope =
            NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, Default::default());
        let source = add_user_source(
            &mut envelope.overlay,
            "Local selected peer",
            selected,
            Some("Regtest"),
        )
        .unwrap();
        envelope.overlay.connection_policy = ConnectionPolicy::exact(source, ProtocolFamily::Bip37);
        std::fs::write(
            config.join("network-regtest.json"),
            encode_envelope_json(&envelope).unwrap(),
        )
        .unwrap();
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_optn"));
        command
            .args(["--network", "regtest", "--json", "--wallet-directory"])
            .arg(directory.path())
            .arg("--network-config-dir")
            .arg(&config)
            .args([
                "--wallet",
                &handle,
                "--password-stdin",
                "--timeout",
                "120",
                "rescan",
                "--from-height",
                "1",
                "--gap",
                "1",
                "--max-addresses",
                "4",
            ])
            .env("OPTN_POLICY", "full")
            .env_remove("OPTN_MNEMONIC")
            .env_remove("OPTN_PASSPHRASE")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        use tokio::io::AsyncWriteExt;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{password}\n").as_bytes())
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(150), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "CLI rescan failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output["ok"], true);
        // An explicit floor is scoped history, even on our disposable chain.
        // Header proofs must never turn it into a full-history claim.
        assert_eq!(output["complete"], false);
        assert_eq!(output["wallet_sync"]["scan_coverage"]["skipped_below"], 1);
        assert_eq!(output["wallet_sync"]["history_fresh"], true);
        assert_eq!(output["wallet_sync"]["utxos_fresh"], true);
        assert_eq!(output["wallet_sync"]["confirmed_sats"], balance);
        assert_eq!(output["header_height"], checkpoint.height);
        assert_eq!(
            output["header_commitment"],
            checkpoint
                .commitment
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }

    // The same encrypted record can resume by a saved date with an unchanged
    // chain tip. No manual height may mask provisional timestamp anchors.
    let mut dated_baseline = None;
    for (selected, shv) in [(proof_endpoint, true), (plain_endpoint, false)] {
        let (dated, driver) = runtime(directory.path());
        let opened = dated
            .wallet_security(WalletSecurityRequest::Open {
                handle: handle.clone(),
                password: secret(),
            })
            .await
            .unwrap();
        if dated_baseline.is_none() {
            dated
                .wallet_security(WalletSecurityRequest::SetBirthday {
                    epoch: opened.epoch,
                    birthday: optn_transport::WalletBirthdayInput::Time {
                        requested_time: birthday_time,
                    },
                })
                .await
                .unwrap();
            dated
                .wallet_security(WalletSecurityRequest::ClearRescan {
                    epoch: opened.epoch,
                })
                .await
                .unwrap();
        }
        assert!(!dated.state().wallet_sync.history_fresh);
        let (mut service, store, _) = stack(selected, shv).await;
        let mut headers = worker(&dated, store).await;
        let (authenticated, total) = headers.header_view().unwrap().anchor_authentication();
        assert_eq!(authenticated, 0);
        assert!(total > 0);
        let result = tokio::time::timeout(
            Duration::from_secs(120),
            dated.sync_hd_wallet(
                &mut service,
                &mut headers,
                xpub.clone(),
                HdSyncLimits {
                    gap_limit: 1,
                    addresses_per_branch: 4,
                },
            ),
        )
        .await
        .unwrap()
        .expect("date anchors must recover before resolving the wallet floor");
        assert_eq!(result, ReconciliationDecision::Accepted);
        assert_eq!(headers.header_view().unwrap().checkpoint(), checkpoint);
        assert_eq!(
            headers.header_view().unwrap().anchor_authentication(),
            (total, total)
        );
        assert!(dated.state().wallet_sync.history_fresh);
        let projection = (
            dated.state().wallet_sync.confirmed_sats.unwrap(),
            dated.state().wallet_sync.history,
        );
        if let Some(baseline) = &dated_baseline {
            assert_eq!(&projection, baseline);
        } else {
            assert!(
                projection.0 > 0 && projection.0 < balance,
                "the saved date actually changes the scan floor"
            );
            dated_baseline = Some(projection);
        }
        stop(dated, driver).await;
    }
}
