#![forbid(unsafe_code)]

//! Transport boundary between renderers and the authoritative application.
//!
//! A renderer must not know whether actions/events cross Tauri IPC, stay
//! in-process, or run inside a WASM host. Implementations live outside this
//! crate; only these typed contracts are shared.

use optn_app::{
    AppAction, AppEvent, AppRoute, AppState, AppSurface, FeatureFlag, FeatureFlags, Network,
    ThemeMode, UiSkin,
};
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
    WatchOnlyWallet,
    WalletHome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireTheme {
    Light,
    Gray,
    Green,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireSkin {
    #[default]
    Default,
    Cyberpunk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireNetwork {
    Mainnet,
    Chipnet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireSurface {
    Desktop,
    Android,
    Ios,
    Web,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFeatureFlag {
    CashFusion,
    HardwareWallet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireActionKind {
    Navigate(WireRoute),
    ToggleTheme,
    SetTheme(WireTheme),
    SetSkin(WireSkin),
    SetNetwork(WireNetwork),
    OpenHelp,
    CloseHelp,
    SetSurface(WireSurface),
    SetFeatureEnabled {
        flag: WireFeatureFlag,
        enabled: bool,
    },
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
    #[serde(default)]
    pub skin: WireSkin,
    pub network: WireNetwork,
    pub help_open: bool,
    pub surface: WireSurface,
    pub cash_fusion: bool,
    pub hardware_wallet: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireEventKind {
    RouteChanged(WireRoute),
    ThemeChanged(WireTheme),
    SkinChanged(WireSkin),
    NetworkChanged(WireNetwork),
    HelpVisibilityChanged(bool),
    SurfaceChanged(WireSurface),
    FeatureFlagChanged {
        flag: WireFeatureFlag,
        enabled: bool,
    },
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
            AppRoute::WatchOnlyWallet => Self::WatchOnlyWallet,
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
            WireRoute::WatchOnlyWallet => Self::WatchOnlyWallet,
            WireRoute::WalletHome => Self::WalletHome,
        }
    }
}

impl From<ThemeMode> for WireTheme {
    fn from(value: ThemeMode) -> Self {
        match value {
            ThemeMode::Light => Self::Light,
            ThemeMode::Gray => Self::Gray,
            ThemeMode::Green => Self::Green,
            ThemeMode::Dark => Self::Dark,
        }
    }
}

impl From<WireTheme> for ThemeMode {
    fn from(value: WireTheme) -> Self {
        match value {
            WireTheme::Light => Self::Light,
            WireTheme::Gray => Self::Gray,
            WireTheme::Green => Self::Green,
            WireTheme::Dark => Self::Dark,
        }
    }
}

impl From<UiSkin> for WireSkin {
    fn from(value: UiSkin) -> Self {
        match value {
            UiSkin::Default => Self::Default,
            UiSkin::Cyberpunk => Self::Cyberpunk,
        }
    }
}

impl From<WireSkin> for UiSkin {
    fn from(value: WireSkin) -> Self {
        match value {
            WireSkin::Default => Self::Default,
            WireSkin::Cyberpunk => Self::Cyberpunk,
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

impl From<AppSurface> for WireSurface {
    fn from(value: AppSurface) -> Self {
        match value {
            AppSurface::Desktop => Self::Desktop,
            AppSurface::Android => Self::Android,
            AppSurface::Ios => Self::Ios,
            AppSurface::Web => Self::Web,
            AppSurface::Extension => Self::Extension,
        }
    }
}

impl From<WireSurface> for AppSurface {
    fn from(value: WireSurface) -> Self {
        match value {
            WireSurface::Desktop => Self::Desktop,
            WireSurface::Android => Self::Android,
            WireSurface::Ios => Self::Ios,
            WireSurface::Web => Self::Web,
            WireSurface::Extension => Self::Extension,
        }
    }
}

impl From<FeatureFlag> for WireFeatureFlag {
    fn from(value: FeatureFlag) -> Self {
        match value {
            FeatureFlag::CashFusion => Self::CashFusion,
            FeatureFlag::HardwareWallet => Self::HardwareWallet,
        }
    }
}

impl From<WireFeatureFlag> for FeatureFlag {
    fn from(value: WireFeatureFlag) -> Self {
        match value {
            WireFeatureFlag::CashFusion => Self::CashFusion,
            WireFeatureFlag::HardwareWallet => Self::HardwareWallet,
        }
    }
}

impl From<AppAction> for WireAction {
    fn from(value: AppAction) -> Self {
        let action = match value {
            AppAction::Navigate(route) => WireActionKind::Navigate(route.into()),
            AppAction::ToggleTheme => WireActionKind::ToggleTheme,
            AppAction::SetTheme(theme) => WireActionKind::SetTheme(theme.into()),
            AppAction::SetSkin(skin) => WireActionKind::SetSkin(skin.into()),
            AppAction::SetNetwork(network) => WireActionKind::SetNetwork(network.into()),
            AppAction::OpenHelp => WireActionKind::OpenHelp,
            AppAction::CloseHelp => WireActionKind::CloseHelp,
            AppAction::SetSurface(surface) => WireActionKind::SetSurface(surface.into()),
            AppAction::SetFeatureEnabled { flag, enabled } => WireActionKind::SetFeatureEnabled {
                flag: flag.into(),
                enabled,
            },
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
            WireActionKind::SetTheme(theme) => Self::SetTheme(theme.into()),
            WireActionKind::SetSkin(skin) => Self::SetSkin(skin.into()),
            WireActionKind::SetNetwork(network) => Self::SetNetwork(network.into()),
            WireActionKind::OpenHelp => Self::OpenHelp,
            WireActionKind::CloseHelp => Self::CloseHelp,
            WireActionKind::SetSurface(surface) => Self::SetSurface(surface.into()),
            WireActionKind::SetFeatureEnabled { flag, enabled } => Self::SetFeatureEnabled {
                flag: flag.into(),
                enabled,
            },
        })
    }
}

impl From<&AppState> for WireState {
    fn from(value: &AppState) -> Self {
        Self {
            version: WIRE_PROTOCOL_VERSION,
            route: value.route.into(),
            theme: value.theme.into(),
            skin: value.skin.into(),
            network: value.network.into(),
            help_open: value.help_open,
            surface: value.surface.into(),
            cash_fusion: value
                .features
                .enabled(value.surface, FeatureFlag::CashFusion),
            hardware_wallet: value
                .features
                .enabled(value.surface, FeatureFlag::HardwareWallet),
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
            skin: value.skin.into(),
            network: value.network.into(),
            help_open: value.help_open,
            surface: value.surface.into(),
            features: {
                let surface = AppSurface::from(value.surface);
                let defaults = FeatureFlags::default();
                FeatureFlags {
                    cash_fusion: if value.cash_fusion
                        == defaults.enabled(surface, FeatureFlag::CashFusion)
                    {
                        None
                    } else {
                        Some(value.cash_fusion)
                    },
                    hardware_wallet: if value.hardware_wallet
                        == defaults.enabled(surface, FeatureFlag::HardwareWallet)
                    {
                        None
                    } else {
                        Some(value.hardware_wallet)
                    },
                }
            },
        })
    }
}

impl From<AppEvent> for WireEvent {
    fn from(value: AppEvent) -> Self {
        let event = match value {
            AppEvent::RouteChanged(route) => WireEventKind::RouteChanged(route.into()),
            AppEvent::ThemeChanged(theme) => WireEventKind::ThemeChanged(theme.into()),
            AppEvent::SkinChanged(skin) => WireEventKind::SkinChanged(skin.into()),
            AppEvent::NetworkChanged(network) => WireEventKind::NetworkChanged(network.into()),
            AppEvent::HelpVisibilityChanged(open) => WireEventKind::HelpVisibilityChanged(open),
            AppEvent::SurfaceChanged(surface) => WireEventKind::SurfaceChanged(surface.into()),
            AppEvent::FeatureFlagChanged { flag, enabled } => WireEventKind::FeatureFlagChanged {
                flag: flag.into(),
                enabled,
            },
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
            WireEventKind::SkinChanged(skin) => Self::SkinChanged(skin.into()),
            WireEventKind::NetworkChanged(network) => Self::NetworkChanged(network.into()),
            WireEventKind::HelpVisibilityChanged(open) => Self::HelpVisibilityChanged(open),
            WireEventKind::SurfaceChanged(surface) => Self::SurfaceChanged(surface.into()),
            WireEventKind::FeatureFlagChanged { flag, enabled } => Self::FeatureFlagChanged {
                flag: flag.into(),
                enabled,
            },
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
            Some(AppEvent::ThemeChanged(optn_app::ThemeMode::Dark))
        );
        assert_eq!(result.1.theme, optn_app::ThemeMode::Dark);
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

        let event = AppEvent::RouteChanged(AppRoute::WatchOnlyWallet);
        let encoded = serde_json::to_string(&WireEvent::from(event)).unwrap();
        let decoded: WireEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppEvent::try_from(decoded).unwrap(), event);

        let action = AppAction::SetFeatureEnabled {
            flag: optn_app::FeatureFlag::HardwareWallet,
            enabled: false,
        };
        let decoded = AppAction::try_from(WireAction::from(action)).unwrap();
        assert_eq!(decoded, action);
    }

    #[test]
    fn android_wire_snapshot_keeps_watch_only_on_the_landing() {
        let state = AppState::for_surface(AppSurface::Android);
        let restored = AppState::try_from(WireState::from(&state)).expect("android wire state");
        assert_eq!(restored.surface, AppSurface::Android);
        assert_eq!(
            optn_app::onboarding_actions(&restored),
            vec![
                optn_app::OnboardingAction::CreateWallet,
                optn_app::OnboardingAction::ImportWallet,
                optn_app::OnboardingAction::CreateWatchOnlyWallet,
            ]
        );
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
