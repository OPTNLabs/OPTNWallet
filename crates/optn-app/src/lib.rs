//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch these actions. Native shells
//! provide platform capabilities through `optn-platform`. Neither Leptos nor
//! Tauri belongs in this crate.

use optn_core::network::Network;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WalletHome,
}

impl AppRoute {
    pub const fn fragment(self) -> &'static str {
        match self {
            Self::Landing => "#/",
            Self::CreateWallet => "#/createwallet",
            Self::ImportWallet => "#/importwallet",
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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            route: AppRoute::Landing,
            theme: ThemeMode::Dark,
            network: Network::Mainnet,
            help_open: false,
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
}

impl AppState {
    pub fn apply(&mut self, action: AppAction) {
        match action {
            AppAction::Navigate(route) => self.route = route,
            AppAction::ToggleTheme => {
                self.theme = match self.theme {
                    ThemeMode::Light => ThemeMode::Dark,
                    ThemeMode::Dark => ThemeMode::Light,
                }
            }
            AppAction::SetNetwork(network) => self.network = network,
            AppAction::OpenHelp => self.help_open = true,
            AppAction::CloseHelp => self.help_open = false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingViewModel {
    pub network_prefix: &'static str,
    pub create_wallet_href: &'static str,
    pub import_wallet_href: &'static str,
    pub dark: bool,
    pub help_open: bool,
}

pub fn onboarding_view_model(state: &AppState) -> OnboardingViewModel {
    OnboardingViewModel {
        network_prefix: state.network.prefix(),
        create_wallet_href: AppRoute::CreateWallet.fragment(),
        import_wallet_href: AppRoute::ImportWallet.fragment(),
        dark: state.theme == ThemeMode::Dark,
        help_open: state.help_open,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_framework_independent_state_transitions() {
        let mut state = AppState::default();
        state.apply(AppAction::ToggleTheme);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::OpenHelp);
        state.apply(AppAction::Navigate(AppRoute::ImportWallet));

        assert_eq!(state.theme, ThemeMode::Light);
        assert_eq!(state.network, Network::Chipnet);
        assert!(state.help_open);
        assert_eq!(state.route, AppRoute::ImportWallet);
    }

    #[test]
    fn onboarding_view_model_comes_from_application_state() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));

        let vm = onboarding_view_model(&state);
        assert_eq!(vm.network_prefix, "bchtest");
        assert_eq!(vm.create_wallet_href, "#/createwallet");
        assert_eq!(vm.import_wallet_href, "#/importwallet");
    }
}
