//! Framework-neutral runtime for OPTN application state.
//!
//! Long-lived native work should live behind typed runtime/services rather than
//! inside Leptos signals or Tauri commands. The runtime owns authoritative
//! application state, receives typed actions, and publishes typed events.

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

impl AppRuntime {
    /// Spawn the runtime on the caller's Tokio executor.
    pub fn spawn(initial_state: AppState) -> Self {
        let (action_tx, mut action_rx) = mpsc::channel(ACTION_CAPACITY);
        let (state_tx, state_rx) = watch::channel(initial_state.clone());
        let (event_tx, _) = broadcast::channel(EVENT_CAPACITY);
        let runtime_event_tx = event_tx.clone();

        tokio::spawn(async move {
            let mut state = initial_state;
            while let Some(action) = action_rx.recv().await {
                let Some(event) = state.reduce(action) else {
                    continue;
                };

                // Publish the authoritative snapshot before the event so a
                // subscriber reacting to the event can immediately read it.
                state_tx.send_replace(state.clone());
                let _ = runtime_event_tx.send(event);
            }
        });

        Self {
            action_tx,
            state_rx,
            event_tx,
        }
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
}
