#![forbid(unsafe_code)]

//! Transport boundary between renderers and the authoritative application.
//!
//! A renderer must not know whether actions/events cross Tauri IPC, stay
//! in-process, or run inside a WASM host. Implementations live outside this
//! crate; only these typed contracts are shared.

use optn_app::{AppAction, AppEvent, AppRoute, AppState, Network, ThemeMode};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub const WIRE_PROTOCOL_VERSION: u16 = 1;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WalletHome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireTheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireNetwork {
    Mainnet,
    Chipnet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireActionKind {
    Navigate(WireRoute),
    ToggleTheme,
    SetNetwork(WireNetwork),
    OpenHelp,
    CloseHelp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireAction {
    pub version: u16,
    pub action: WireActionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireState {
    pub version: u16,
    pub route: WireRoute,
    pub theme: WireTheme,
    pub network: WireNetwork,
    pub help_open: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireEventKind {
    RouteChanged(WireRoute),
    ThemeChanged(WireTheme),
    NetworkChanged(WireNetwork),
    HelpVisibilityChanged(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireEvent {
    pub version: u16,
    pub event: WireEventKind,
}

impl From<AppRoute> for WireRoute {
    fn from(value: AppRoute) -> Self {
        match value {
            AppRoute::Landing => Self::Landing,
            AppRoute::CreateWallet => Self::CreateWallet,
            AppRoute::ImportWallet => Self::ImportWallet,
            AppRoute::WalletHome => Self::WalletHome,
        }
    }
}

impl From<WireRoute> for AppRoute {
    fn from(value: WireRoute) -> Self {
        match value {
            WireRoute::Landing => Self::Landing,
            WireRoute::CreateWallet => Self::CreateWallet,
            WireRoute::ImportWallet => Self::ImportWallet,
            WireRoute::WalletHome => Self::WalletHome,
        }
    }
}

impl From<ThemeMode> for WireTheme {
    fn from(value: ThemeMode) -> Self {
        match value {
            ThemeMode::Light => Self::Light,
            ThemeMode::Dark => Self::Dark,
        }
    }
}

impl From<WireTheme> for ThemeMode {
    fn from(value: WireTheme) -> Self {
        match value {
            WireTheme::Light => Self::Light,
            WireTheme::Dark => Self::Dark,
        }
    }
}

impl From<Network> for WireNetwork {
    fn from(value: Network) -> Self {
        match value {
            Network::Mainnet => Self::Mainnet,
            Network::Chipnet => Self::Chipnet,
        }
    }
}

impl From<WireNetwork> for Network {
    fn from(value: WireNetwork) -> Self {
        match value {
            WireNetwork::Mainnet => Self::Mainnet,
            WireNetwork::Chipnet => Self::Chipnet,
        }
    }
}

impl From<AppAction> for WireAction {
    fn from(value: AppAction) -> Self {
        let action = match value {
            AppAction::Navigate(route) => WireActionKind::Navigate(route.into()),
            AppAction::ToggleTheme => WireActionKind::ToggleTheme,
            AppAction::SetNetwork(network) => WireActionKind::SetNetwork(network.into()),
            AppAction::OpenHelp => WireActionKind::OpenHelp,
            AppAction::CloseHelp => WireActionKind::CloseHelp,
        };
        Self {
            version: WIRE_PROTOCOL_VERSION,
            action,
        }
    }
}

impl TryFrom<WireAction> for AppAction {
    type Error = TransportError;

    fn try_from(value: WireAction) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(match value.action {
            WireActionKind::Navigate(route) => Self::Navigate(route.into()),
            WireActionKind::ToggleTheme => Self::ToggleTheme,
            WireActionKind::SetNetwork(network) => Self::SetNetwork(network.into()),
            WireActionKind::OpenHelp => Self::OpenHelp,
            WireActionKind::CloseHelp => Self::CloseHelp,
        })
    }
}

impl From<&AppState> for WireState {
    fn from(value: &AppState) -> Self {
        Self {
            version: WIRE_PROTOCOL_VERSION,
            route: value.route.into(),
            theme: value.theme.into(),
            network: value.network.into(),
            help_open: value.help_open,
        }
    }
}

impl TryFrom<WireState> for AppState {
    type Error = TransportError;

    fn try_from(value: WireState) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(Self {
            route: value.route.into(),
            theme: value.theme.into(),
            network: value.network.into(),
            help_open: value.help_open,
        })
    }
}

impl From<AppEvent> for WireEvent {
    fn from(value: AppEvent) -> Self {
        let event = match value {
            AppEvent::RouteChanged(route) => WireEventKind::RouteChanged(route.into()),
            AppEvent::ThemeChanged(theme) => WireEventKind::ThemeChanged(theme.into()),
            AppEvent::NetworkChanged(network) => WireEventKind::NetworkChanged(network.into()),
            AppEvent::HelpVisibilityChanged(open) => WireEventKind::HelpVisibilityChanged(open),
        };
        Self {
            version: WIRE_PROTOCOL_VERSION,
            event,
        }
    }
}

impl TryFrom<WireEvent> for AppEvent {
    type Error = TransportError;

    fn try_from(value: WireEvent) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(match value.event {
            WireEventKind::RouteChanged(route) => Self::RouteChanged(route.into()),
            WireEventKind::ThemeChanged(theme) => Self::ThemeChanged(theme.into()),
            WireEventKind::NetworkChanged(network) => Self::NetworkChanged(network.into()),
            WireEventKind::HelpVisibilityChanged(open) => Self::HelpVisibilityChanged(open),
        })
    }
}

fn verify_wire_version(version: u16) -> Result<(), TransportError> {
    if version == WIRE_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(TransportError::InvalidData(format!(
            "unsupported transport protocol version {version}; expected {WIRE_PROTOCOL_VERSION}"
        )))
    }
}

/// In-process transport for WASM/web/extension renderers.
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
    fn wire_round_trip_preserves_typed_action_state_and_event() {
        let action = AppAction::SetNetwork(Network::Chipnet);
        let encoded = serde_json::to_string(&WireAction::from(action)).unwrap();
        let decoded: WireAction = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppAction::try_from(decoded).unwrap(), action);

        let mut state = AppState::default();
        state.apply(AppAction::ToggleTheme);
        let encoded = serde_json::to_string(&WireState::from(&state)).unwrap();
        let decoded: WireState = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppState::try_from(decoded).unwrap(), state);

        let event = AppEvent::RouteChanged(AppRoute::WalletHome);
        let encoded = serde_json::to_string(&WireEvent::from(event)).unwrap();
        let decoded: WireEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppEvent::try_from(decoded).unwrap(), event);
    }

    #[test]
    fn wire_protocol_rejects_unknown_version() {
        let mut wire = WireAction::from(AppAction::OpenHelp);
        wire.version = WIRE_PROTOCOL_VERSION + 1;
        assert!(matches!(
            AppAction::try_from(wire),
            Err(TransportError::InvalidData(_))
        ));
    }

    #[test]
    fn transport_can_be_used_as_a_framework_neutral_trait_object() {
        let transport = NeverTransport;
        assert_transport_object_safe(&transport);
    }
}
