#![forbid(unsafe_code)]

//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch typed actions. Runtime/shell
//! adapters may subscribe to typed events. No UI or native-shell framework
//! belongs in this crate.

pub use optn_core::network::Network;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Dark,
}

/// Build/runtime surface. Feature flags are booleans derived from this, then
/// optionally turned off by the user. Hardware wallets stay desktop-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppSurface {
    Desktop,
    Android,
    Ios,
    Web,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureFlag {
    CashFusion,
    HardwareWallet,
}

/// User overrides. `None` means "use the surface default" — not a nullable bool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureFlags {
    pub cash_fusion: Option<bool>,
    pub hardware_wallet: Option<bool>,
}

impl FeatureFlags {
    /// Hardware wallets and CashFusion are offered on desktop only.
    pub const fn surface_allows(surface: AppSurface, flag: FeatureFlag) -> bool {
        match (surface, flag) {
            (AppSurface::Desktop, FeatureFlag::CashFusion | FeatureFlag::HardwareWallet) => true,
            _ => false,
        }
    }

    pub fn enabled(self, surface: AppSurface, flag: FeatureFlag) -> bool {
        if !Self::surface_allows(surface, flag) {
            return false;
        }
        match flag {
            FeatureFlag::CashFusion => self.cash_fusion.unwrap_or(true),
            FeatureFlag::HardwareWallet => self.hardware_wallet.unwrap_or(true),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WatchOnlyWallet,
    WalletHome,
}

impl AppRoute {
    pub const fn fragment(self) -> &'static str {
        match self {
            Self::Landing => "#/",
            Self::CreateWallet => "#/createwallet",
            Self::ImportWallet => "#/importwallet",
            Self::WatchOnlyWallet => "#/watch-only",
            Self::WalletHome => "#/wallet",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppState {
    pub route: AppRoute,
    pub theme: ThemeMode,
    pub network: Network,
    pub help_open: bool,
    pub surface: AppSurface,
    pub features: FeatureFlags,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            route: AppRoute::Landing,
            theme: ThemeMode::Dark,
            network: Network::Mainnet,
            help_open: false,
            surface: AppSurface::Desktop,
            features: FeatureFlags::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    Navigate(AppRoute),
    ToggleTheme,
    SetNetwork(Network),
    OpenHelp,
    CloseHelp,
    SetSurface(AppSurface),
    SetFeatureEnabled { flag: FeatureFlag, enabled: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEvent {
    RouteChanged(AppRoute),
    ThemeChanged(ThemeMode),
    NetworkChanged(Network),
    HelpVisibilityChanged(bool),
    SurfaceChanged(AppSurface),
    FeatureFlagChanged { flag: FeatureFlag, enabled: bool },
}

impl AppState {
    /// Apply one typed action and return the observable domain/application event
    /// produced by the state transition. No event is emitted for a no-op.
    pub fn reduce(&mut self, action: AppAction) -> Option<AppEvent> {
        match action {
            AppAction::Navigate(route) if self.route != route => {
                self.route = route;
                Some(AppEvent::RouteChanged(route))
            }
            AppAction::ToggleTheme => {
                self.theme = match self.theme {
                    ThemeMode::Light => ThemeMode::Dark,
                    ThemeMode::Dark => ThemeMode::Light,
                };
                Some(AppEvent::ThemeChanged(self.theme))
            }
            AppAction::SetNetwork(network) if self.network != network => {
                self.network = network;
                Some(AppEvent::NetworkChanged(network))
            }
            AppAction::OpenHelp if !self.help_open => {
                self.help_open = true;
                Some(AppEvent::HelpVisibilityChanged(true))
            }
            AppAction::CloseHelp if self.help_open => {
                self.help_open = false;
                Some(AppEvent::HelpVisibilityChanged(false))
            }
            AppAction::SetSurface(surface) if self.surface != surface => {
                self.surface = surface;
                self.features = FeatureFlags::default();
                Some(AppEvent::SurfaceChanged(surface))
            }
            AppAction::SetFeatureEnabled { flag, enabled } => {
                let next = self.features.enabled(self.surface, flag);
                let wanted = enabled && FeatureFlags::surface_allows(self.surface, flag);
                if next == wanted {
                    return None;
                }
                match flag {
                    FeatureFlag::CashFusion => self.features.cash_fusion = Some(wanted),
                    FeatureFlag::HardwareWallet => self.features.hardware_wallet = Some(wanted),
                }
                Some(AppEvent::FeatureFlagChanged {
                    flag,
                    enabled: wanted,
                })
            }
            AppAction::Navigate(_)
            | AppAction::SetNetwork(_)
            | AppAction::OpenHelp
            | AppAction::CloseHelp
            | AppAction::SetSurface(_) => None,
        }
    }

    /// Convenience for callers that only care about the resulting state.
    pub fn apply(&mut self, action: AppAction) {
        let _ = self.reduce(action);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingViewModel {
    pub network_prefix: &'static str,
    pub create_wallet_href: &'static str,
    pub import_wallet_href: &'static str,
    pub watch_only_wallet_href: &'static str,
    pub dark: bool,
    pub help_open: bool,
    pub show_cash_fusion: bool,
    pub show_hardware_wallet: bool,
}

pub fn onboarding_view_model(state: &AppState) -> OnboardingViewModel {
    OnboardingViewModel {
        network_prefix: state.network.prefix(),
        create_wallet_href: AppRoute::CreateWallet.fragment(),
        import_wallet_href: AppRoute::ImportWallet.fragment(),
        watch_only_wallet_href: AppRoute::WatchOnlyWallet.fragment(),
        dark: state.theme == ThemeMode::Dark,
        help_open: state.help_open,
        show_cash_fusion: state
            .features
            .enabled(state.surface, FeatureFlag::CashFusion),
        show_hardware_wallet: state
            .features
            .enabled(state.surface, FeatureFlag::HardwareWallet),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_framework_independent_state_transitions() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::ToggleTheme),
            Some(AppEvent::ThemeChanged(ThemeMode::Light))
        );
        assert_eq!(
            state.reduce(AppAction::SetNetwork(Network::Chipnet)),
            Some(AppEvent::NetworkChanged(Network::Chipnet))
        );
        assert_eq!(
            state.reduce(AppAction::OpenHelp),
            Some(AppEvent::HelpVisibilityChanged(true))
        );
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::ImportWallet)),
            Some(AppEvent::RouteChanged(AppRoute::ImportWallet))
        );

        assert_eq!(state.theme, ThemeMode::Light);
        assert_eq!(state.network, Network::Chipnet);
        assert!(state.help_open);
        assert_eq!(state.route, AppRoute::ImportWallet);
    }

    #[test]
    fn no_op_actions_emit_no_events() {
        let mut state = AppState::default();
        assert_eq!(state.reduce(AppAction::SetNetwork(Network::Mainnet)), None);
        assert_eq!(state.reduce(AppAction::CloseHelp), None);
        assert_eq!(state.reduce(AppAction::Navigate(AppRoute::Landing)), None);
    }

    proptest::proptest! {
        #[test]
        fn arbitrary_action_sequences_keep_view_model_consistent(
            actions in proptest::collection::vec(0u8..9, 0..256)
        ) {
            let mut state = AppState::default();

            for action in actions {
                let action = match action {
                    0 => AppAction::Navigate(AppRoute::Landing),
                    1 => AppAction::Navigate(AppRoute::CreateWallet),
                    2 => AppAction::Navigate(AppRoute::ImportWallet),
                    3 => AppAction::Navigate(AppRoute::WatchOnlyWallet),
                    4 => AppAction::Navigate(AppRoute::WalletHome),
                    5 => AppAction::ToggleTheme,
                    6 => AppAction::SetNetwork(Network::Mainnet),
                    7 => AppAction::SetNetwork(Network::Chipnet),
                    _ => if state.help_open {
                        AppAction::CloseHelp
                    } else {
                        AppAction::OpenHelp
                    },
                };
                state.apply(action);

                let vm = onboarding_view_model(&state);
                proptest::prop_assert_eq!(
                    vm.network_prefix,
                    state.network.prefix()
                );
                proptest::prop_assert_eq!(
                    vm.dark,
                    state.theme == ThemeMode::Dark
                );
                proptest::prop_assert_eq!(vm.help_open, state.help_open);
            }
        }
    }

    #[test]
    fn watch_only_navigation_emits_a_typed_route_event() {
        let mut state = AppState::default();
        assert_eq!(state.route, AppRoute::Landing);
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::WatchOnlyWallet)),
            Some(AppEvent::RouteChanged(AppRoute::WatchOnlyWallet))
        );
        assert_eq!(state.route, AppRoute::WatchOnlyWallet);
        assert_eq!(state.route.fragment(), "#/watch-only");
        assert_eq!(
            onboarding_view_model(&state).watch_only_wallet_href,
            "#/watch-only"
        );
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::WatchOnlyWallet)),
            None
        );
    }

    #[test]
    fn onboarding_view_model_comes_from_application_state() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));

        let vm = onboarding_view_model(&state);
        assert_eq!(vm.network_prefix, "bchtest");
        assert_eq!(vm.create_wallet_href, "#/createwallet");
        assert_eq!(vm.import_wallet_href, "#/importwallet");
        assert_eq!(vm.watch_only_wallet_href, "#/watch-only");
        assert!(vm.show_cash_fusion);
        assert!(vm.show_hardware_wallet);
    }

    #[test]
    fn cash_fusion_and_hardware_wallet_are_boolean_surface_toggles() {
        let none = FeatureFlags::default();
        assert!(none.enabled(AppSurface::Desktop, FeatureFlag::CashFusion));
        assert!(none.enabled(AppSurface::Desktop, FeatureFlag::HardwareWallet));

        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert!(
                !none.enabled(surface, FeatureFlag::CashFusion),
                "{surface:?} must hide CashFusion"
            );
            assert!(
                !none.enabled(surface, FeatureFlag::HardwareWallet),
                "{surface:?} must hide hardware wallets"
            );
        }
    }

    #[test]
    fn hardware_wallet_cannot_be_enabled_off_desktop() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::SetSurface(AppSurface::Android)),
            Some(AppEvent::SurfaceChanged(AppSurface::Android))
        );
        let vm = onboarding_view_model(&state);
        assert!(!vm.show_hardware_wallet);
        assert!(!vm.show_cash_fusion);

        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::HardwareWallet,
                enabled: true,
            }),
            None
        );
        assert_eq!(state.features.hardware_wallet, None);

        state.apply(AppAction::SetSurface(AppSurface::Desktop));
        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::CashFusion,
                enabled: false,
            }),
            Some(AppEvent::FeatureFlagChanged {
                flag: FeatureFlag::CashFusion,
                enabled: false,
            })
        );
        assert_eq!(state.features.cash_fusion, Some(false));
        assert!(!onboarding_view_model(&state).show_cash_fusion);
        assert!(onboarding_view_model(&state).show_hardware_wallet);

        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::HardwareWallet,
                enabled: false,
            }),
            Some(AppEvent::FeatureFlagChanged {
                flag: FeatureFlag::HardwareWallet,
                enabled: false,
            })
        );
        assert_eq!(state.features.hardware_wallet, Some(false));
        assert!(!onboarding_view_model(&state).show_hardware_wallet);
    }
}
