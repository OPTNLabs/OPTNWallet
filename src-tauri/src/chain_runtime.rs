#![forbid(unsafe_code)]

//! Tauri adapter for issue #75's provider-neutral chain runtime.
//!
//! Concrete protocol adapters live in `optn-chain-native`, which is deliberately
//! Tauri-free so the desktop shell and CLI build the same source/policy stack.

use crate::network_config::NetworkSettingsStore;
use optn_app::AppState;
use optn_core::endpoint::{
    parse_electrum_endpoint, parse_peer_endpoint, DEFAULT_WSS_PORT, NODE_HINT_PORT,
};
use optn_core::network::Network;
use optn_runtime::chain::{
    CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog,
    SourceDisposition, SourceId, SourceOrigin,
};
use optn_runtime::chain_service::ChainService;
use optn_runtime::AppRuntime;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

pub use optn_chain_native::{
    build_native_chain_stack, NativeChainProbeFailure, NativeChainSecrets, NativeChainStack,
};

type NativeSelection = (Network, Result<(SourceCatalog, ConnectionPolicy), String>);

/// Process-owned chain stack. Old routes are retired before replacement probes;
/// a policy change during probing cancels that build before publication.
pub struct NativeChainRuntime {
    owner: AppRuntime,
    stack: RwLock<Option<NativeChainStack>>,
    generation: AtomicU64,
    secrets: RwLock<NativeChainSecrets>,
    credential_revision: AtomicU64,
    network_settings: NetworkSettingsStore,
    rebuild_lock: Mutex<()>,
}

impl NativeChainRuntime {
    /// Create an inactive host with no published routes or supplied credentials.
    fn new(owner: AppRuntime, network_settings: NetworkSettingsStore) -> Self {
        Self {
            owner,
            stack: RwLock::new(None),
            generation: AtomicU64::new(0),
            secrets: RwLock::new(NativeChainSecrets::default()),
            credential_revision: AtomicU64::new(0),
            network_settings,
            rebuild_lock: Mutex::new(()),
        }
    }

    /// Start the process-owned worker that rebuilds routes as persisted policy
    /// or runtime selections change. No service is installed until a build finishes.
    pub fn spawn(app_runtime: AppRuntime, network_settings: NetworkSettingsStore) -> Arc<Self> {
        let native = Arc::new(Self::new(app_runtime.clone(), network_settings));
        let worker = native.clone();
        tauri::async_runtime::spawn(async move {
            worker.run().await;
        });
        native
    }

    /// Rebuild while observing selections, cancelling an in-flight build when they
    /// change. Stop when the runtime owner no longer acknowledges or publishes state.
    async fn run(&self) {
        loop {
            let selection = self.selection(&self.owner.state()).await;
            let changed = self.wait_for_selection_change(&selection);
            tokio::pin!(changed);
            tokio::select! {
                alive = self.rebuild_selection() => {
                    if !alive {
                        return;
                    }
                    if !changed.await {
                        return;
                    }
                }
                changed = &mut changed => {
                    if !changed {
                        return;
                    }
                }
            }
        }
    }

    /// Retire active sync routes before replacing credentials and rebuilding.
    /// The owner's current state selects the network; the caller snapshot is ignored.
    /// If the owner is closed, credential replacement stops after invalidation.
    pub async fn replace_secrets(&self, secrets: NativeChainSecrets, _state: &AppState) {
        // Stop callers before changing credentials or waiting on the old
        // service. Otherwise a refresh can publish a result obtained with the
        // credentials that are being replaced.
        if !self
            .invalidate_current_wallet_sync("native chain credentials changed")
            .await
        {
            return;
        }
        {
            let mut current = self.secrets.write().await;
            *current = secrets;
            self.credential_revision.fetch_add(1, Ordering::SeqCst);
        }
        self.rebuild_selection_after_invalidation("native chain credentials changed")
            .await;
    }

    /// Rebuild from the owner's latest state, ignoring potentially stale caller
    /// snapshots. Configuration and probe failures are exposed by the accessors.
    pub async fn rebuild_from_app_state(&self, _state: &AppState) {
        self.rebuild_selection().await;
    }

    /// Read persisted policy on the blocking pool without holding the stack lock.
    /// Missing files return `None`; reader or validation failures remain errors.
    async fn persisted_selection(
        &self,
        network: Network,
    ) -> Result<Option<(SourceCatalog, ConnectionPolicy)>, String> {
        let settings = self.network_settings.clone();
        tokio::task::spawn_blocking(move || settings.chain_selection(network))
            .await
            .map_err(|_| "network settings reader stopped".to_string())?
    }

    /// Resolve the snapshot's network through persisted policy, retaining read
    /// errors so invalid configuration cannot silently select a fallback route.
    async fn selection(&self, state: &AppState) -> NativeSelection {
        Self::resolve_selection(state, self.persisted_selection(state.network).await)
    }

    /// Fall back to legacy app settings only when a persisted policy is absent.
    /// Invalid persisted settings remain errors instead of enabling another route.
    fn resolve_selection(
        state: &AppState,
        persisted: Result<Option<(SourceCatalog, ConnectionPolicy)>, String>,
    ) -> NativeSelection {
        (
            state.network,
            persisted.map(|selection| {
                selection.unwrap_or_else(|| catalog_and_policy_from_app_state(state))
            }),
        )
    }

    /// Wait for an app or persisted policy change; return false when the owner closes.
    /// File changes are observed by bounded polling alongside state notifications.
    async fn wait_for_selection_change(&self, previous: &NativeSelection) -> bool {
        let mut state = self.owner.subscribe_state();
        // ponytail: bounded file polling; use native filesystem notifications
        // if sub-second cross-process settings propagation is required.
        let mut poll = tokio::time::interval(Duration::from_secs(2));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if self.selection(&self.owner.state()).await != *previous {
                return true;
            }
            tokio::select! {
                _ = poll.tick() => {},
                result = state.changed() => {
                    if result.is_err() { return false; }
                }
            }
        }
    }

    /// Cancel active wallet sync before waiting for a replacement build; return
    /// false if the owner cannot acknowledge that cancellation.
    async fn rebuild_selection(&self) -> bool {
        // This must complete before the rebuild lock or the old service mutex
        // is awaited. The owner is the actor that owns the active sync lease.
        if !self
            .invalidate_current_wallet_sync("native chain policy changed")
            .await
        {
            return false;
        }
        self.rebuild_selection_after_invalidation("native chain policy changed")
            .await
    }

    /// Revoke published routes and invalidate pending builds before cancelling the
    /// owner's sync lease. Returns false when the owner cannot acknowledge cancellation.
    async fn invalidate_current_wallet_sync(&self, reason: &str) -> bool {
        // The generation also retires an unpublished build whose stack is not
        // visible yet. Hold the read guard while revoking so a final stack
        // write cannot pass publication without observing this invalidation.
        {
            let stack = self.stack.read().await;
            self.generation.fetch_add(1, Ordering::SeqCst);
            if let Some(stack) = stack.as_ref() {
                stack.revocation.revoke();
            }
        }
        self.owner
            .invalidate_wallet_sync(reason.to_owned())
            .await
            .is_ok()
    }

    /// Serialize replacement probes and publish only while the captured network,
    /// policy, credentials, and generation remain current. Stale builds are discarded;
    /// false means the owner could not acknowledge invalidation.
    async fn rebuild_selection_after_invalidation(&self, reason: &str) -> bool {
        let _rebuild = self.rebuild_lock.lock().await;
        if !self.invalidate_current_wallet_sync(reason).await {
            return false;
        }
        let generation = self.generation.load(Ordering::SeqCst);
        // Re-read the owner's state after cancellation and lock acquisition so
        // a stale caller snapshot cannot select a different network.
        let captured_selection = self.selection(&self.owner.state()).await;
        let (network, selection) = captured_selection.clone();
        let previous = self
            .stack
            .read()
            .await
            .as_ref()
            .map(|stack| stack.service.clone());
        if let Some(previous) = previous {
            // Revoke routes even for callers holding an Arc to the old service.
            *previous.lock().await.catalog_mut() = SourceCatalog::default();
        }
        *self.stack.write().await = None;
        let (catalog, policy) = match selection {
            Ok(selection) => selection,
            Err(error) => {
                let persisted = self.persisted_selection(network).await;
                let mut stack = self.stack.write().await;
                let current = self.owner.state();
                if current.network != network
                    || Self::resolve_selection(&current, persisted) != captured_selection
                    || self.generation.load(Ordering::SeqCst) != generation
                {
                    return true;
                }
                *stack = Some(NativeChainStack::unavailable(error));
                return true;
            }
        };
        let (credential_revision, secrets) = {
            let current = self.secrets.read().await;
            (
                self.credential_revision.load(Ordering::SeqCst),
                current.clone(),
            )
        };
        let replacement =
            build_native_chain_stack(catalog, policy, &network.to_string(), &secrets).await;
        // Disk I/O must not hold the stack lock. Resolve any app-state fallback
        // from the current owner only after the read and lock acquisition.
        let persisted = self.persisted_selection(network).await;
        let mut stack = self.stack.write().await;
        let current = self.owner.state();
        if current.network != network
            || Self::resolve_selection(&current, persisted) != captured_selection
            || self.credential_revision.load(Ordering::SeqCst) != credential_revision
            || self.generation.load(Ordering::SeqCst) != generation
        {
            return true;
        }
        *stack = Some(replacement);
        true
    }

    /// Invoke a synchronous callback with the current service handle under the
    /// stack read lock. Returns `None` during replacement; retained handles can
    /// subsequently be revoked by a policy or credential change.
    pub async fn with_service<T>(
        &self,
        f: impl FnOnce(&Arc<Mutex<ChainService>>) -> T,
    ) -> Option<T> {
        let guard = self.stack.read().await;
        guard.as_ref().map(|stack| f(&stack.service))
    }

    /// Snapshot probe failures from the installed stack. An empty result also
    /// covers an absent stack and must not be treated as proof of connectivity.
    pub async fn failures(&self) -> Vec<NativeChainProbeFailure> {
        self.stack
            .read()
            .await
            .as_ref()
            .map(|stack| stack.failures.clone())
            .unwrap_or_default()
    }

    /// Return the installed stack's configuration error, if any. An absent
    /// stack returns `None` even though a replacement may still be pending.
    pub async fn configuration_error(&self) -> Option<String> {
        self.stack
            .read()
            .await
            .as_ref()
            .and_then(|stack| stack.configuration_error.clone())
    }
}
/// Compatibility bridge from the existing app-wide server settings into the
/// richer source catalog. Endpoints sharing a host are grouped into one source,
/// so a user-run node+Fulcrum installation naturally appears as one combined
/// source without inventing a generic "Home Server" name.
pub fn catalog_and_policy_from_app_state(state: &AppState) -> (SourceCatalog, ConnectionPolicy) {
    let mut by_host = BTreeMap::<String, ChainSource>::new();
    let network_servers = state.servers.for_network(state.network);

    // A legacy default is not yet a durable source-catalog choice. Do not open
    // a native provider connection until the user has explicitly configured a
    // route; bootstrap selection belongs to the persisted policy overlay.
    if let Some(electrum_entry) = network_servers.electrum.as_deref() {
        if let Ok(parsed) = parse_electrum_endpoint(electrum_entry, DEFAULT_WSS_PORT) {
            upsert_user_source(
                &mut by_host,
                parsed.host(),
                Endpoint {
                    kind: if parsed.encrypted() {
                        EndpointKind::ElectrumTls
                    } else {
                        EndpointKind::ElectrumTcp
                    },
                    host: parsed.host().to_owned(),
                    port: Some(parsed.port()),
                },
            );
        }
    }

    if let Some(peer_entry) = network_servers.peer.as_deref() {
        if let Ok(parsed) = parse_peer_endpoint(peer_entry, NODE_HINT_PORT) {
            upsert_user_source(
                &mut by_host,
                parsed.host(),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: parsed.host().to_owned(),
                    port: Some(parsed.port()),
                },
            );
        }
    }

    let mut catalog = SourceCatalog::default();
    for source in by_host.into_values() {
        // IDs are produced from unique normalized hosts, so duplicate insertion
        // is an internal bug rather than a user-facing condition.
        catalog
            .insert(source)
            .expect("host-grouped source ids are unique");
    }
    (catalog, ConnectionPolicy::auto())
}

/// Group endpoints by normalized host, deduplicating exact endpoints while
/// retaining the first label. Capabilities remain unproven until discovery.
fn upsert_user_source(by_host: &mut BTreeMap<String, ChainSource>, host: &str, endpoint: Endpoint) {
    let key = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let entry = by_host.entry(key.clone()).or_insert_with(|| ChainSource {
        id: SourceId::new(format!("host:{key}")),
        label: host.to_owned(),
        origin: SourceOrigin::UserAdded,
        endpoints: Vec::new(),
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority: 0,
    });
    if !entry.endpoints.contains(&endpoint) {
        entry.endpoints.push(endpoint);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppAction, AppState, OpenedWallet, ServerKind, WalletKind};
    use optn_core::network::Network;
    use optn_runtime::chain::{
        build_selection_plan, Capability, CapabilityConfidence, CapabilityDiscovery,
        ProtocolFamily, ProviderHealth,
    };
    use optn_runtime::chain_service::{
        BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation,
        ChainRequest,
    };
    use optn_runtime::hd_sync::HdSyncLimits;
    use optn_runtime::sync_worker::ProgressiveSyncWorker;
    use optn_runtime::wallet_sync::WalletSyncError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn test_directory(label: &str) -> std::path::PathBuf {
        static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Windows wall-clock timestamps can repeat across concurrent tests.
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "optn-{label}-{}-{time}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn queued_settings_read_keeps_executor_and_stack_available() {
        use std::{
            future::{poll_fn, Future},
            task::Poll,
        };
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        executor.block_on(async {
            let directory = test_directory("queued-settings");
            assert!(!directory.exists()); // Missing config: no filesystem mutations or network probes.
            let runtime = AppRuntime::spawn(AppState::default());
            let native = Arc::new(NativeChainRuntime::new(
                runtime.clone(),
                NetworkSettingsStore::new(directory),
            ));
            let (release, held) = std::sync::mpsc::channel::<()>();
            let (entered, started) = tokio::sync::oneshot::channel();
            let blocking = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                let _ = held.recv(); // Dropping release also unblocks on assertion failure.
            });
            started.await.unwrap();
            let initial = AppState::default();
            let mut rebuilding = Box::pin(native.rebuild_from_app_state(&initial));
            tokio::time::timeout(Duration::from_secs(2), async {
                while native.generation.load(Ordering::SeqCst) < 2 {
                    assert!(poll_fn(|cx| Poll::Ready(rebuilding.as_mut().poll(cx)))
                        .await
                        .is_pending());
                    runtime.dispatch(AppAction::ClearNotice).await.unwrap();
                }
                // Consume the invalidation reply and drive exactly to the queued
                // settings read before changing the network. No scheduling sleeps.
                runtime.dispatch(AppAction::ClearNotice).await.unwrap();
                assert!(
                    poll_fn(|cx| Poll::Ready(rebuilding.as_mut().poll(cx)))
                        .await
                        .is_pending(),
                    "settings I/O must await the blocking pool"
                );
                assert!(native.with_service(Arc::clone).await.is_none());
                assert!(native.configuration_error().await.is_none());
                // A policy change while disk I/O waits must invalidate publication.
                runtime
                    .dispatch(AppAction::SetNetwork(Network::Chipnet))
                    .await
                    .unwrap();
            })
            .await
            .unwrap();
            drop(release);
            blocking.await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), rebuilding)
                .await
                .unwrap();
            assert!(
                native.with_service(Arc::clone).await.is_none(),
                "old network must not publish after the asynchronous read"
            );
            native.rebuild_from_app_state(&AppState::default()).await;
            assert!(native.with_service(Arc::clone).await.is_some());
            assert_eq!(native.selection(&runtime.state()).await.0, Network::Chipnet);
        });
    }

    struct PendingWalletBackend {
        source: SourceId,
        endpoint: Endpoint,
        capabilities: CapabilitySet,
        started: Arc<Notify>,
        calls: Arc<AtomicUsize>,
    }

    impl ChainBackend for PendingWalletBackend {
        fn source_id(&self) -> &SourceId {
            &self.source
        }

        fn protocol(&self) -> ProtocolFamily {
            ProtocolFamily::Electrum
        }

        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }

        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }

        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }

        fn supports(&self, operation: ChainOperation) -> bool {
            operation == ChainOperation::WalletRefresh
        }

        fn execute<'a>(
            &'a self,
            _request: &'a ChainRequest,
        ) -> ChainFuture<'a, BackendObservation> {
            let started = Arc::clone(&self.started);
            let calls = Arc::clone(&self.calls);
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                std::future::pending::<Result<BackendObservation, ChainBackendError>>().await
            })
        }
    }

    struct PendingHdRefresh {
        native: Arc<NativeChainRuntime>,
        runtime: AppRuntime,
        settings_directory: std::path::PathBuf,
        old_service: Arc<Mutex<ChainService>>,
        xpub: String,
        calls: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<
            Result<optn_runtime::reconciliation::ReconciliationDecision, WalletSyncError>,
        >,
    }

    struct PendingNativeProbe {
        native: Arc<NativeChainRuntime>,
        runtime: AppRuntime,
        directory: std::path::PathBuf,
        driver: tokio::task::JoinHandle<()>,
        listener: tokio::net::TcpListener,
        socket: tokio::net::TcpStream,
        task: tokio::task::JoinHandle<()>,
    }

    async fn pending_native_probe() -> PendingNativeProbe {
        use optn_chain_native::network_config::NetworkConfigFile;
        use optn_runtime::network_config::{
            NetworkConfigEnvelope, NetworkConfigStore, UserNetworkOverlay,
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local probe listener");
        let port = listener
            .local_addr()
            .expect("local probe listener address")
            .port();
        let directory = test_directory("native-selection");
        std::fs::create_dir(&directory).expect("test probe directory");
        let path = directory.join("network-mainnet.json");
        let source = ChainSource {
            id: SourceId::new("pending-native-probe"),
            label: "Pending native probe".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        NetworkConfigFile::new(path)
            .store_atomic(&NetworkConfigEnvelope::current(
                "test",
                UserNetworkOverlay {
                    user_sources: vec![source],
                    ..Default::default()
                },
            ))
            .expect("store pending probe selection");

        let (runtime, driver) = AppRuntime::new(AppState::default());
        let driver = tokio::spawn(driver.run());
        let native = Arc::new(NativeChainRuntime::new(
            runtime.clone(),
            NetworkSettingsStore::new(directory.clone()),
        ));
        let rebuild_native = native.clone();
        let task = tokio::spawn(async move {
            rebuild_native
                .rebuild_from_app_state(&AppState::default())
                .await;
        });
        let (socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("native probe reached local listener")
            .expect("accept pending native probe");

        PendingNativeProbe {
            native,
            runtime,
            directory,
            driver,
            listener,
            socket,
            task,
        }
    }

    async fn pending_hd_refresh() -> PendingHdRefresh {
        // This is the published BIP39 test vector, used only to derive public
        // test material for the shared HD path.
        let public_wallet =
            optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
                .expect("published BIP39 test vector");
        let xpub = public_wallet
            .account_xpub(Network::Chipnet, 0)
            .expect("public account xpub");
        let receive = optn_core::watch_only::address_under_account(Network::Chipnet, &xpub, 0, 0)
            .expect("public receive address")
            .address;

        let runtime = AppRuntime::spawn(AppState {
            network: Network::Chipnet,
            wallet: Some(OpenedWallet {
                kind: WalletKind::WatchOnly,
                name: "public HD cancellation test".into(),
                receive_address: receive,
                master_fingerprint: None,
                account_path: "m/44'/1'/0'".into(),
                multisig_policy: None,
                account_xpub: Some(xpub.clone()),
            }),
            ..Default::default()
        });
        let settings_directory = test_directory("native-refresh-cancel");
        std::fs::create_dir(&settings_directory).expect("test settings directory");
        let native = Arc::new(NativeChainRuntime::new(
            runtime.clone(),
            NetworkSettingsStore::new(settings_directory.clone()),
        ));

        let source = SourceId::new("pending-refresh");
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "pending.test".into(),
            port: Some(50001),
        };
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::UtxoQuery,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ExplicitConfiguration,
        );
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: source.clone(),
                label: "Pending test source".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![endpoint.clone()],
                capabilities: capabilities.clone(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .expect("unique pending source");
        let started = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(Arc::new(PendingWalletBackend {
            source,
            endpoint,
            capabilities,
            started: Arc::clone(&started),
            calls: Arc::clone(&calls),
        }));
        let revocation = service.revocation();
        let service = Arc::new(Mutex::new(service));
        native.stack.write().await.replace(NativeChainStack {
            revocation,
            service: service.clone(),
            event_sources: Vec::new(),
            failures: Vec::new(),
            configuration_error: None,
        });

        let old_service = service.clone();
        let refresh_runtime = runtime.clone();
        let refresh_xpub = xpub.clone();
        let task = tokio::spawn(async move {
            let mut worker = ProgressiveSyncWorker::new(Default::default());
            let mut service = old_service.lock().await;
            refresh_runtime
                .sync_hd_wallet(
                    &mut service,
                    &mut worker,
                    refresh_xpub,
                    HdSyncLimits::default(),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("shared HD refresh reached the pending provider");
        assert!(service.try_lock().is_err(), "refresh must hold old service");

        PendingHdRefresh {
            native,
            runtime,
            settings_directory,
            old_service: service,
            xpub,
            calls,
            task,
        }
    }

    async fn assert_cancelled(refresh: PendingHdRefresh, reason: &str) {
        let PendingHdRefresh {
            native: _native,
            runtime,
            settings_directory,
            old_service: _old_service,
            xpub: _xpub,
            calls: _calls,
            task,
        } = refresh;
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("policy change must release the pending refresh")
            .expect("refresh task must not panic");
        assert!(matches!(result, Err(WalletSyncError::Superseded)));
        assert!(
            runtime.state().coins.is_empty(),
            "stale refresh was published"
        );
        let status = runtime.subscribe_wallet_sync();
        assert!(!status.borrow().sync.history_fresh);
        assert!(!status.borrow().sync.utxos_fresh);
        assert_eq!(
            status.borrow().sync.degraded_reason.as_deref(),
            Some(reason)
        );
        let network_config = settings_directory.join("network-chipnet.json");
        let _ = std::fs::remove_file(&network_config);
        let _ = std::fs::remove_file(network_config.with_extension("lock"));
        std::fs::remove_dir(settings_directory).expect("remove test settings directory");
    }

    #[tokio::test]
    async fn external_policy_reload_cancels_pending_shared_hd_refresh() {
        use optn_chain_native::network_config::NetworkConfigFile;
        use optn_runtime::network_config::{
            NetworkConfigEnvelope, NetworkConfigStore, UserNetworkOverlay,
        };

        let refresh = pending_hd_refresh().await;
        let policy = ConnectionPolicy::own_infrastructure();
        NetworkConfigFile::new(refresh.settings_directory.join("network-chipnet.json"))
            .store_atomic(&NetworkConfigEnvelope::current(
                "test",
                UserNetworkOverlay {
                    connection_policy: policy.clone(),
                    ..Default::default()
                },
            ))
            .expect("store external policy");
        let stale_state = AppState {
            network: Network::Mainnet,
            ..Default::default()
        };
        refresh.native.rebuild_from_app_state(&stale_state).await;

        let service = refresh
            .native
            .with_service(Arc::clone)
            .await
            .expect("replacement service");
        assert_eq!(service.lock().await.policy(), &policy);
        assert_cancelled(refresh, "native chain policy changed").await;
    }

    #[tokio::test]
    async fn secrets_reload_cancels_pending_shared_hd_refresh() {
        let refresh = pending_hd_refresh().await;
        let mut secrets = NativeChainSecrets::default();
        secrets.set_rpc_txindex(&SourceId::new("pending-refresh"), true);
        refresh
            .native
            .replace_secrets(secrets, &AppState::default())
            .await;
        assert_cancelled(refresh, "native chain credentials changed").await;
    }

    #[tokio::test]
    async fn revoked_old_service_arc_cannot_start_during_held_rebuild_lock() {
        let mut refresh = pending_hd_refresh().await;
        let rebuild_guard = refresh.native.rebuild_lock.lock().await;
        let rebuild_native = refresh.native.clone();
        let rebuild = tokio::spawn(async move {
            rebuild_native
                .rebuild_from_app_state(&AppState::default())
                .await;
        });

        let first = tokio::time::timeout(Duration::from_secs(2), &mut refresh.task)
            .await
            .expect("owner invalidation must release the pending refresh")
            .expect("first refresh task must not panic");
        assert!(matches!(first, Err(WalletSyncError::Superseded)));
        let old_revocation = refresh.old_service.lock().await.revocation();
        assert!(
            old_revocation.is_revoked(),
            "old service must be revoked before rebuild waits"
        );

        let old_service = refresh.old_service.clone();
        let second_runtime = refresh.runtime.clone();
        let second_xpub = refresh.xpub.clone();
        let mut second = tokio::spawn(async move {
            let mut worker = ProgressiveSyncWorker::new(Default::default());
            let mut service = old_service.lock().await;
            second_runtime
                .sync_hd_wallet(
                    &mut service,
                    &mut worker,
                    second_xpub,
                    HdSyncLimits::default(),
                )
                .await
        });
        let second_result = tokio::time::timeout(Duration::from_secs(2), &mut second)
            .await
            .expect("revoked old service must reject fresh work")
            .expect("second refresh task must not panic");
        assert!(matches!(second_result, Err(WalletSyncError::Superseded)));
        assert_eq!(
            refresh.calls.load(Ordering::SeqCst),
            1,
            "revoked old service must not start another provider call"
        );
        assert!(
            refresh.runtime.state().coins.is_empty(),
            "revoked old service published stale coins"
        );
        assert!(
            refresh
                .runtime
                .subscribe_wallet_sync()
                .borrow()
                .authoritative
                .is_none(),
            "revoked old service published an authoritative snapshot"
        );

        drop(rebuild_guard);
        tokio::time::timeout(Duration::from_secs(2), rebuild)
            .await
            .expect("rebuild must finish after the lock is released")
            .expect("rebuild task must not panic");
        assert_eq!(
            refresh.old_service.lock().await.catalog().iter().count(),
            0,
            "old service catalog must be cleared during rebuild"
        );

        let network_config = refresh.settings_directory.join("network-chipnet.json");
        let _ = std::fs::remove_file(&network_config);
        let _ = std::fs::remove_file(network_config.with_extension("lock"));
        std::fs::remove_dir(refresh.settings_directory).expect("remove test settings directory");
    }

    #[tokio::test]
    async fn same_selection_reload_does_not_publish_a_superseded_probe() {
        let PendingNativeProbe {
            native,
            runtime: _runtime,
            directory,
            driver,
            listener,
            socket,
            task,
        } = pending_native_probe().await;
        let second_native = native.clone();
        let second = tokio::spawn(async move {
            second_native
                .rebuild_from_app_state(&AppState::default())
                .await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if native.generation.load(Ordering::SeqCst) >= 2 {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("same-selection reload must invalidate the pending probe");
        // Keep the second rebuild from reaching its post-lock work; the first
        // build must be rejected solely by the generation change.
        tokio::time::sleep(Duration::from_millis(10)).await;
        driver.abort();
        let _ = driver.await;
        drop(socket);
        drop(listener);

        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("superseded probe must finish")
            .expect("superseded probe task must not panic");
        tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .expect("same-selection rebuild must finish after owner close")
            .expect("same-selection rebuild task must not panic");
        assert!(
            native.stack.read().await.is_none(),
            "same-selection invalidation allowed the old probe to publish"
        );

        let network_config = directory.join("network-mainnet.json");
        let _ = std::fs::remove_file(&network_config);
        let _ = std::fs::remove_file(network_config.with_extension("lock"));
        std::fs::remove_dir(directory).expect("remove test probe directory");
    }

    #[tokio::test]
    async fn credential_reload_during_probe_does_not_publish_old_credentials() {
        let PendingNativeProbe {
            native,
            runtime: _runtime,
            directory,
            driver,
            listener,
            socket,
            task,
        } = pending_native_probe().await;
        let replacement_native = native.clone();
        let mut secrets = NativeChainSecrets::default();
        secrets.set_rpc_txindex(&SourceId::new("pending-native-probe"), true);
        let replacement = tokio::spawn(async move {
            replacement_native
                .replace_secrets(secrets, &AppState::default())
                .await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if native.credential_revision.load(Ordering::SeqCst) == 1 {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("credential reload must advance its revision");
        driver.abort();
        let _ = driver.await;
        drop(socket);
        drop(listener);

        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("credential-superseded probe must finish")
            .expect("credential-superseded probe task must not panic");
        assert!(
            native.stack.read().await.is_none(),
            "credential-superseded probe published an old stack"
        );
        tokio::time::timeout(Duration::from_secs(2), replacement)
            .await
            .expect("closed owner must stop the replacement rebuild")
            .expect("replacement task must not panic");

        let network_config = directory.join("network-mainnet.json");
        let _ = std::fs::remove_file(&network_config);
        let _ = std::fs::remove_file(network_config.with_extension("lock"));
        std::fs::remove_dir(directory).expect("remove test probe directory");
    }

    async fn wait_for_policy(native: &NativeChainRuntime, policy: &ConnectionPolicy) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(service) = native.with_service(Arc::clone).await {
                    if service.lock().await.policy() == policy
                        && native.configuration_error().await.is_none()
                    {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("host applies policy without restart");
    }

    #[tokio::test]
    async fn policy_change_cancels_an_unfinished_local_probe() {
        use optn_chain_native::network_config::NetworkConfigFile;
        use optn_runtime::network_config::{
            NetworkConfigEnvelope, NetworkConfigStore, UserNetworkOverlay,
        };
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = test_directory("probe-cancel");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("network-mainnet.json");
        let file = NetworkConfigFile::new(path.clone());
        let source = ChainSource {
            id: SourceId::new("local-test"),
            label: "Local test".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        file.store_atomic(&NetworkConfigEnvelope::current(
            "test",
            UserNetworkOverlay {
                user_sources: vec![source],
                ..Default::default()
            },
        ))
        .unwrap();
        let runtime = AppRuntime::spawn(AppState::default());
        let native = Arc::new(NativeChainRuntime::new(
            runtime.clone(),
            NetworkSettingsStore::new(directory.clone()),
        ));
        let worker = native.clone();
        let task = tokio::spawn(async move { worker.run().await });
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        // Keep the server handshake unanswered while replacing the source policy.
        file.store_atomic(&NetworkConfigEnvelope::current(
            "test",
            UserNetworkOverlay {
                connection_policy: ConnectionPolicy::own_infrastructure(),
                ..Default::default()
            },
        ))
        .unwrap();
        wait_for_policy(&native, &ConnectionPolicy::own_infrastructure()).await;
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes))
            .await
            .expect("cancelled probe closes its socket")
            .unwrap();
        assert_eq!(
            native
                .with_service(Arc::clone)
                .await
                .unwrap()
                .lock()
                .await
                .catalog()
                .iter()
                .count(),
            0
        );
        task.abort();
        let _ = task.await;
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(path.with_extension("lock")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    async fn running_host_reloads_external_policy_and_recovers_from_corruption() {
        use optn_chain_native::network_config::NetworkConfigFile;
        use optn_runtime::network_config::{
            NetworkConfigEnvelope, NetworkConfigStore, UserNetworkOverlay,
        };
        let directory = test_directory("host-policy");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("network-mainnet.json");
        let file = NetworkConfigFile::new(path.clone());
        let settings = NetworkSettingsStore::new(directory.clone());
        let runtime = AppRuntime::spawn(AppState::default());
        let native = Arc::new(NativeChainRuntime::new(runtime.clone(), settings));
        let worker = native.clone();
        let task = tokio::spawn(async move { worker.run().await });
        wait_for_policy(&native, &ConnectionPolicy::auto()).await;
        let previous = native.with_service(Arc::clone).await.unwrap();
        let mut state = AppState::default();
        state.apply(AppAction::SetServer {
            kind: ServerKind::Peer,
            entry: "unused.invalid:8333".into(),
        });
        // Register catalog data only: this test never creates a network adapter.
        *previous.lock().await.catalog_mut() = catalog_and_policy_from_app_state(&state).0;

        let policy = ConnectionPolicy::own_infrastructure();
        file.store_atomic(&NetworkConfigEnvelope::current(
            "test",
            UserNetworkOverlay {
                connection_policy: policy.clone(),
                ..Default::default()
            },
        ))
        .unwrap();
        wait_for_policy(&native, &policy).await;
        assert_eq!(previous.lock().await.catalog().iter().count(), 0);

        std::fs::write(&path, b"{").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while native.configuration_error().await.is_none() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("corrupt configuration disables the stack");
        let recovered = NetworkConfigEnvelope::current("test", UserNetworkOverlay::default());
        // External repair of the deliberately corrupt file.
        std::fs::write(
            &path,
            optn_runtime::network_config::encode_envelope_json(&recovered).unwrap(),
        )
        .unwrap();
        wait_for_policy(&native, &ConnectionPolicy::auto()).await;
        task.abort();
        let _ = task.await;
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(path.with_extension("lock")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn same_host_node_and_electrum_are_one_source_with_independent_routes() {
        let mut state = AppState::default();
        state.network = Network::Mainnet;
        state.apply(AppAction::SetServer {
            kind: ServerKind::Electrum,
            entry: "box.example:50002".into(),
        });
        state.apply(AppAction::SetServer {
            kind: ServerKind::Peer,
            entry: "box.example:8333".into(),
        });
        let (catalog, _) = catalog_and_policy_from_app_state(&state);
        let sources = catalog.iter().collect::<Vec<_>>();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].label, "box.example");
        assert!(sources[0]
            .endpoints
            .iter()
            .any(|endpoint| endpoint.kind == EndpointKind::ElectrumTls));
        assert!(sources[0]
            .endpoints
            .iter()
            .any(|endpoint| endpoint.kind == EndpointKind::BchP2p));
    }

    #[test]
    fn default_state_has_no_native_route_before_a_source_is_configured() {
        let state = AppState::default();
        let (catalog, policy) = catalog_and_policy_from_app_state(&state);
        assert!(catalog.iter().next().is_none());
        assert!(build_selection_plan(&catalog, &policy).primary.is_empty());
    }
}
