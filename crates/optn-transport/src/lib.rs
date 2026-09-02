#![forbid(unsafe_code)]

//! Transport boundary between renderers and the authoritative application.
//!
//! A renderer must not know whether actions/events cross Tauri IPC, stay
//! in-process, or run inside a WASM host. Implementations live outside this
//! crate; only these typed contracts are shared.

use optn_app::{AppAction, AppEvent, AppState};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, TransportError>> + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Closed,
    Unsupported,
    InvalidData(String),
    Other(String),
}

/// Renderer-facing application transport.
///
/// One event is requested at a time rather than exposing a Tokio or
/// async-stream type, keeping this crate executor and framework neutral.
pub trait AppTransport {
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()>;
    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState>;
    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>>;
}

/// In-process transport for WASM/web/extension renderers.
///
/// It uses the same typed action/state/event contract as native transports but
/// needs no shell or IPC. Arc/Mutex keeps the transport Send + Sync so renderer
/// frameworks can safely store/capture the handle even when the current WASM
/// target executes it on one thread.
#[derive(Clone)]
pub struct LocalTransport {
    state: Arc<Mutex<AppState>>,
    events: Arc<Mutex<VecDeque<AppEvent>>>,
}

impl LocalTransport {
    pub fn new(initial_state: AppState) -> Self {
        Self {
            state: Arc::new(Mutex::new(initial_state)),
            events: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

impl AppTransport for LocalTransport {
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let event = self
                .state
                .lock()
                .map_err(|_| TransportError::Other("local state lock poisoned".into()))?
                .reduce(action);

            if let Some(event) = event {
                self.events
                    .lock()
                    .map_err(|_| TransportError::Other("local event lock poisoned".into()))?
                    .push_back(event);
            }
            Ok(())
        })
    }

    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
        Box::pin(async move {
            self.state
                .lock()
                .map(|state| state.clone())
                .map_err(|_| TransportError::Other("local state lock poisoned".into()))
        })
    }

    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
        Box::pin(async move {
            self.events
                .lock()
                .map(|mut events| events.pop_front())
                .map_err(|_| TransportError::Other("local event lock poisoned".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_transport_object_safe(_: &dyn AppTransport) {}

    struct NeverTransport;

    impl AppTransport for NeverTransport {
        fn dispatch<'a>(&'a self, _action: AppAction) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }

        fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
            Box::pin(async { Ok(AppState::default()) })
        }

        fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
            Box::pin(async { Ok(None) })
        }
    }

    #[test]
    fn local_transport_reduces_actions_without_shell_or_runtime() {
        let transport = LocalTransport::new(AppState::default());
        let result = futures_lite::future::block_on(async {
            transport.dispatch(AppAction::ToggleTheme).await.unwrap();
            let event = transport.next_event().await.unwrap();
            let snapshot = transport.snapshot().await.unwrap();
            (event, snapshot)
        });
        assert_eq!(
            result.0,
            Some(AppEvent::ThemeChanged(optn_app::ThemeMode::Light))
        );
        assert_eq!(result.1.theme, optn_app::ThemeMode::Light);
    }

    #[test]
    fn transport_can_be_used_as_a_framework_neutral_trait_object() {
        let transport = NeverTransport;
        assert_transport_object_safe(&transport);
    }
}
