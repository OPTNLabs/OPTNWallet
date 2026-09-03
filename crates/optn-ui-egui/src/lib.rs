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
use optn_transport::{block_on_ready, AppTransport, Renderer, TransportError};

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
    if vm.hardware.vendor.is_some() {
        // Resolved application-side, so this renderer holds no fallback rule.
        ui.label(format!("device path: {}", vm.hardware_derivation_path));
        if let Some(warning) = vm.hardware_path_warning.as_deref() {
            ui.label(RichText::new(warning).strong());
        }
    }
    if ui.button("Toggle theme").clicked() {
        intent.raise(AppAction::ToggleTheme);
    }
}

/// This renderer, attached to a transport and holding the state it last drew.
///
/// egui is immediate mode, so there is no widget tree to keep -- only the
/// `Context`, which owns the retained interaction state a real toolkit needs
/// between frames, and the snapshot the next frame will be built from.
pub struct EguiRenderer<T: AppTransport> {
    transport: T,
    state: AppState,
    ctx: egui::Context,
    /// The viewport a host gives this renderer. Fixed here because there is no
    /// window to ask.
    viewport: egui::Rect,
}

impl<T: AppTransport> EguiRenderer<T> {
    /// Build one frame and return what egui laid out, as text.
    fn frame(&self) -> Vec<String> {
        let input = egui::RawInput {
            screen_rect: Some(self.viewport),
            ..Default::default()
        };
        let output = self.ctx.run_ui(input, |ui| {
            let _ = draw(ui, &self.state);
        });
        let mut painted = Vec::new();
        for clipped in &output.shapes {
            collect_text(&clipped.shape, &mut painted);
        }
        // egui panics if a texture delta is dropped unapplied, and there is no
        // painter here to apply one to.
        output.drop_without_applying_deltas();
        painted
    }
}

fn collect_text(shape: &egui::epaint::Shape, out: &mut Vec<String>) {
    match shape {
        egui::epaint::Shape::Text(text) => out.push(text.galley.text().to_owned()),
        egui::epaint::Shape::Vec(shapes) => {
            for inner in shapes {
                collect_text(inner, out);
            }
        }
        _ => {}
    }
}

/// The host seam, satisfied by a renderer built on a real GUI toolkit.
///
/// The same trait `optn-ui-text` implements with no framework at all. A host
/// written against `optn_transport::run` drives either one, which is what makes
/// swapping them a type rather than a migration.
impl<T: AppTransport> Renderer<T> for EguiRenderer<T> {
    fn attach(transport: T) -> Result<Self, TransportError> {
        let state = block_on_ready(transport.snapshot())?;
        Ok(Self {
            transport,
            state,
            ctx: egui::Context::default(),
            viewport: egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(520.0, 800.0)),
        })
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
        self.frame()
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
    type Ui<T> = EguiRenderer<T>;

    /// A wallet being opened and looked at, as actions alone.
    fn script() -> Vec<AppAction> {
        let opened = seed_wallet_preview(Network::Chipnet, "swap", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        vec![
            AppAction::SetNetwork(Network::Chipnet),
            AppAction::OpenCreatedWallet {
                name: opened.name,
                receive_address: opened.receive_address,
                account_path: opened.account_path,
            },
            AppAction::SetStealthSats(50_000),
        ]
    }

    #[test]
    fn a_host_drives_this_renderer_without_naming_it() {
        // The host is `optn_transport::run`, shared and unchanged. Swapping
        // renderers is the `Ui` alias above and nothing else -- no different
        // host, no different actions, no different assertions.
        let transport = LocalTransport::new(AppState::for_surface(AppSurface::Desktop));
        let painted = optn_transport::run::<_, Ui<_>>(transport, &script()).expect("run");

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

    use egui::{vec2, Context, Event, Modifiers, PointerButton, Pos2, RawInput, Rect};
    use optn_app::{seed_wallet_preview, AppSurface, Network, BIP39_TEST_VECTOR_MNEMONIC};
    use optn_transport::LocalTransport;

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
        // The device's account reaches a third renderer already resolved. This
        // wallet chose nothing, so it must show the wallet's own account -- and
        // this renderer holds no rule that could produce that.
        assert!(
            text.iter()
                .any(|t| t.contains("device path: m/44'/145'/0'")),
            "the resolved account must reach every renderer: {text:?}"
        );
    }

    #[test]
    fn a_device_account_this_network_never_scans_is_flagged_in_every_renderer() {
        // The warning is the application's, and it has to survive the swap: a
        // renderer that quietly dropped it would leave a stale account signing
        // with nothing on screen to say so.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::SelectHardwareVendor(Some(
            optn_app::HardwareVendor::Keystone,
        )));
        state.apply(AppAction::SetHardwareDerivationPath(Some(
            optn_app::AccountPath::new(9999, 0).expect("in range"),
        )));
        let opened = seed_wallet_preview(Network::Chipnet, "hw", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::Navigate(AppRoute::Settings));

        let text = painted_text(&state);
        assert!(
            text.iter().any(|t| t.contains("m/44'/9999'/0'")),
            "the chosen account is kept as chosen: {text:?}"
        );
        assert!(
            text.iter()
                .any(|t| t.contains("is not an account this wallet scans")),
            "and the warning travels with it: {text:?}"
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
