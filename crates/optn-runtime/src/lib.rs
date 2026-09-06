#![forbid(unsafe_code)]

//! Framework-neutral runtime for OPTN application state.
//!
//! Long-lived native work should live behind typed runtime/services rather than
//! inside Leptos signals or Tauri commands. The runtime owns authoritative
//! application state, receives typed actions, and publishes typed events.
//!
//! The runtime does not choose an executor for the host. `AppRuntime::new`
//! returns a driver future which Tauri, tests, or another shell can spawn.

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
/// Provider-neutral SHV/MMR header verification using the pure optn-core accumulator.
pub mod header_verifier;
/// Versioned user-network overlay and bootstrap-refresh migration scaffolding.
pub mod network_config;
/// Evidence-aware wallet-state reconciliation. Partial/failed providers never
/// erase a previously known-good snapshot.
pub mod reconciliation;
/// Progressive capability-route wallet synchronization.
pub mod sync_worker;
/// Broadcast state tracking. Timeout/offline ambiguity is preserved rather than
/// collapsed into a false deterministic failure.
pub mod tx_broadcast;
/// Framework-neutral authenticated wallet-update state/provider scaffolding.
pub mod update;

use optn_app::{AppAction, AppEvent, AppState};
use optn_transport::{AppTransport, TransportError, TransportFuture};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};

const ACTION_CAPACITY: usize = 128;
const EVENT_CAPACITY: usize = 128;

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
    action_tx: mpsc::Sender<(AppAction, oneshot::Sender<()>)>,
    state_rx: watch::Receiver<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
}

pub struct AppRuntimeDriver {
    action_rx: mpsc::Receiver<(AppAction, oneshot::Sender<()>)>,
    state_tx: watch::Sender<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
    state: AppState,
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
    /// Construct the runtime plus its executor-agnostic driver.
    pub fn new(initial_state: AppState) -> (Self, AppRuntimeDriver) {
        let (action_tx, action_rx) = mpsc::channel(ACTION_CAPACITY);
        let (state_tx, state_rx) = watch::channel(initial_state.clone());
        let (event_tx, _) = broadcast::channel(EVENT_CAPACITY);

        (
            Self {
                action_tx,
                state_rx,
                event_tx: event_tx.clone(),
            },
            AppRuntimeDriver {
                action_rx,
                state_tx,
                event_tx,
                state: initial_state,
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
        let (applied_tx, applied_rx) = oneshot::channel();
        self.action_tx
            .send((action, applied_tx))
            .await
            .map_err(|_| RuntimeStopped)?;
        applied_rx.await.map_err(|_| RuntimeStopped)
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

impl AppRuntimeDriver {
    pub async fn run(mut self) {
        while let Some((action, applied)) = self.action_rx.recv().await {
            if let Some(event) = self.state.reduce(action) {
                self.state_tx.send_replace(self.state.clone());
                let _ = self.event_tx.send(event);
            }
            let _ = applied.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppRoute, ThemeMode};

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
