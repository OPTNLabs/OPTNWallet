//! Onboarding helpers shared by the Leptos renderer and host tests.
//!
//! Create/Import/Watch-only keep local form state (mnemonic, xPub). Those
//! pages must remount only when `AppRoute` changes — a Chipnet or theme
//! snapshot is not a new page.

#[cfg(any(target_arch = "wasm32", test))]
use optn_app::{AccountPath, AppRoute, AppState, Network};

/// The only field that may unmount the current page.
///
/// Compiled where it is called: the Leptos components in `main.rs` are
/// `#[cfg(target_arch = "wasm32")]`, so on a native build this has no callers
/// but the tests below. Saying that here is better than a dead-code warning
/// that only stays quiet because CI happens not to lint this crate.
#[cfg(any(target_arch = "wasm32", test))]
pub fn mounted_page(state: &AppState) -> AppRoute {
    state.route
}

/// Derivation follows the selected network. Chipnet is `m/44'/1'/0'`, not the
/// Mainnet default captured at first render.
///
/// Same gating as [`mounted_page`], and for the same reason.
#[cfg(any(target_arch = "wasm32", test))]
pub fn derivation_for_network(network: Network) -> AccountPath {
    AccountPath::default_for(network)
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppAction, AppSurface, ThemeMode};

    #[test]
    fn chipnet_and_theme_do_not_change_the_mounted_onboarding_page() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::Navigate(AppRoute::CreateWallet));
        let page = mounted_page(&state);
        assert_eq!(page, AppRoute::CreateWallet);

        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::SetTheme(ThemeMode::Dark));
        assert_eq!(
            mounted_page(&state),
            page,
            "network/theme snapshots must not remount Create"
        );

        state.apply(AppAction::Navigate(AppRoute::ImportWallet));
        assert_eq!(mounted_page(&state), AppRoute::ImportWallet);
        state.apply(AppAction::SetNetwork(Network::Mainnet));
        assert_eq!(mounted_page(&state), AppRoute::ImportWallet);
    }

    #[test]
    fn chipnet_derivation_is_not_the_mainnet_account() {
        let mainnet = derivation_for_network(Network::Mainnet);
        let chipnet = derivation_for_network(Network::Chipnet);
        assert_eq!(mainnet.to_string(), "m/44'/145'/0'");
        assert_eq!(chipnet.to_string(), "m/44'/1'/0'");
        assert_ne!(mainnet, chipnet);
    }
}
