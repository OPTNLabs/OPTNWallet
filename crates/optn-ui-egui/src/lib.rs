#![forbid(unsafe_code)]

//! A third renderer, on a real GUI toolkit.
//!
//! `optn-ui-text` showed a renderer needs only `optn-app` and
//! `optn-transport`. That is a strong argument but a weak demonstration,
//! because plain text can dodge anything awkward. This one is built on egui —
//! immediate mode, retained widget state, its own event model — and still
//! needs nothing else. Swapping Leptos for a native toolkit is this file, not
//! a migration.
//!
//! Screens come from the same view models the Leptos and text renderers use,
//! and every interaction leaves as an `AppAction` through the same transport.
//! Nothing here decides anything about a wallet.
//!
//! It runs under `egui::Context::run_ui`, which builds a frame with no window
//! and no windowing backend, so the tests exercise real layout and real click
//! resolution on any machine, including CI with no display. The crate is
//! excluded from the workspace so a windowing stack never reaches the riscv64
//! and armv7 cross builds.

use egui::{RichText, Ui};
use optn_app::{
    coins_view_model, format_bch, onboarding_actions, portfolio_totals, product_nav,
    settings_view_model, AppAction, AppRoute, AppState, OnboardingAction,
};

/// Actions raised by one frame, for the host to dispatch.
///
/// egui builds a frame synchronously while the transport is async, so intent
/// is collected rather than awaited mid-paint. The host drains this and
/// dispatches — which is also why no wallet decision can hide in a click
/// handler.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FrameIntent {
    pub actions: Vec<AppAction>,
}

impl FrameIntent {
    fn raise(&mut self, action: AppAction) {
        self.actions.push(action);
    }
}

fn onboarding_label(action: OnboardingAction) -> &'static str {
    match action {
        OnboardingAction::CreateWallet => "Create wallet",
        OnboardingAction::ImportWallet => "Import wallet",
        OnboardingAction::CreateWatchOnlyWallet => "Create watch-only wallet",
        OnboardingAction::ConnectHardwareWallet => "Connect hardware wallet",
    }
}

/// Draw the whole application into one `Ui`.
///
/// A `Ui` rather than a `Context`, because that is what a host hands a
/// renderer: the region it was given. Whether that region came from a window,
/// a panel or `Context::run_ui` with no window at all is the shell's business.
pub fn draw(ui: &mut Ui, state: &AppState) -> FrameIntent {
    let mut intent = FrameIntent::default();
    match state.route {
        AppRoute::Landing => landing(ui, state, &mut intent),
        AppRoute::Settings => settings(ui, state, &mut intent),
        _ => wallet(ui, state, &mut intent),
    }
    intent
}

fn landing(ui: &mut Ui, state: &AppState, intent: &mut FrameIntent) {
    ui.heading("OPTN Wallet");
    ui.label(format!("network: {}", state.network));
    // The list comes from the application, so this renderer cannot offer an
    // action the surface does not allow -- Watch Only everywhere, hardware on
    // desktop only, without knowing either rule.
    for action in onboarding_actions(state) {
        if ui.button(onboarding_label(action)).clicked() {
            if let Some(route) = action.route() {
                intent.raise(AppAction::Navigate(route));
            }
        }
    }
}

fn nav(ui: &mut Ui, state: &AppState, intent: &mut FrameIntent) {
    ui.horizontal_wrapped(|ui| {
        for item in product_nav(state) {
            let label = if item.is_active(state.route) {
                RichText::new(item.label()).strong()
            } else {
                RichText::new(item.label())
            };
            if ui.button(label).clicked() {
                intent.raise(AppAction::Navigate(item.route()));
            }
        }
    });
}

fn wallet(ui: &mut Ui, state: &AppState, intent: &mut FrameIntent) {
    nav(ui, state, intent);
    let totals = portfolio_totals(state);
    ui.heading(format_bch(totals.total_sats()));
    if let Some(split) = totals.split_label() {
        ui.label(split);
    }
    if let Some(wallet) = state.wallet.as_ref() {
        ui.label(&wallet.name);
        ui.monospace(&wallet.receive_address);
    }
    for coin in coins_view_model(state).coins {
        ui.horizontal_wrapped(|ui| {
            ui.monospace(coin.outpoint().to_string());
            ui.label(format_bch(coin.value_sats()));
            if let Some(chip) = coin.fusion_label() {
                ui.label(RichText::new(chip).strong());
            }
        });
    }
}

fn settings(ui: &mut Ui, state: &AppState, intent: &mut FrameIntent) {
    nav(ui, state, intent);
    let vm = settings_view_model(state);
    ui.heading("Settings");
    ui.label(format!("network: {}", vm.network));
    ui.label(format!("derivation: {}", vm.derivation_path));
    ui.label(format!("electrum: {}", vm.electrum_endpoint));
    if let Some(vendor) = vm.hardware.vendor {
        ui.label(format!(
            "device: {} {}",
            vendor.label(),
            if vm.hardware.connected {
                "connected"
            } else {
                "not connected"
            }
        ));
    }
    if ui.button("Toggle theme").clicked() {
        intent.raise(AppAction::ToggleTheme);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::{vec2, Context, Event, Modifiers, PointerButton, Pos2, RawInput, Rect};
    use optn_app::{seed_wallet_preview, AppSurface, Network, BIP39_TEST_VECTOR_MNEMONIC};

    /// A pinned viewport, so layout is identical on every machine.
    fn viewport() -> RawInput {
        RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(520.0, 800.0))),
            ..Default::default()
        }
    }

    /// Run one frame with no window, returning what it raised and every text
    /// fragment egui actually laid out, with where it put it.
    fn run_frame(ctx: &Context, input: RawInput, state: &AppState) -> (FrameIntent, Vec<Painted>) {
        let mut intent = FrameIntent::default();
        let output = ctx.run_ui(input, |ui| {
            intent = draw(ui, state);
        });
        let mut painted = Vec::new();
        for clipped in &output.shapes {
            collect(&clipped.shape, &mut painted);
        }
        // `TexturesDelta` panics if it is dropped with deltas still unapplied.
        // There is no painter here to apply them to, which is the whole point.
        output.drop_without_applying_deltas();
        (intent, painted)
    }

    /// One laid-out run of text and its top-left corner.
    type Painted = (String, Pos2);

    fn collect(shape: &egui::epaint::Shape, out: &mut Vec<Painted>) {
        match shape {
            egui::epaint::Shape::Text(text) => {
                out.push((text.galley.text().to_owned(), text.pos));
            }
            egui::epaint::Shape::Vec(shapes) => {
                for inner in shapes {
                    collect(inner, out);
                }
            }
            _ => {}
        }
    }

    fn painted_text(state: &AppState) -> Vec<String> {
        let (_, painted) = run_frame(&Context::default(), viewport(), state);
        painted.into_iter().map(|(text, _)| text).collect()
    }

    fn pointer(pos: Pos2, pressed: bool) -> Event {
        Event::PointerButton {
            pos,
            button: PointerButton::Primary,
            pressed,
            modifiers: Modifiers::default(),
        }
    }

    /// Click the control egui painted with this label, and report what the
    /// renderer raised. A real press and release, resolved by egui against the
    /// widget rects of the previous pass — not a call to a handler.
    fn click(state: &AppState, label: &str) -> FrameIntent {
        let ctx = Context::default();

        // Pass one lays the widgets out and tells us where they landed.
        let (idle, painted) = run_frame(&ctx, viewport(), state);
        assert!(idle.actions.is_empty(), "an idle frame raises nothing");
        let (_, origin) = painted
            .iter()
            .find(|(text, _)| text == label)
            .unwrap_or_else(|| panic!("egui never painted {label:?}: {painted:?}"));
        // A few points into the glyphs, so the point is inside the control.
        let spot = *origin + vec2(4.0, 4.0);

        let mut press = viewport();
        press.events.push(Event::PointerMoved(spot));
        press.events.push(pointer(spot, true));
        let (held, _) = run_frame(&ctx, press, state);
        assert!(held.actions.is_empty(), "a press alone is not a click");

        let mut release = viewport();
        release.events.push(pointer(spot, false));
        run_frame(&ctx, release, state).0
    }

    #[test]
    fn a_real_gui_toolkit_renders_the_landing_from_the_same_view_models() {
        // Not a mock: egui lays these out with its own layout engine.
        let state = AppState::for_surface(AppSurface::Desktop);
        let text = painted_text(&state);
        assert!(text.iter().any(|t| t == "OPTN Wallet"), "{text:?}");
        assert!(text.iter().any(|t| t == "Create wallet"), "{text:?}");
        assert!(
            text.iter().any(|t| t == "Create watch-only wallet"),
            "Watch Only must reach a third renderer too: {text:?}"
        );
        assert!(
            text.iter().any(|t| t == "Connect hardware wallet"),
            "the landing page offers a device: {text:?}"
        );
    }

    #[test]
    fn the_surface_matrix_holds_here_without_this_renderer_knowing_the_rules() {
        // The list is the application's. A renderer cannot widen it, and does
        // not contain the rule that would let it try.
        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let text = painted_text(&AppState::for_surface(surface));
            assert!(
                !text.iter().any(|t| t == "Connect hardware wallet"),
                "{surface:?} has no USB: {text:?}"
            );
            assert!(
                text.iter().any(|t| t == "Create watch-only wallet"),
                "{surface:?} keeps Watch Only: {text:?}"
            );
        }
    }

    #[test]
    fn a_click_leaves_as_an_app_action_and_decides_nothing_here() {
        let state = AppState::for_surface(AppSurface::Desktop);
        let intent = click(&state, "Create wallet");
        assert_eq!(
            intent.actions,
            vec![AppAction::Navigate(AppRoute::CreateWallet)],
            "a click produces intent and nothing else"
        );
    }

    #[test]
    fn the_hardware_button_on_the_landing_page_goes_into_watch_only() {
        // Where the old wallet put it: the device lives inside Watch Only,
        // not in a section of its own. A renderer does not get to relocate it,
        // and this one proves that without knowing the rule.
        let state = AppState::for_surface(AppSurface::Desktop);
        let intent = click(&state, "Connect hardware wallet");
        assert_eq!(
            intent.actions,
            vec![AppAction::Navigate(AppRoute::WatchOnlyWallet)]
        );
    }

    #[test]
    fn an_opened_wallet_draws_its_balance_and_nav_in_egui() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, "egui", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        let receive = opened.receive_address.clone();
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::SetStealthSats(50_000));

        let text = painted_text(&state);
        assert!(text.iter().any(|t| t == "egui"), "{text:?}");
        assert!(text.iter().any(|t| t == &receive), "{text:?}");
        // The stealth split reaches this renderer too, from the same totals.
        assert!(
            text.iter().any(|t| t.contains("stealth")),
            "the split must not be Leptos-only: {text:?}"
        );
        // And the blueprint's five destinations.
        for tab in ["Home", "Assets", "Actions", "Explore", "Settings"] {
            assert!(text.iter().any(|t| t == tab), "missing {tab}: {text:?}");
        }
    }

    #[test]
    fn settings_shows_the_device_and_the_effective_server_in_a_third_renderer() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SelectHardwareVendor(Some(
            optn_app::HardwareVendor::Trezor,
        )));
        state.apply(AppAction::SetServer {
            kind: optn_app::ServerKind::Electrum,
            entry: "fulcrum.example:50002".into(),
        });
        let opened = seed_wallet_preview(Network::Mainnet, "s", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::Navigate(AppRoute::Settings));

        let text = painted_text(&state);
        assert!(
            text.iter().any(|t| t.contains("Trezor")),
            "device fields reach every renderer: {text:?}"
        );
        assert!(
            text.iter().any(|t| t.contains("fulcrum.example:50002")),
            "the override, not the default: {text:?}"
        );
    }

    #[test]
    fn nothing_here_needs_a_window_or_a_wallet_dependency() {
        // The point of the crate: it compiled and ran against optn-app and
        // optn-transport alone, with no shell, no windowing backend and no
        // display -- and still painted a real frame.
        let ctx = Context::default();
        let (intent, painted) = run_frame(
            &ctx,
            viewport(),
            &AppState::for_surface(AppSurface::Desktop),
        );
        assert!(intent.actions.is_empty());
        assert!(!painted.is_empty(), "but it did paint");
        assert!(
            painted.iter().all(|(_, pos)| pos.x >= 0.0 && pos.y >= 0.0),
            "and laid out inside the viewport it was given: {painted:?}"
        );
    }
}
