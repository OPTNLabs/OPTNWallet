#![forbid(unsafe_code)]

//! A third renderer, on Dioxus, without a window.
//!
//! Same seam as `optn-ui-text` and `optn-ui-egui`: view models in, `AppAction`
//! out, `optn_transport::run` as the host. Dioxus SSR paints HTML with no
//! display, so the swap proof runs on CI.

use dioxus::prelude::*;
use optn_transport::{block_on_ready, AppTransport, Renderer, TransportError};

use optn_app::{
    coins_view_model, format_bch, onboarding_actions, portfolio_totals, product_nav,
    settings_view_model, AppAction, AppRoute, AppState, OnboardingAction,
};

fn onboarding_label(action: OnboardingAction) -> &'static str {
    match action {
        OnboardingAction::CreateWallet => "Create wallet",
        OnboardingAction::ImportWallet => "Import wallet",
        OnboardingAction::CreateWatchOnlyWallet => "Create watch-only wallet",
        OnboardingAction::ConnectHardwareWallet => "Connect hardware wallet",
    }
}

#[component]
fn Screen(state: AppState) -> Element {
    match state.route {
        AppRoute::Landing => {
            let actions = onboarding_actions(&state);
            let network = state.network.to_string();
            rsx! {
                h1 { "OPTN Wallet" }
                p { "network: {network}" }
                for action in actions {
                    button { "{onboarding_label(action)}" }
                }
            }
        }
        AppRoute::Settings => {
            let vm = settings_view_model(&state);
            let network = vm.network.to_string();
            let derivation = vm.derivation_path.clone();
            let electrum = vm.electrum_endpoint.clone();
            let device = vm.hardware.vendor.map(|vendor| {
                format!(
                    "device: {} {}",
                    vendor.label(),
                    if vm.hardware.connected {
                        "connected"
                    } else {
                        "not connected"
                    }
                )
            });
            let device_path = vm
                .hardware
                .vendor
                .map(|_| format!("device path: {}", vm.hardware_derivation_path));
            let warning = vm.hardware_path_warning.clone();
            let tabs = product_nav(&state);
            rsx! {
                for item in tabs {
                    button { "{item.label()}" }
                }
                h1 { "Settings" }
                p { "network: {network}" }
                p { "derivation: {derivation}" }
                p { "electrum: {electrum}" }
                if let Some(device) = device {
                    p { "{device}" }
                }
                if let Some(path) = device_path {
                    p { "{path}" }
                }
                if let Some(warning) = warning {
                    p { "{warning}" }
                }
            }
        }
        _ => {
            let tabs = product_nav(&state);
            let totals = portfolio_totals(&state);
            let total = format_bch(totals.total_sats());
            let split = totals.split_label();
            let name = state.wallet.as_ref().map(|wallet| wallet.name.clone());
            let receive = state
                .wallet
                .as_ref()
                .map(|wallet| wallet.receive_address.clone());
            let coins = coins_view_model(&state).coins;
            rsx! {
                for item in tabs {
                    button { "{item.label()}" }
                }
                h1 { "{total}" }
                if let Some(split) = split {
                    p { "{split}" }
                }
                if let Some(name) = name {
                    p { "{name}" }
                }
                if let Some(receive) = receive {
                    p { "{receive}" }
                }
                for coin in coins {
                    p { "{coin.outpoint()} {format_bch(coin.value_sats())}" }
                }
            }
        }
    }
}

fn render_html(state: &AppState) -> String {
    let mut vdom = VirtualDom::new_with_props(
        Screen,
        ScreenProps {
            state: state.clone(),
        },
    );
    vdom.rebuild_in_place();
    dioxus_ssr::render(&vdom)
}

/// This renderer, attached to a transport and holding the state it last drew.
pub struct DioxusRenderer<T: AppTransport> {
    transport: T,
    state: AppState,
}

impl<T: AppTransport> Renderer<T> for DioxusRenderer<T> {
    fn attach(transport: T) -> Result<Self, TransportError> {
        let state = block_on_ready(transport.snapshot())?;
        Ok(Self { transport, state })
    }

    fn dispatch(&mut self, action: AppAction) -> Result<(), TransportError> {
        block_on_ready(self.transport.dispatch(action))?;
        self.state = block_on_ready(self.transport.snapshot())?;
        Ok(())
    }

    fn state(&self) -> &AppState {
        &self.state
    }

    fn painted(&self) -> Vec<String> {
        vec![render_html(&self.state)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The one line a host changes to swap renderers.
    ///
    /// Everything below is written against `optn_transport::run` and never
    /// names a renderer again. The same block exists in the other renderer's
    /// crate with this line pointing at that one, and asserts the same facts.
    type Ui<T> = DioxusRenderer<T>;

    /// Trusted wallet observations are prepared before the interface transport.
    fn initial_state() -> AppState {
        let opened = seed_wallet_preview(Network::Chipnet, "swap", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::SetStealthSats(50_000));
        state.apply(AppAction::Navigate(AppRoute::Settings));
        state
    }

    #[test]
    fn a_host_drives_this_renderer_without_naming_it() {
        // The host is `optn_transport::run`, shared and unchanged. Swapping
        // renderers is the `Ui` alias above and nothing else -- no different
        // host, no different actions, no different assertions.
        let transport = LocalTransport::new(initial_state());
        let script = [AppAction::Navigate(AppRoute::WalletHome)];
        let painted = optn_transport::run::<_, Ui<_>>(transport, &script).expect("run");

        // The same facts, from the same view models, whichever renderer drew.
        // Asserted on the screen as a whole rather than on exact fragments:
        // two renderers are entitled to lay one fact out differently -- this
        // one writes "wallet: swap", the other just "swap" -- and a host that
        // demanded identical strings would be testing the drawing, not the
        // seam.
        let screen = painted.join("\n");
        assert!(screen.contains("swap"), "the wallet name: {painted:?}");
        assert!(
            screen.contains("stealth"),
            "the RPA split reaches any renderer: {painted:?}"
        );
        for tab in ["Home", "Assets", "Actions", "Explore", "Settings"] {
            assert!(screen.contains(tab), "missing {tab}: {painted:?}");
        }
    }

    use optn_app::{seed_wallet_preview, AppSurface, Network, BIP39_TEST_VECTOR_MNEMONIC};
    use optn_transport::LocalTransport;

    #[test]
    fn nothing_here_needs_a_window_or_a_wallet_dependency() {
        let html = render_html(&AppState::for_surface(AppSurface::Desktop));
        assert!(html.contains("OPTN Wallet"), "{html}");
        assert!(html.contains("Create wallet"), "{html}");
        assert!(html.contains("Create watch-only wallet"), "{html}");
        assert!(html.contains("Connect hardware wallet"), "{html}");
    }
}
