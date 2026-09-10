#![forbid(unsafe_code)]

//! Framework-neutral runtime for OPTN application state.
//!
//! Long-lived native work should live behind typed runtime/services rather than
//! inside Leptos signals or Tauri commands. The runtime owns authoritative
//! application state, receives typed actions, and publishes typed events.
//!
//! The runtime does not choose an executor for the host. `AppRuntime::new`
//! returns a driver future which Tauri, tests, or another shell can spawn.

/// Provider-neutral SHV/MMR header verification using the pure optn-core accumulator.
pub mod authchain;
/// Provenance-preserving normalization of upstream node/server bootstrap feeds.
pub mod bootstrap;
/// Provider-neutral direct-vs-derived planning for token/BCMR operations.
pub mod capability_planner;
/// Provider-neutral BCH chain-source, capability, policy, sync, and evidence
/// scaffolding. The canonical architecture is tracked in OPTNLabs/OPTNWallet#75.
pub mod chain;
/// Runtime-owned operation-aware provider selection and bounded failover.
pub mod chain_service;
/// Query-before-apply gate for lossy event-stream sequence gaps.
pub mod event_recovery;
/// Provider-neutral normalized chain event streams. Event delivery is never
/// treated as proof and sequence gaps are preserved for recovery.
pub mod events;
/// Explorer routing is deliberately separate from wallet consensus/state.
pub mod explorer;
/// Public-key HD account discovery over the shared chain service.
pub mod hd_sync;
pub mod header_recovery;
pub mod header_store;
pub mod header_verifier;
pub mod header_view;
/// Versioned user-network overlay and bootstrap-refresh migration scaffolding.
pub mod network_config;
/// Evidence-aware wallet-state reconciliation. Partial/failed providers never
/// erase a previously known-good snapshot.
pub mod reconciliation;
/// Progressive capability-route wallet synchronization.
pub mod sync_worker;
/// Broadcast state tracking. Timeout/offline ambiguity is preserved rather than
/// collapsed into a false deterministic failure.
pub mod token_capability;
pub mod token_metadata;
pub mod tx_broadcast;
/// Framework-neutral authenticated wallet-update state/provider scaffolding.
pub mod update;
pub mod wallet_birthday;
/// Authenticated HD restart state; storage never grants unlock or spend authority.
pub mod wallet_checkpoint;
/// Private ciphertext sessions and password verification shared by native hosts.
pub mod wallet_security;
/// Session-bound publication of provider observations into application state.
pub mod wallet_sync;

use optn_app::{AppAction, AppEvent, AppState};
use optn_transport::{
    AppTransport, TransportError, TransportFuture, WalletSecurityRequest, WalletSecurityStatus,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};
use wallet_sync::{WalletSyncRequest, WalletSyncSession};

const ACTION_CAPACITY: usize = 128;
const EVENT_CAPACITY: usize = 128;

/// Recheck after synchronous native storage: cancellation and time can advance
/// even though the actor has not processed another request.
struct PublicationGuard<'a> {
    generation: u64,
    revocation: &'a AtomicU64,
    now_ms: &'a dyn Fn() -> u64,
}

impl PublicationGuard<'_> {
    fn allows(&self, state: &AppState, reply_closed: bool) -> bool {
        !reply_closed
            && self.generation == self.revocation.load(Ordering::SeqCst)
            && !state.lock.idle_should_lock((self.now_ms)())
    }
}

fn elapsed_ms(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis())
        .unwrap_or(u64::MAX)
        .saturating_add(1)
}

/// The runtime driver is no longer running, so the action was not applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeStopped;

impl std::fmt::Display for RuntimeStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "application runtime is closed")
    }
}

impl std::error::Error for RuntimeStopped {}

#[derive(Clone)]
pub struct AppRuntime {
    action_tx: mpsc::Sender<RuntimeRequest>,
    state_rx: watch::Receiver<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
    revocation: Arc<AtomicU64>,
    wallet_sync_rx: watch::Receiver<wallet_sync::WalletReconciliation>,
}

enum RuntimeRequest {
    WalletSync(WalletSyncRequest),
    WalletOperation(
        optn_app::AuthScope,
        u64,
        oneshot::Sender<Result<optn_core::hd::Wallet, TransportError>>,
    ),
    Action(AppAction, oneshot::Sender<()>),
    Security(
        WalletSecurityRequest,
        u64,
        oneshot::Sender<Result<WalletSecurityStatus, TransportError>>,
    ),
}

pub struct AppRuntimeDriver {
    action_rx: mpsc::Receiver<RuntimeRequest>,
    state_tx: watch::Sender<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
    state: AppState,
    wallet_sync: WalletSyncSession,
    security: Option<wallet_security::WalletSecurity>,
    revocation: Arc<AtomicU64>,
    started: std::time::Instant,
}

/// Zero-IPC transport for renderers hosted in the same Rust process.
pub struct DirectTransport {
    runtime: AppRuntime,
    events: Mutex<broadcast::Receiver<AppEvent>>,
}

impl DirectTransport {
    pub fn new(runtime: AppRuntime) -> Self {
        let events = runtime.subscribe_events();
        Self {
            runtime,
            events: Mutex::new(events),
        }
    }
}

impl AppTransport for DirectTransport {
    fn wallet_security<'a>(
        &'a self,
        request: WalletSecurityRequest,
    ) -> TransportFuture<'a, WalletSecurityStatus> {
        Box::pin(async move { self.runtime.wallet_security(request).await })
    }
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            self.runtime
                .dispatch(action)
                .await
                .map_err(|_| TransportError::Closed)
        })
    }

    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
        Box::pin(async move { Ok(self.runtime.state()) })
    }

    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
        Box::pin(async move {
            let mut events = self.events.lock().await;
            loop {
                match events.recv().await {
                    Ok(event) => return Ok(Some(event)),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return Ok(None),
                }
            }
        })
    }
}

impl AppRuntime {
    /// Trusted native caller only. No corresponding wire or renderer command exists.
    pub async fn wallet_for_operation(
        &self,
        scope: optn_app::AuthScope,
    ) -> Result<optn_core::hd::Wallet, TransportError> {
        let (tx, rx) = oneshot::channel();
        let generation = self.revocation.load(Ordering::SeqCst);
        self.action_tx
            .send(RuntimeRequest::WalletOperation(scope, generation, tx))
            .await
            .map_err(|_| TransportError::Closed)?;
        rx.await.map_err(|_| TransportError::Closed)?
    }
    /// Construct the runtime plus its executor-agnostic driver.
    pub fn new(initial_state: AppState) -> (Self, AppRuntimeDriver) {
        let (action_tx, action_rx) = mpsc::channel(ACTION_CAPACITY);
        let (state_tx, state_rx) = watch::channel(initial_state.clone());
        let (event_tx, _) = broadcast::channel(EVENT_CAPACITY);
        let revocation = Arc::new(AtomicU64::new(0));
        let (wallet_sync, wallet_sync_rx) = WalletSyncSession::new();

        (
            Self {
                action_tx,
                state_rx,
                event_tx: event_tx.clone(),
                revocation: Arc::clone(&revocation),
                wallet_sync_rx,
            },
            AppRuntimeDriver {
                action_rx,
                state_tx,
                event_tx,
                state: initial_state,
                wallet_sync,
                security: None,
                revocation,
                started: std::time::Instant::now(),
            },
        )
    }

    /// Convenience for hosts already running inside Tokio.
    pub fn spawn(initial_state: AppState) -> Self {
        let (runtime, driver) = Self::new(initial_state);
        tokio::spawn(driver.run());
        runtime
    }

    pub async fn dispatch(&self, action: AppAction) -> Result<(), RuntimeStopped> {
        if matches!(action, AppAction::ConfirmAuth { .. }) {
            return Err(RuntimeStopped);
        }
        if matches!(
            action,
            AppAction::LockWallet
                | AppAction::CancelAuth
                | AppAction::GoBack
                | AppAction::SetNetwork(_)
        ) {
            self.revocation.fetch_add(1, Ordering::SeqCst);
        }
        let (applied_tx, applied_rx) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::Action(action, applied_tx))
            .await
            .map_err(|_| RuntimeStopped)?;
        applied_rx.await.map_err(|_| RuntimeStopped)
    }

    pub fn new_with_security(
        mut state: AppState,
        security: wallet_security::WalletSecurity,
    ) -> Result<(Self, AppRuntimeDriver), TransportError> {
        security.restore_policy(&mut state)?;
        let (runtime, mut driver) = Self::new(state);
        driver.security = Some(security);
        Ok((runtime, driver))
    }

    pub async fn wallet_security(
        &self,
        request: WalletSecurityRequest,
    ) -> Result<WalletSecurityStatus, TransportError> {
        let generation = self.revocation.load(Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::Security(request, generation, tx))
            .await
            .map_err(|_| TransportError::Closed)?;
        rx.await.map_err(|_| TransportError::Closed)?
    }

    pub fn state(&self) -> AppState {
        self.state_rx.borrow().clone()
    }
    pub fn subscribe_state(&self) -> watch::Receiver<AppState> {
        self.state_rx.clone()
    }
    pub fn subscribe_events(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
    }
}

fn publish_state(state: &mut AppState, state_tx: &watch::Sender<AppState>) {
    state.snapshot_revision = state.snapshot_revision.saturating_add(1);
    state_tx.send_replace(state.clone());
}

impl AppRuntimeDriver {
    fn now_ms(&self) -> u64 {
        elapsed_ms(self.started)
    }

    fn publish(&mut self, event: AppEvent) {
        self.wallet_sync.on_event(&event);
        if event == AppEvent::WalletOpened {
            if let Some(checkpoint) = self
                .security
                .as_mut()
                .and_then(|security| security.take_restored_checkpoint())
            {
                self.wallet_sync
                    .install_checkpoint(checkpoint, &mut self.state);
            }
        }
        if !self.wallet_sync.coins_are_fresh() {
            self.state.spend = None;
        }
        if let Some(security) = &mut self.security {
            security.reconcile(&self.state);
        }
        self.wallet_sync.project_status(&mut self.state);
        publish_state(&mut self.state, &self.state_tx);
        let _ = self.event_tx.send(event);
    }

    fn expire_session(&mut self) {
        if let Some(event) = self.state.reduce(AppAction::IdleCheck {
            now_ms: self.now_ms(),
        }) {
            self.revocation.fetch_add(1, Ordering::SeqCst);
            self.publish(event);
        }
    }

    pub async fn run(mut self) {
        let mut idle_tick = tokio::time::interval(std::time::Duration::from_secs(1));
        idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let request = tokio::select! {
                _ = self.wallet_sync.wait_for_abandonment() => {
                    self.wallet_sync.cancel_abandoned();
                    self.wallet_sync.project_status(&mut self.state);
                    publish_state(&mut self.state, &self.state_tx);
                    continue;
                }
                request = self.action_rx.recv() => match request { Some(request) => request, None => break },
                _ = idle_tick.tick() => { self.expire_session(); continue; }
            };
            self.expire_session();
            let now_ms = self.now_ms();
            match request {
                RuntimeRequest::WalletSync(request) => {
                    self.wallet_sync.handle(
                        request,
                        &mut self.state,
                        &self.state_tx,
                        &self.event_tx,
                        self.security.as_mut(),
                        PublicationGuard {
                            generation: self.revocation.load(Ordering::SeqCst),
                            revocation: &self.revocation,
                            now_ms: &|| elapsed_ms(self.started),
                        },
                    );
                    self.expire_session();
                }
                RuntimeRequest::WalletOperation(scope, generation, reply) => {
                    if reply.is_closed() {
                        continue;
                    }
                    let result = match &self.security {
                        Some(_) if self.wallet_sync.requires_fresh_coins_for(scope) => {
                            self.state.spend = None;
                            Err(TransportError::Other(
                                "Refresh the wallet before preparing or authorizing a spend."
                                    .into(),
                            ))
                        }
                        Some(security) if generation == self.revocation.load(Ordering::SeqCst) => {
                            security.wallet_for_operation(&mut self.state, scope, now_ms)
                        }
                        _ => Err(TransportError::Unsupported),
                    };
                    self.expire_session();
                    let result = if generation == self.revocation.load(Ordering::SeqCst) {
                        result
                    } else {
                        Err(TransportError::Other(
                            "Wallet operation was cancelled.".into(),
                        ))
                    };
                    self.wallet_sync.project_status(&mut self.state);
                    publish_state(&mut self.state, &self.state_tx);
                    let _ = reply.send(result);
                }
                RuntimeRequest::Security(request, generation, reply) => {
                    if reply.is_closed() {
                        continue;
                    }
                    let is_query = matches!(request, WalletSecurityRequest::Status);
                    let opens_wallet = matches!(
                        request,
                        WalletSecurityRequest::Open { .. }
                            | WalletSecurityRequest::Create { .. }
                            | WalletSecurityRequest::UnlockBiometric { .. }
                    );
                    let authenticates =
                        matches!(request, WalletSecurityRequest::Authenticate { .. });
                    let approves_spend =
                        authenticates && self.state.lock.prompt == Some(optn_app::AuthScope::Spend);
                    let previous_epoch = self.state.lock.unlock_epoch;
                    let previous_allocation = self.state.hd_addresses.clone();
                    let previous_lock = self.state.lock.clone();
                    let mut candidate = self.state.clone();
                    let result = if generation != self.revocation.load(Ordering::SeqCst) {
                        Err(TransportError::Other(
                            "Wallet operation was cancelled.".into(),
                        ))
                    } else if authenticates
                        && self
                            .state
                            .lock
                            .prompt
                            .is_some_and(|scope| self.wallet_sync.requires_fresh_coins_for(scope))
                    {
                        candidate.spend = None;
                        Err(TransportError::Other(
                            "Refresh the wallet before preparing or authorizing a spend.".into(),
                        ))
                    } else if let Some(security) = &mut self.security {
                        security.handle(
                            &mut candidate,
                            request,
                            now_ms,
                            self.wallet_sync.reconciliation(),
                        )
                    } else {
                        Err(TransportError::Unsupported)
                    };
                    let finished_ms = self.now_ms();
                    let revoked = generation != self.revocation.load(Ordering::SeqCst)
                        || (!is_query && reply.is_closed())
                        || (!opens_wallet && previous_lock.idle_should_lock(finished_ms));
                    // Storage may already have committed a password change. Keep its state
                    // coherent even if an OS enrollment refresh subsequently returned an error.
                    self.state = candidate;
                    let result = if revoked {
                        self.state.reduce(AppAction::LockWallet);
                        self.publish(AppEvent::WalletLocked);
                        Err(TransportError::Other(
                            "Wallet operation was cancelled. Reopen the wallet before continuing."
                                .into(),
                        ))
                    } else {
                        if result.is_ok()
                            && (opens_wallet
                                || authenticates
                                || previous_epoch != self.state.lock.unlock_epoch)
                        {
                            self.state.lock.record_activity(finished_ms);
                            if opens_wallet
                                || approves_spend
                                || previous_epoch != self.state.lock.unlock_epoch
                            {
                                self.state.lock.mark_spend_auth(finished_ms);
                            }
                        }
                        if !is_query {
                            let event = if self.state.wallet.is_some()
                                && opens_wallet
                                && previous_epoch != self.state.lock.unlock_epoch
                            {
                                AppEvent::WalletOpened
                            } else if result.is_ok()
                                && approves_spend
                                && self.wallet_sync.coins_are_fresh()
                            {
                                AppEvent::SpendAuthorized
                            } else {
                                AppEvent::AppLockChanged
                            };
                            if !opens_wallet
                                && (previous_epoch != self.state.lock.unlock_epoch
                                    || previous_allocation != self.state.hd_addresses)
                            {
                                // A new address expands scan scope; password rotation revokes
                                // authority. Both cancel work begun against the previous state.
                                self.revocation.fetch_add(1, Ordering::SeqCst);
                                self.state.spend = None;
                                self.wallet_sync.on_event(&AppEvent::WalletRebuilt);
                            }
                            self.publish(event);
                        }
                        result
                    };
                    let _ = reply.send(result);
                }
                RuntimeRequest::Action(action, applied) => {
                    if self.security.is_some()
                        && matches!(
                            action,
                            AppAction::OpenCreatedWallet { .. }
                                | AppAction::OpenImportedWallet { .. }
                        )
                    {
                        self.state.notice = Some(
                            "Open encrypted wallets through password or device authentication."
                                .into(),
                        );
                        self.publish(AppEvent::NoticeChanged);
                        let _ = applied.send(());
                        continue;
                    }
                    // Renderer timestamps cannot prolong sessions or manufacture approval.
                    let action = match action {
                        AppAction::RecordActivity { .. } => AppAction::RecordActivity { now_ms },
                        AppAction::IdleCheck { .. } => AppAction::IdleCheck { now_ms },
                        AppAction::AuthorizeSpend { .. } => AppAction::AuthorizeSpend { now_ms },
                        AppAction::RequestReveal { .. } => AppAction::RequestReveal { now_ms },
                        AppAction::AuthorizeBackground { .. } => {
                            AppAction::AuthorizeBackground { now_ms }
                        }
                        AppAction::AuthorizeChat { .. } => AppAction::AuthorizeChat { now_ms },
                        other => other,
                    };
                    if let AppAction::SetAutoLockMinutes(minutes) = action {
                        if let Some(security) = &self.security {
                            if security.save_policy(minutes).is_err() {
                                self.state.notice = Some("Auto-lock could not be saved. Your previous setting is unchanged.".into());
                                self.publish(AppEvent::NoticeChanged);
                                let _ = applied.send(());
                                continue;
                            }
                        }
                    }
                    // Switching chains revokes the private session as well as sync work.
                    if matches!(action, AppAction::SetNetwork(network) if network != self.state.network)
                        && self
                            .security
                            .as_ref()
                            .is_some_and(|security| security.is_open(&self.state))
                    {
                        self.state.reduce(AppAction::LockWallet);
                        self.publish(AppEvent::WalletLocked);
                    }
                    let annotation_before = matches!(
                        action,
                        AppAction::FreezeCoin(_)
                            | AppAction::UnfreezeCoin(_)
                            | AppAction::SetCoinLabel { .. }
                    )
                    .then(|| self.state.clone());
                    let annotation_generation = self.revocation.load(Ordering::SeqCst);
                    let mut event = if self.wallet_sync.requires_fresh_coins(&action, &self.state) {
                        self.state.spend = None;
                        self.state.notice = Some(
                            "Refresh the wallet before preparing or authorizing a spend.".into(),
                        );
                        Some(AppEvent::NoticeChanged)
                    } else {
                        self.state.reduce_intent(action)
                    };
                    if event == Some(AppEvent::CoinsChanged) {
                        if let (Some(previous), Some(security)) =
                            (annotation_before, self.security.as_mut())
                        {
                            let guard = PublicationGuard {
                                generation: annotation_generation,
                                revocation: &self.revocation,
                                now_ms: &|| elapsed_ms(self.started),
                            };
                            event = Some(self.wallet_sync.persist_annotation(
                                &mut self.state,
                                previous,
                                |app, sync| security.persist_checkpoint(app, sync),
                                |app| guard.allows(app, applied.is_closed()),
                            ));
                            if event == Some(AppEvent::CoinsChanged) {
                                security.checkpoint_published();
                            }
                        }
                    }
                    // Storage may have crossed the idle deadline. Lock and drop the
                    // private session before publishing any annotation result.
                    self.expire_session();
                    if let Some(event) = event {
                        self.publish(event);
                    }
                    let _ = applied.send(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppRoute, ThemeMode};

    #[test]
    fn checkpoint_publication_host_clock_expires_before_another_request() {
        let mut state = AppState::default();
        state.reduce(AppAction::OpenImportedWallet {
            name: "public observation fixture".into(),
            receive_address: optn_core::cashaddr::Address::from_hash(
                "bitcoincash",
                optn_core::cashaddr::AddressKind::P2pkh,
                [1; 20],
            )
            .encode(),
            account_path: "m/44'/145'/0'".into(),
        });
        state.lock.auto_lock = optn_app::AutoLockMinutes::Fifteen;
        state.lock.record_activity(1);
        let (runtime, mut driver) = AppRuntime::new(state);
        driver.started = std::time::Instant::now() - std::time::Duration::from_secs(15 * 60);
        let guard = PublicationGuard {
            generation: 0,
            revocation: &driver.revocation,
            now_ms: &|| elapsed_ms(driver.started),
        };
        assert!(!guard.allows(&driver.state, false));
        driver.expire_session();
        assert!(runtime.state().wallet.is_none());
        assert_eq!(runtime.revocation.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn host_clock_expires_timer_sessions_without_renderer_ticks() {
        let mut state = AppState::default();
        let preview = optn_app::seed_wallet_preview(
            optn_app::Network::Chipnet,
            "Public vector",
            optn_app::BIP39_TEST_VECTOR_MNEMONIC,
        )
        .unwrap();
        state.reduce(AppAction::OpenImportedWallet {
            name: preview.name,
            receive_address: preview.receive_address,
            account_path: preview.account_path,
        });
        state.lock.auto_lock = optn_app::AutoLockMinutes::Fifteen;
        state.lock.observe(1);
        let (runtime, mut driver) = AppRuntime::new(state);
        driver.started = std::time::Instant::now() - std::time::Duration::from_secs(901);
        let mut changes = runtime.subscribe_state();
        tokio::spawn(driver.run());
        tokio::time::timeout(std::time::Duration::from_secs(2), changes.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(runtime.state().wallet.is_none());
    }

    #[tokio::test]
    async fn renderer_clock_cannot_extend_activity_or_issue_a_verified_grant() {
        let runtime = AppRuntime::spawn(AppState::default());
        runtime
            .dispatch(AppAction::RecordActivity { now_ms: u64::MAX })
            .await
            .unwrap();
        runtime.dispatch(AppAction::OpenHelp).await.unwrap();
        assert!(runtime.state().lock.last_activity_ms < 10_000);
        assert!(runtime
            .dispatch(AppAction::ConfirmAuth { now_ms: u64::MAX })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn dispatch_acknowledges_applied_state_and_no_op_actions() {
        let runtime = AppRuntime::spawn(AppState::default());
        runtime
            .dispatch(AppAction::SetTheme(ThemeMode::Light))
            .await
            .unwrap();
        assert_eq!(runtime.state().theme, ThemeMode::Light);
        runtime
            .dispatch(AppAction::SetTheme(ThemeMode::Light))
            .await
            .unwrap();
        assert_eq!(runtime.state().theme, ThemeMode::Light);
    }

    #[tokio::test]
    async fn runtime_reconciles_state_before_emitting_event() {
        let runtime = AppRuntime::spawn(AppState::default());
        let mut events = runtime.subscribe_events();
        let state_rx = runtime.subscribe_state();
        runtime.dispatch(AppAction::ToggleTheme).await.unwrap();
        let event = events.recv().await.unwrap();
        assert_eq!(event, AppEvent::ThemeChanged(ThemeMode::Dark));
        assert_eq!(state_rx.borrow().theme, ThemeMode::Dark);
    }

    #[tokio::test]
    async fn runtime_suppresses_no_op_events() {
        let runtime = AppRuntime::spawn(AppState::default());
        let mut events = runtime.subscribe_events();
        runtime
            .dispatch(AppAction::Navigate(AppRoute::Landing))
            .await
            .unwrap();
        runtime.dispatch(AppAction::OpenHelp).await.unwrap();
        let event = events.recv().await.unwrap();
        assert_eq!(event, AppEvent::HelpVisibilityChanged(true));
    }

    #[tokio::test]
    async fn direct_transport_uses_the_same_typed_contract_without_ipc() {
        let runtime = AppRuntime::spawn(AppState::default());
        let transport = DirectTransport::new(runtime);
        let mut state = transport.snapshot().await.unwrap();
        assert_eq!(state.theme, ThemeMode::Green);
        transport.dispatch(AppAction::ToggleTheme).await.unwrap();
        assert_eq!(
            transport.next_event().await.unwrap(),
            Some(AppEvent::ThemeChanged(ThemeMode::Dark))
        );
        state = transport.snapshot().await.unwrap();
        assert_eq!(state.theme, ThemeMode::Dark);
    }

    #[tokio::test]
    async fn driver_can_be_spawned_by_the_host_executor() {
        let (runtime, driver) = AppRuntime::new(AppState::default());
        tokio::spawn(driver.run());
        let mut state_rx = runtime.subscribe_state();
        runtime.dispatch(AppAction::ToggleTheme).await.unwrap();
        state_rx.changed().await.unwrap();
        assert_eq!(state_rx.borrow().theme, ThemeMode::Dark);
    }
}
