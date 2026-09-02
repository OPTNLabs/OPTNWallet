#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;
#[cfg(target_arch = "wasm32")]
use optn_app::{onboarding_view_model, AppAction, AppState, ThemeMode};
#[cfg(target_arch = "wasm32")]
use optn_transport::{AppTransport, LocalTransport};

#[cfg(target_arch = "wasm32")]
fn dispatch_action(
    transport: StoredValue<LocalTransport>,
    state: RwSignal<AppState>,
    action: AppAction,
) {
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
fn App() -> impl IntoView {
    let initial_state = AppState::default();
    let state = RwSignal::new(initial_state.clone());
    let transport = StoredValue::new(LocalTransport::new(initial_state));

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
                        "Leptos renders the UI, but application state and routes live "
                        <code>"optn-app"</code>
                        ", so the UI framework remains replaceable."
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
                        >
                            "Create wallet"
                        </a>
                        <a
                            class="secondary"
                            href={onboarding_view_model(&AppState::default()).import_wallet_href}
                        >
                            "Import wallet"
                        </a>
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
                            "This is the first Rust-authored UI slice over framework-neutral state."
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
    leptos::mount::mount_to_body(|| view! { <App /> });
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    println!("optn-ui is a Leptos CSR frontend; build it for wasm32-unknown-unknown.");
}
