#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;
#[cfg(target_arch = "wasm32")]
use leptos::reactive::owner::LocalStorage;
#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
use optn_app::AppSurface;
#[cfg(target_arch = "wasm32")]
use optn_app::{
    onboarding_view_model, watch_only_setup_preview, AppAction, AppRoute, AppState, Network,
    ThemeMode, WatchOnlySetupPreview,
};
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
fn WatchOnlySetup(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let wallet_name = RwSignal::new(String::new());
    let account_xpub = RwSignal::new(String::new());
    let master_fingerprint = RwSignal::new(String::new());
    let preview = RwSignal::new(None::<WatchOnlySetupPreview>);
    let error = RwSignal::new(None::<String>);

    let validate = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let current = state.get_untracked();
        match watch_only_setup_preview(
            current.network,
            &wallet_name.get_untracked(),
            &account_xpub.get_untracked(),
            &master_fingerprint.get_untracked(),
        ) {
            Ok(next) => {
                error.set(None);
                preview.set(Some(next));
            }
            Err(message) => {
                preview.set(None);
                error.set(Some(message));
            }
        }
    };

    view! {
        <section class="watch-only-page">
            <section class="watch-only-card">
                <button
                    class="text-button"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::Navigate(AppRoute::Landing),
                    )
                >
                    "← Back"
                </button>

                <p class="eyebrow">"Public keys only"</p>
                <h1>"Create Watch-Only Wallet"</h1>
                <p class="description">
                    "Import an account xPub without importing a seed or private key. "
                    "The optional master fingerprint is stored as public PSBT origin metadata "
                    "so an air-gapped signer can identify its inputs."
                </p>

                <div class="network-picker" role="group" aria-label="Wallet network">
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().network == Network::Mainnet
                        on:click=move |_| {
                            preview.set(None);
                            error.set(None);
                            dispatch_action(transport, state, AppAction::SetNetwork(Network::Mainnet));
                        }
                    >
                        "Mainnet"
                    </button>
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().network == Network::Chipnet
                        on:click=move |_| {
                            preview.set(None);
                            error.set(None);
                            dispatch_action(transport, state, AppAction::SetNetwork(Network::Chipnet));
                        }
                    >
                        "Chipnet"
                    </button>
                </div>

                <form class="watch-only-form" on:submit=validate>
                    <label class="field">
                        <span>"Wallet name"</span>
                        <input
                            type="text"
                            maxlength="80"
                            autocomplete="off"
                            placeholder="Watch-only wallet"
                            prop:value=move || wallet_name.get()
                            on:input=move |event| {
                                wallet_name.set(event_target_value(&event));
                                preview.set(None);
                                error.set(None);
                            }
                        />
                    </label>

                    <label class="field">
                        <span>"Account xPub"</span>
                        <textarea
                            rows="4"
                            spellcheck="false"
                            autocomplete="off"
                            placeholder="xpub… or tpub… exported at the BIP44 account level"
                            prop:value=move || account_xpub.get()
                            on:input=move |event| {
                                account_xpub.set(event_target_value(&event));
                                preview.set(None);
                                error.set(None);
                            }
                        ></textarea>
                        <small>
                            {move || match state.get().network {
                                Network::Mainnet => "Expected account path: m/44'/145'/account'",
                                Network::Chipnet => "Expected account path: m/44'/1'/account'",
                            }}
                        </small>
                    </label>

                    <label class="field">
                        <span>"Master fingerprint (optional)"</span>
                        <input
                            type="text"
                            inputmode="text"
                            maxlength="8"
                            autocomplete="off"
                            autocapitalize="none"
                            placeholder="4c9a1f7b"
                            prop:value=move || master_fingerprint.get()
                            on:input=move |event| {
                                master_fingerprint.set(event_target_value(&event));
                                preview.set(None);
                                error.set(None);
                            }
                        />
                        <small>"Exactly 8 hexadecimal characters when provided."</small>
                    </label>

                    <Show when=move || error.get().is_some()>
                        <p class="form-error" role="alert">
                            {move || error.get().unwrap_or_default()}
                        </p>
                    </Show>

                    <button class="primary form-submit" type="submit">
                        "Validate public account"
                    </button>
                </form>

                <Show when=move || preview.get().is_some()>
                    <section class="watch-preview" aria-live="polite">
                        <div class="preview-heading">
                            <div>
                                <p class="eyebrow">"Validated by optn-core"</p>
                                <h2>{move || {
                                    preview
                                        .get()
                                        .map(|value| value.wallet_name)
                                        .unwrap_or_default()
                                }}</h2>
                            </div>
                            <span class="success-badge">"Public-only"</span>
                        </div>

                        <dl class="preview-grid">
                            <div>
                                <dt>"Account path"</dt>
                                <dd>{move || {
                                    preview
                                        .get()
                                        .map(|value| value.account_path)
                                        .unwrap_or_default()
                                }}</dd>
                            </div>
                            <div>
                                <dt>"Master fingerprint"</dt>
                                <dd>{move || {
                                    preview
                                        .get()
                                        .and_then(|value| value.master_fingerprint)
                                        .unwrap_or_else(|| "Not set".to_string())
                                }}</dd>
                            </div>
                            <div class="preview-wide">
                                <dt>"First receive address"</dt>
                                <dd>{move || {
                                    preview
                                        .get()
                                        .map(|value| value.receive_address)
                                        .unwrap_or_default()
                                }}</dd>
                            </div>
                            <div class="preview-wide">
                                <dt>"Token-aware receive address"</dt>
                                <dd>{move || {
                                    preview
                                        .get()
                                        .map(|value| value.receive_token_address)
                                        .unwrap_or_default()
                                }}</dd>
                            </div>
                            <div class="preview-wide">
                                <dt>"First change address"</dt>
                                <dd>{move || {
                                    preview
                                        .get()
                                        .map(|value| value.change_address)
                                        .unwrap_or_default()
                                }}</dd>
                            </div>
                        </dl>

                        <p class="migration-note">
                            "This Rust renderer now validates the same public account model. "
                            "During the alpha migration, wallet persistence remains on the existing "
                            "shared production database path rather than creating a second store."
                        </p>
                    </section>
                </Show>
            </section>
        </section>
    }
}

#[cfg(target_arch = "wasm32")]
#[component]
fn Landing(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
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
    }
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

            <Show
                when=move || state.get().route == AppRoute::WatchOnlyWallet
                fallback=move || view! { <Landing transport=transport state=state /> }
            >
                <WatchOnlySetup transport=transport state=state />
            </Show>

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
                            "Create a new wallet, import an existing one, or validate a watch-only "
                            "account xPub. This Rust renderer receives state through a shell-agnostic transport."
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
