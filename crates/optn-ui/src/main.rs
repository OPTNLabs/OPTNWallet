#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;
#[cfg(target_arch = "wasm32")]
use leptos::reactive::owner::LocalStorage;
#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
use optn_app::AppSurface;
#[cfg(target_arch = "wasm32")]
use optn_app::{onboarding_view_model, AppAction, AppRoute, AppState, ThemeMode};
#[cfg(target_arch = "wasm32")]
use optn_transport::AppTransport;
#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
use optn_transport::LocalTransport;
#[cfg(target_arch = "wasm32")]
use std::rc::Rc;

#[cfg(target_arch = "wasm32")]
type UiTransport = StoredValue<Rc<dyn AppTransport>, LocalStorage>;

#[cfg(all(target_arch = "wasm32", feature = "tauri-transport"))]
fn make_transport() -> Rc<dyn AppTransport> {
    Rc::new(optn_transport_tauri::TauriWebTransport)
}

#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
fn make_transport() -> Rc<dyn AppTransport> {
    Rc::new(LocalTransport::new(AppState::for_surface(AppSurface::Web)))
}

#[cfg(target_arch = "wasm32")]
fn dispatch_action(transport: UiTransport, state: RwSignal<AppState>, action: AppAction) {
    let transport = transport.get_value();
    leptos::task::spawn_local(async move {
        if transport.dispatch(action).await.is_ok() {
            if let Ok(snapshot) = transport.snapshot().await {
                state.set(snapshot);
            }
        }
    });
}

#[cfg(target_arch = "wasm32")]
#[component]
fn App(transport: Rc<dyn AppTransport>) -> impl IntoView {
    let state = RwSignal::new(AppState::default());
    let transport = StoredValue::new_local(transport);

    // The renderer never assumes where authoritative state lives. Local WASM
    // returns immediately; an IPC-backed provider can hydrate from native Rust.
    {
        let transport = transport.get_value();
        leptos::task::spawn_local(async move {
            if let Ok(snapshot) = transport.snapshot().await {
                state.set(snapshot);
            }
        });
    }

    view! {
        <main
            class="app-shell"
            class:dark=move || state.get().theme == ThemeMode::Dark
        >
            <header class="topbar">
                <div class="brand" aria-label="OPTN Wallet">"OPTN"</div>

                <button
                    class="chip"
                    type="button"
                    on:click=move |_| dispatch_action(transport, state, AppAction::ToggleTheme)
                    aria-label="Toggle theme"
                >
                    {move || {
                        if state.get().theme == ThemeMode::Dark {
                            "☀ Light"
                        } else {
                            "☾ Dark"
                        }
                    }}
                </button>

                <button
                    class="chip"
                    type="button"
                    on:click=move |_| dispatch_action(transport, state, AppAction::OpenHelp)
                >
                    "Help"
                </button>
            </header>

            <section class="landing">
                <div class="hero" aria-hidden="true">
                    <div class="hero-mark">"OPTN"</div>
                    <div class="hero-ring hero-ring-one"></div>
                    <div class="hero-ring hero-ring-two"></div>
                </div>

                <section class="wallet-card">
                    <p class="eyebrow">"Bitcoin Cash, owned by you"</p>
                    <h1>"A Rust-first OPTN Wallet"</h1>
                    <p class="description">
                        "Leptos renders the UI, while application state, transport, and platform "
                        "capabilities remain independently replaceable."
                    </p>

                    <div class="core-proof">
                        <span>"Shared-core network prefix"</span>
                        <strong>
                            {move || onboarding_view_model(&state.get()).network_prefix}
                        </strong>
                    </div>

                    <nav class="actions" aria-label="Wallet onboarding">
                        <a
                            class="primary"
                            href={onboarding_view_model(&AppState::default()).create_wallet_href}
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::CreateWallet),
                            )
                        >
                            "Create wallet"
                        </a>
                        <a
                            class="secondary"
                            href={onboarding_view_model(&AppState::default()).import_wallet_href}
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::ImportWallet),
                            )
                        >
                            "Import wallet"
                        </a>
                        <Show when=move || onboarding_view_model(&state.get()).show_hardware_wallet>
                            <button
                                class="secondary"
                                type="button"
                                disabled
                                title="Desktop USB hardware wallets"
                            >
                                "Connect hardware wallet"
                            </button>
                        </Show>
                        <Show when=move || onboarding_view_model(&state.get()).show_watch_only>
                            <a
                                class="secondary"
                                href={onboarding_view_model(&state.get()).watch_only_wallet_href}
                                on:click=move |_| dispatch_action(
                                    transport,
                                    state,
                                    AppAction::Navigate(AppRoute::WatchOnlyWallet),
                                )
                            >
                                "Create watch-only wallet"
                            </a>
                        </Show>
                    </nav>
                </section>
            </section>

            <Show when=move || onboarding_view_model(&state.get()).help_open>
                <div
                    class="modal-backdrop"
                    role="presentation"
                    on:click=move |_| dispatch_action(transport, state, AppAction::CloseHelp)
                >
                    <section
                        class="modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="help-title"
                        on:click=move |event| event.stop_propagation()
                    >
                        <h2 id="help-title">"Getting started"</h2>
                        <p>
                            "Create a new wallet or import an existing one. "
                            "This Rust renderer receives state through a shell-agnostic transport."
                        </p>
                        <button
                            class="primary"
                            type="button"
                            on:click=move |_| dispatch_action(transport, state, AppAction::CloseHelp)
                        >
                            "Close"
                        </button>
                    </section>
                </div>
            </Show>
        </main>
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    console_error_panic_hook::set_once();
    let transport = make_transport();
    leptos::mount::mount_to_body(move || view! { <App transport=transport.clone() /> });
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    println!("optn-ui is a Leptos CSR frontend; build it for wasm32-unknown-unknown.");
}
