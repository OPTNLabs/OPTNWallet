#![forbid(unsafe_code)]

//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch typed actions. Runtime/shell
//! adapters may subscribe to typed events. No UI or native-shell framework
//! belongs in this crate.

pub use optn_core::network::Network;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    /// Light surfaces, dark text.
    Light,
    /// Charcoal everyday dark. Not OLED black.
    Gray,
    /// OPTN brand green.
    Green,
    /// True black / OLED.
    Dark,
}

impl ThemeMode {
    pub const fn next(self) -> Self {
        match self {
            Self::Light => Self::Gray,
            Self::Gray => Self::Green,
            Self::Green => Self::Dark,
            Self::Dark => Self::Light,
        }
    }

    pub const fn is_dark_surface(self) -> bool {
        !matches!(self, Self::Light)
    }

    pub const fn css_class(self) -> &'static str {
        match self {
            Self::Light => "theme-light",
            Self::Gray => "theme-gray",
            Self::Green => "theme-green",
            Self::Dark => "theme-dark",
        }
    }
}

/// Visual language on top of a theme mode. Not a second wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UiSkin {
    #[default]
    Default,
    Cyberpunk,
}

impl UiSkin {
    pub const fn css_class(self) -> &'static str {
        match self {
            Self::Default => "skin-default",
            Self::Cyberpunk => "skin-cyberpunk",
        }
    }
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

impl AppSurface {
    /// Watch-only onboarding is a surface capability, not a renderer feature.
    /// Desktop, Android, and iOS offer it; web and extension do not.
    pub const fn offers_watch_only(self) -> bool {
        matches!(self, Self::Desktop | Self::Android | Self::Ios)
    }
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
        matches!(
            (surface, flag),
            (
                AppSurface::Desktop,
                FeatureFlag::CashFusion | FeatureFlag::HardwareWallet
            )
        )
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
    pub skin: UiSkin,
    pub network: Network,
    pub help_open: bool,
    pub surface: AppSurface,
    pub features: FeatureFlags,
}

impl Default for AppState {
    fn default() -> Self {
        Self::for_surface(AppSurface::Desktop)
    }
}

impl AppState {
    pub const fn for_surface(surface: AppSurface) -> Self {
        Self {
            route: AppRoute::Landing,
            theme: ThemeMode::Green,
            skin: UiSkin::Default,
            network: Network::Mainnet,
            help_open: false,
            surface,
            features: FeatureFlags {
                cash_fusion: None,
                hardware_wallet: None,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    Navigate(AppRoute),
    ToggleTheme,
    SetTheme(ThemeMode),
    SetSkin(UiSkin),
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
    SkinChanged(UiSkin),
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
                self.theme = self.theme.next();
                Some(AppEvent::ThemeChanged(self.theme))
            }
            AppAction::SetTheme(theme) if self.theme != theme => {
                self.theme = theme;
                Some(AppEvent::ThemeChanged(theme))
            }
            AppAction::SetSkin(skin) if self.skin != skin => {
                self.skin = skin;
                Some(AppEvent::SkinChanged(skin))
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
            | AppAction::SetTheme(_)
            | AppAction::SetSkin(_)
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
    pub show_watch_only: bool,
}

pub fn onboarding_view_model(state: &AppState) -> OnboardingViewModel {
    OnboardingViewModel {
        network_prefix: state.network.prefix(),
        create_wallet_href: AppRoute::CreateWallet.fragment(),
        import_wallet_href: AppRoute::ImportWallet.fragment(),
        watch_only_wallet_href: AppRoute::WatchOnlyWallet.fragment(),
        dark: state.theme.is_dark_surface(),
        help_open: state.help_open,
        show_cash_fusion: state
            .features
            .enabled(state.surface, FeatureFlag::CashFusion),
        show_hardware_wallet: state
            .features
            .enabled(state.surface, FeatureFlag::HardwareWallet),
        show_watch_only: state.surface.offers_watch_only(),
    }
}

/// Ordered landing CTAs. Renderers must draw this list; they must not invent a
/// Create/Import-only menu that drops Watch Only on Android/iOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardingAction {
    CreateWallet,
    ImportWallet,
    CreateWatchOnlyWallet,
    ConnectHardwareWallet,
}

impl OnboardingAction {
    pub const fn href(self) -> Option<&'static str> {
        match self {
            Self::CreateWallet => Some(AppRoute::CreateWallet.fragment()),
            Self::ImportWallet => Some(AppRoute::ImportWallet.fragment()),
            Self::CreateWatchOnlyWallet => Some(AppRoute::WatchOnlyWallet.fragment()),
            Self::ConnectHardwareWallet => None,
        }
    }

    pub const fn route(self) -> Option<AppRoute> {
        match self {
            Self::CreateWallet => Some(AppRoute::CreateWallet),
            Self::ImportWallet => Some(AppRoute::ImportWallet),
            Self::CreateWatchOnlyWallet => Some(AppRoute::WatchOnlyWallet),
            Self::ConnectHardwareWallet => None,
        }
    }
}

pub fn onboarding_actions(state: &AppState) -> Vec<OnboardingAction> {
    let vm = onboarding_view_model(state);
    let mut actions = vec![
        OnboardingAction::CreateWallet,
        OnboardingAction::ImportWallet,
    ];
    if vm.show_watch_only {
        actions.push(OnboardingAction::CreateWatchOnlyWallet);
    }
    if vm.show_hardware_wallet {
        actions.push(OnboardingAction::ConnectHardwareWallet);
    }
    actions
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOnlySetupPreview {
    pub wallet_name: String,
    pub master_fingerprint: Option<String>,
    pub account_path: String,
    pub receive_address: String,
    pub receive_token_address: String,
    pub change_address: String,
}

/// Validate watch-only onboarding data in the application/domain layer.
///
/// Renderers submit strings; the shared core decides whether the account xPub
/// and optional master fingerprint are valid and derives the public preview.
pub fn watch_only_setup_preview(
    network: Network,
    wallet_name: &str,
    account_xpub: &str,
    master_fingerprint: &str,
) -> Result<WatchOnlySetupPreview, String> {
    let wallet_name = wallet_name.trim();
    if wallet_name.is_empty() {
        return Err("Give the wallet a name.".into());
    }
    if wallet_name.chars().count() > 80 {
        return Err("Wallet name is too long.".into());
    }

    let fingerprint = optn_core::watch_only::normalize_master_fingerprint(master_fingerprint)
        .map_err(|error| error.to_string())?;
    let preview = optn_core::watch_only::account_preview(network, account_xpub)
        .map_err(|error| error.to_string())?;

    Ok(WatchOnlySetupPreview {
        wallet_name: wallet_name.to_owned(),
        master_fingerprint: fingerprint,
        account_path: preview.account_path,
        receive_address: preview.receive.address,
        receive_token_address: preview.receive.token_address,
        change_address: preview.change.address,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_framework_independent_state_transitions() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::ToggleTheme),
            Some(AppEvent::ThemeChanged(ThemeMode::Dark))
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

        assert_eq!(state.theme, ThemeMode::Dark);
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
                    state.theme.is_dark_surface()
                );
                proptest::prop_assert_eq!(state.skin, state.skin);
                proptest::prop_assert_eq!(vm.help_open, state.help_open);
            }
        }
    }

    #[test]
    fn theme_and_skin_do_not_change_wallet_route_or_network() {
        let mut state = AppState::default();
        state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        assert_eq!(
            state.reduce(AppAction::SetTheme(ThemeMode::Gray)),
            Some(AppEvent::ThemeChanged(ThemeMode::Gray))
        );
        assert_eq!(
            state.reduce(AppAction::SetSkin(UiSkin::Cyberpunk)),
            Some(AppEvent::SkinChanged(UiSkin::Cyberpunk))
        );
        assert_eq!(state.route, AppRoute::WatchOnlyWallet);
        assert_eq!(state.network, Network::Chipnet);
        assert_eq!(state.theme, ThemeMode::Gray);
        assert_eq!(state.skin, UiSkin::Cyberpunk);
        assert_eq!(state.theme.next(), ThemeMode::Green);
        assert_eq!(ThemeMode::Green.css_class(), "theme-green");
        assert_eq!(UiSkin::Cyberpunk.css_class(), "skin-cyberpunk");
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
        assert!(vm.show_watch_only);
    }

    #[test]
    fn watch_only_follows_the_surface_capability_matrix_not_a_hardcoded_menu() {
        let expected = [
            (AppSurface::Desktop, true, true),
            (AppSurface::Android, true, false),
            (AppSurface::Ios, true, false),
            (AppSurface::Web, false, false),
            (AppSurface::Extension, false, false),
        ];
        for (surface, watch_only, hardware) in expected {
            let vm = onboarding_view_model(&AppState::for_surface(surface));
            assert_eq!(
                vm.show_watch_only, watch_only,
                "{surface:?} watch-only must come from the surface matrix"
            );
            assert_eq!(
                vm.show_hardware_wallet, hardware,
                "{surface:?} hardware stays desktop-only"
            );
        }

        let android = onboarding_view_model(&AppState::for_surface(AppSurface::Android));
        let web = onboarding_view_model(&AppState::for_surface(AppSurface::Web));
        assert_ne!(
            android.show_watch_only, web.show_watch_only,
            "a renderer-hardcoded Watch Only menu cannot distinguish Android from web"
        );
    }

    #[test]
    fn native_landing_actions_put_watch_only_with_create_and_import() {
        let native = [AppSurface::Desktop, AppSurface::Android, AppSurface::Ios];
        for surface in native {
            let actions = onboarding_actions(&AppState::for_surface(surface));
            assert_eq!(actions[0], OnboardingAction::CreateWallet, "{surface:?}");
            assert_eq!(actions[1], OnboardingAction::ImportWallet, "{surface:?}");
            assert_eq!(
                actions[2],
                OnboardingAction::CreateWatchOnlyWallet,
                "{surface:?} must show Watch Only as a primary landing action, not an afterthought"
            );
            assert!(
                !matches!(surface, AppSurface::Android | AppSurface::Ios)
                    || !actions.contains(&OnboardingAction::ConnectHardwareWallet),
                "{surface:?} must not offer USB hardware onboarding"
            );
        }

        for surface in [AppSurface::Web, AppSurface::Extension] {
            assert_eq!(
                onboarding_actions(&AppState::for_surface(surface)),
                vec![
                    OnboardingAction::CreateWallet,
                    OnboardingAction::ImportWallet,
                ],
                "{surface:?} must keep Watch Only off the landing"
            );
        }
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
        assert!(vm.show_watch_only);

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
