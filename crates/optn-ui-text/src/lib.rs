#![forbid(unsafe_code)]

//! A second renderer, deliberately not Leptos.
//!
//! "The renderer is replaceable" is a claim that is either tested or false.
//! This crate is the test. It draws every screen as text from the same
//! `optn-app` view models the Leptos renderer uses, and drives them through
//! the same `optn_transport::AppTransport`. It has no UI framework, no shell,
//! and no async runtime.
//!
//! Two things follow, and both are enforced rather than documented:
//!
//! - If a screen's content ever moves into Leptos components, this renderer
//!   cannot draw it and its tests fail. Wallet decisions have to stay in
//!   `optn-app` for both renderers to agree.
//! - If a UI framework type leaks into `optn-app` or `optn-transport`, this
//!   crate stops compiling, because it depends on those two and nothing else.
//!
//! A Dioxus or egui renderer would be written exactly like this one: swap the
//! drawing, keep the view models and the transport. That is the whole of what
//! "swappable renderer" has to mean.
//!
//! The futures here are polled with a no-op waker rather than a runtime.
//! `LocalTransport`'s futures are already-ready, and taking a runtime
//! dependency would weaken the point this crate exists to make.

pub mod shell;

use std::future::Future;
use std::task::{Context, Poll, Waker};

use optn_app::{
    coins_view_model, flipstarter_view_model, format_bch, fundme_view_model, hardware_view_model,
    history_view_model, onboarding_actions, product_nav, settings_view_model, AppAction, AppRoute,
    AppState, OnboardingAction, WalletKind,
};
use optn_transport::{AppTransport, TransportError};

/// Poll an already-ready future to completion.
///
/// Deliberately not an async runtime: a renderer proving portability must not
/// need one.
fn now<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("this renderer only drives already-ready transports"),
    }
}

/// One screen, drawn as lines of text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub title: String,
    pub lines: Vec<String>,
    /// What the user could do next, as stable ids.
    pub actions: Vec<String>,
}

impl Screen {
    pub fn render(&self) -> String {
        let mut out = String::from(&self.title);
        for line in &self.lines {
            out.push('\n');
            out.push_str(line);
        }
        for action in &self.actions {
            out.push_str("\n[");
            out.push_str(action);
            out.push(']');
        }
        out
    }
}

fn onboarding_action_id(action: OnboardingAction) -> &'static str {
    match action {
        OnboardingAction::CreateWallet => "create-wallet",
        OnboardingAction::ImportWallet => "import-wallet",
        OnboardingAction::CreateWatchOnlyWallet => "watch-only-landing-action",
        OnboardingAction::ConnectHardwareWallet => "connect-hardware-wallet",
    }
}

fn wallet_chrome(state: &AppState) -> Vec<String> {
    product_nav(state)
        .into_iter()
        .map(|item| {
            let marker = if item.is_active(state.route) {
                "*"
            } else {
                " "
            };
            format!("{marker}{}", item.label())
        })
        .collect()
}

/// Draw the current screen from application state alone.
///
/// Every branch reads a view model. Nothing here decides anything about a
/// wallet, which is why a different renderer can produce the same screens.
pub fn draw(state: &AppState) -> Screen {
    let mut lines = Vec::new();
    let mut actions = Vec::new();

    let title = match state.route {
        AppRoute::Landing => {
            let vm = onboarding_view(state);
            lines.push(format!("network: {}", vm.0));
            for action in onboarding_actions(state) {
                actions.push(onboarding_action_id(action).to_string());
            }
            "OPTN Wallet".to_string()
        }
        AppRoute::CreateWallet | AppRoute::ImportWallet => {
            lines.push(format!("network: {}", state.network));
            actions.push("derivation-picker".into());
            state.route.section_title().to_string()
        }
        AppRoute::WatchOnlyWallet => {
            lines.push("account xPub, cosigners, or an air-gapped device".into());
            actions.push("multisig-section".into());
            actions.push("hardware-section".into());
            actions.push("airgap-section".into());
            state.route.section_title().to_string()
        }
        AppRoute::HardwareWallet => {
            let vm = hardware_view_model(state);
            lines.push(format!("available: {}", vm.available));
            for vendor in vm.vendors {
                actions.push(format!("hardware-{}", vendor.id()));
            }
            state.route.section_title().to_string()
        }
        AppRoute::WalletHome => {
            lines.extend(wallet_chrome(state));
            let totals = optn_app::portfolio_totals(state);
            lines.push(format!("total {}", format_bch(totals.total_sats())));
            if let Some(split) = totals.split_label() {
                lines.push(split);
            }
            if let Some(wallet) = state.wallet.as_ref() {
                lines.push(format!("wallet: {}", wallet.name));
                lines.push(format!("receive: {}", wallet.receive_address));
                if let Some(policy) = wallet.multisig_policy.as_ref() {
                    lines.push(format!("multisig: {policy}"));
                }
            }
            actions.push("send".into());
            actions.push("receive".into());
            "Home".to_string()
        }
        AppRoute::Coins => {
            let coins = coins_view_model(state);
            lines.extend(wallet_chrome(state));
            lines.push(format!("spendable {}", format_bch(coins.spendable_sats)));
            lines.push(format!("reserved {}", format_bch(coins.reserved_sats)));
            for coin in coins.coins {
                lines.push(format!(
                    "{} {}{}",
                    coin.outpoint(),
                    format_bch(coin.value_sats()),
                    coin.fusion_label()
                        .map(|chip| format!(" [{chip}]"))
                        .unwrap_or_default()
                ));
            }
            "Assets".to_string()
        }
        AppRoute::Settings => {
            let vm = settings_view_model(state);
            lines.extend(wallet_chrome(state));
            lines.push(format!("network: {}", vm.network));
            lines.push(format!("derivation: {}", vm.derivation_path));
            lines.push(format!("electrum: {}", vm.electrum_endpoint));
            if let Some(vendor) = vm.hardware.vendor {
                lines.push(format!(
                    "device: {} {} {}",
                    vendor.label(),
                    if vm.hardware.connected {
                        "connected"
                    } else {
                        "not connected"
                    },
                    vm.hardware.device_label.as_deref().unwrap_or("-")
                ));
                if vm.hardware.offers_link_choice() {
                    lines.push(format!("link: {}", vm.hardware.ledger_link.label()));
                }
            }
            for row in vm.rows {
                actions.push(row.title().to_string());
            }
            "Settings".to_string()
        }
        AppRoute::History => {
            let vm = history_view_model(state);
            lines.extend(wallet_chrome(state));
            for entry in vm.entries {
                lines.push(format!(
                    "{:?} {} {}",
                    entry.kind,
                    format_bch(entry.amount_sats),
                    entry.txid
                ));
            }
            "History".to_string()
        }
        AppRoute::Flipstarter => {
            let vm = flipstarter_view_model(state);
            lines.extend(wallet_chrome(state));
            lines.push(format!("pledges: {}", vm.pledges.len()));
            "Flipstarter".to_string()
        }
        AppRoute::FundMe => {
            let vm = fundme_view_model(state);
            lines.extend(wallet_chrome(state));
            lines.push(vm.product.name.to_string());
            "FundMe".to_string()
        }
        AppRoute::Receive => {
            lines.extend(wallet_chrome(state));
            match state.wallet.as_ref() {
                Some(wallet) => {
                    lines.push(match wallet.kind {
                        WalletKind::Seed => "seed wallet".into(),
                        WalletKind::WatchOnly => "watch-only".into(),
                        WalletKind::Hardware => "hardware wallet".into(),
                    });
                    lines.push(wallet.receive_address.clone());
                }
                None => lines.push("no wallet".into()),
            }
            "Receive".to_string()
        }
        AppRoute::Send => {
            lines.extend(wallet_chrome(state));
            if let Some(plan) = state.spend.as_ref() {
                lines.push(format!("{} sats to {}", plan.amount_sats, plan.destination));
            }
            "Send".to_string()
        }
        AppRoute::Actions => {
            lines.extend(wallet_chrome(state));
            "Actions".to_string()
        }
        AppRoute::Explore => {
            lines.extend(wallet_chrome(state));
            "Explore".to_string()
        }
    };

    if let Some(notice) = state.notice.as_ref() {
        lines.push(format!("notice: {notice}"));
    }

    Screen {
        title,
        lines,
        actions,
    }
}

fn onboarding_view(state: &AppState) -> (String,) {
    (optn_app::onboarding_view_model(state)
        .network_prefix
        .to_string(),)
}

/// Drives the wallet through a transport, exactly as the Leptos renderer does.
pub struct TextRenderer<T: AppTransport> {
    transport: T,
    state: AppState,
}

impl<T: AppTransport> TextRenderer<T> {
    /// Take the first snapshot, as any renderer must before drawing.
    pub fn attach(transport: T) -> Result<Self, TransportError> {
        let state = now(transport.snapshot())?;
        Ok(Self { transport, state })
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    pub fn screen(&self) -> Screen {
        draw(&self.state)
    }

    /// Dispatch and re-read, which is the whole renderer/application contract.
    pub fn dispatch(&mut self, action: AppAction) -> Result<(), TransportError> {
        now(self.transport.dispatch(action))?;
        self.state = now(self.transport.snapshot())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{
        seed_wallet_preview, AccountPath, AppSurface, Network, BIP39_TEST_VECTOR_MNEMONIC,
    };
    use optn_transport::LocalTransport;

    fn renderer(surface: AppSurface) -> TextRenderer<LocalTransport> {
        TextRenderer::attach(LocalTransport::new(AppState::for_surface(surface)))
            .expect("a local transport always answers")
    }

    #[test]
    fn a_non_leptos_renderer_drives_the_whole_onboarding_flow() {
        // The point of this crate. Nothing below mentions a UI framework.
        let mut ui = renderer(AppSurface::Desktop);

        let landing = ui.screen();
        assert_eq!(landing.title, "OPTN Wallet");
        assert!(
            landing
                .actions
                .contains(&"watch-only-landing-action".into()),
            "Watch Only must reach every renderer, not just Leptos: {landing:?}"
        );
        assert!(landing.actions.contains(&"create-wallet".into()));

        ui.dispatch(AppAction::SetNetwork(Network::Chipnet))
            .unwrap();
        ui.dispatch(AppAction::Navigate(AppRoute::CreateWallet))
            .unwrap();
        assert_eq!(ui.screen().title, "Create wallet");

        // Open a real wallet, derived by the shared core.
        let opened = seed_wallet_preview(
            Network::Chipnet,
            "text renderer",
            BIP39_TEST_VECTOR_MNEMONIC,
        )
        .expect("preview");
        ui.dispatch(AppAction::OpenCreatedWallet {
            name: opened.name.clone(),
            receive_address: opened.receive_address.clone(),
            account_path: opened.account_path.clone(),
        })
        .unwrap();

        let home = ui.screen();
        assert_eq!(home.title, "Home");
        assert!(home.render().contains(&opened.receive_address));
        assert!(home.lines.iter().any(|l| l.starts_with("total ")));

        // The blueprint's five destinations, from the same nav the Leptos
        // renderer draws.
        assert_eq!(
            home.lines
                .iter()
                .filter(|l| l.starts_with('*') || l.starts_with(' '))
                .count(),
            5
        );
        assert!(home.lines.contains(&"*Home".to_string()));

        ui.dispatch(AppAction::Navigate(AppRoute::Settings))
            .unwrap();
        let settings = ui.screen();
        assert_eq!(settings.title, "Settings");
        assert!(settings.render().contains("derivation: m/44'/1'/0'"));
        assert!(settings.actions.iter().any(|a| a == "Derivation Path"));
    }

    #[test]
    fn a_chosen_account_reaches_this_renderer_too() {
        // A wallet opened at a non-default account must report that account in
        // any renderer, or the two disagree about which branch it lives on.
        let chosen = AccountPath::new(145, 1).expect("in range");
        let opened = optn_app::seed_wallet_preview_at(
            Network::Mainnet,
            "second account",
            BIP39_TEST_VECTOR_MNEMONIC,
            chosen,
        )
        .expect("preview");

        let mut ui = renderer(AppSurface::Desktop);
        ui.dispatch(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        })
        .unwrap();
        ui.dispatch(AppAction::Navigate(AppRoute::Settings))
            .unwrap();
        assert!(ui.screen().render().contains("derivation: m/44'/145'/1'"));
    }

    #[test]
    fn a_feature_added_after_this_renderer_existed_still_reaches_it() {
        // The device fields and the server override were both built after this
        // crate. Neither needed a change here beyond drawing them, which is
        // what "the renderer is replaceable" has to mean in practice: a
        // feature lands in optn-app and every renderer can show it.
        let mut ui = renderer(AppSurface::Desktop);
        ui.dispatch(AppAction::SelectHardwareVendor(Some(
            optn_app::HardwareVendor::Ledger,
        )))
        .unwrap();
        ui.dispatch(AppAction::SetLedgerLink(optn_app::LedgerLink::Bluetooth))
            .unwrap();
        ui.dispatch(AppAction::HardwareConnected {
            label: "Nano X".into(),
            account_xpub: "xpub-under-test".into(),
        })
        .unwrap();
        ui.dispatch(AppAction::SetServer {
            kind: optn_app::ServerKind::Electrum,
            entry: "fulcrum.example:50002".into(),
        })
        .unwrap();

        let opened = seed_wallet_preview(
            Network::Chipnet,
            "device wallet",
            BIP39_TEST_VECTOR_MNEMONIC,
        )
        .expect("preview");
        ui.dispatch(AppAction::SetNetwork(Network::Chipnet))
            .unwrap();
        ui.dispatch(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        })
        .unwrap();
        ui.dispatch(AppAction::Navigate(AppRoute::Settings))
            .unwrap();

        let screen = ui.screen().render();
        assert!(
            screen.contains("device: Ledger connected Nano X"),
            "{screen}"
        );
        assert!(screen.contains("link: Bluetooth"), "{screen}");
        assert!(
            ui.screen().actions.iter().any(|a| a == "Hardware device"),
            "the device row must be offered on desktop"
        );

        // The override was set on mainnet; chipnet must not have inherited it.
        assert!(
            !screen.contains("fulcrum.example"),
            "a mainnet server must not leak into chipnet settings: {screen}"
        );
    }

    #[test]
    fn every_route_draws_something_in_a_second_renderer() {
        // If a screen only exists inside Leptos components, it cannot be drawn
        // here and this fails — which is the drift this crate is meant to
        // catch.
        let mut ui = renderer(AppSurface::Desktop);
        let opened = seed_wallet_preview(Network::Chipnet, "coverage", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        ui.dispatch(AppAction::SetNetwork(Network::Chipnet))
            .unwrap();
        ui.dispatch(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        })
        .unwrap();

        for route in [
            AppRoute::WalletHome,
            AppRoute::Coins,
            AppRoute::Actions,
            AppRoute::Explore,
            AppRoute::History,
            AppRoute::Settings,
            AppRoute::Receive,
            AppRoute::Send,
            AppRoute::Flipstarter,
            AppRoute::FundMe,
        ] {
            ui.dispatch(AppAction::Navigate(route)).unwrap();
            let screen = ui.screen();
            assert!(!screen.title.is_empty(), "{route:?} drew no title");
            assert!(!screen.render().is_empty(), "{route:?} drew nothing");
        }
    }

    #[test]
    fn the_surface_capability_matrix_holds_in_any_renderer() {
        // Hardware is desktop-only and Watch Only is everywhere. A renderer
        // cannot widen that, because the list comes from the application.
        let desktop = renderer(AppSurface::Desktop);
        assert!(desktop
            .screen()
            .actions
            .contains(&"connect-hardware-wallet".into()));

        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let ui = renderer(surface);
            let actions = ui.screen().actions;
            assert!(
                !actions.contains(&"connect-hardware-wallet".into()),
                "{surface:?} has no USB"
            );
            assert!(
                actions.contains(&"watch-only-landing-action".into()),
                "{surface:?} keeps Watch Only"
            );
        }
    }

    #[test]
    fn the_extension_nav_differs_here_exactly_as_it_does_in_leptos() {
        let mut ui = renderer(AppSurface::Extension);
        let opened = seed_wallet_preview(Network::Chipnet, "popup", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        ui.dispatch(AppAction::SetNetwork(Network::Chipnet))
            .unwrap();
        ui.dispatch(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        })
        .unwrap();

        let nav: Vec<String> = ui
            .screen()
            .lines
            .into_iter()
            .filter(|l| l.starts_with('*') || l.starts_with(' '))
            .map(|l| l.trim_start_matches(['*', ' ']).to_string())
            .collect();
        assert_eq!(nav, vec!["Home", "Assets", "Receive", "History"]);
    }
}
