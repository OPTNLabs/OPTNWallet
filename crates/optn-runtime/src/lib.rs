//! Framework-neutral runtime for OPTN application state.
//!
//! Long-lived native work should live behind typed runtime/services rather than
//! inside Leptos signals or Tauri commands. The runtime owns authoritative
//! application state, receives typed actions, and publishes typed events.
//!
//! The runtime does not choose an executor for the host. `AppRuntime::new`
//! returns a driver future which Tauri, tests, or another shell can spawn.

use optn_app::{AppAction, AppEvent, AppState};
use tokio::sync::{broadcast, mpsc, watch};

const ACTION_CAPACITY: usize = 128;
const EVENT_CAPACITY: usize = 128;

#[derive(Clone)]
pub struct AppRuntime {
    action_tx: mpsc::Sender<AppAction>,
    state_rx: watch::Receiver<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
}

pub struct AppRuntimeDriver {
    action_rx: mpsc::Receiver<AppAction>,
    state_tx: watch::Sender<AppState>,
    event_tx: broadcast::Sender<AppEvent>,
    state: AppState,
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

    pub async fn dispatch(
        &self,
        action: AppAction,
    ) -> Result<(), mpsc::error::SendError<AppAction>> {
        self.action_tx.send(action).await
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
        while let Some(action) = self.action_rx.recv().await {
            let Some(event) = self.state.reduce(action) else {
                continue;
            };

            // Publish the authoritative snapshot before the event so a
            // subscriber reacting to the event can immediately read it.
            self.state_tx.send_replace(self.state.clone());
            let _ = self.event_tx.send(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppRoute, ThemeMode};

    #[tokio::test]
    async fn runtime_reconciles_state_before_emitting_event() {
        let runtime = AppRuntime::spawn(AppState::default());
        let mut events = runtime.subscribe_events();
        let state_rx = runtime.subscribe_state();

        runtime.dispatch(AppAction::ToggleTheme).await.unwrap();

        let event = events.recv().await.unwrap();
        assert_eq!(event, AppEvent::ThemeChanged(ThemeMode::Light));
        assert_eq!(state_rx.borrow().theme, ThemeMode::Light);
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
    async fn driver_can_be_spawned_by_the_host_executor() {
        let (runtime, driver) = AppRuntime::new(AppState::default());
        tokio::spawn(driver.run());

        runtime.dispatch(AppAction::ToggleTheme).await.unwrap();

        let mut state_rx = runtime.subscribe_state();
        state_rx.changed().await.unwrap();
        assert_eq!(state_rx.borrow().theme, ThemeMode::Light);
    }
}
