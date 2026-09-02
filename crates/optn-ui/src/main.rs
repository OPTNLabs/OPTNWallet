#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;
#[cfg(target_arch = "wasm32")]
use leptos::reactive::owner::LocalStorage;
#[cfg(target_arch = "wasm32")]
mod tools;

#[cfg(target_arch = "wasm32")]
use optn_app::{
    onboarding_actions, onboarding_view_model, watch_only_setup_preview, AppAction, AppRoute,
    AppState, AppSurface, Network, OnboardingAction, ThemeMode, WatchOnlySetupPreview,
};
#[cfg(target_arch = "wasm32")]
use optn_transport::AppTransport;
#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
use optn_transport::LocalTransport;
#[cfg(target_arch = "wasm32")]
use std::rc::Rc;
#[cfg(target_arch = "wasm32")]
use tools::{
    ActionsPage, CoinsPage, ExplorePage, FlipstarterPage, FundMePage, SettingsPage, WalletHome,
};

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
fn LandingActionLink(
    transport: UiTransport,
    state: RwSignal<AppState>,
    action: OnboardingAction,
) -> impl IntoView {
    let class = if matches!(action, OnboardingAction::CreateWallet) {
        "primary"
    } else {
        "secondary"
    };
    let label = match action {
        OnboardingAction::CreateWallet => "Create wallet",
        OnboardingAction::ImportWallet => "Import wallet",
        OnboardingAction::CreateWatchOnlyWallet => "Create watch-only wallet",
        OnboardingAction::ConnectHardwareWallet => "Connect hardware wallet",
    };

    match (action.route(), action.href()) {
        (Some(route), Some(href)) => view! {
            <a
                class=class
                href=href
                attr:data-testid=if matches!(action, OnboardingAction::CreateWatchOnlyWallet) {
                    "watch-only-landing-action"
                } else {
                    ""
                }
                on:click=move |_| dispatch_action(
                    transport,
                    state,
                    AppAction::Navigate(route),
                )
            >
                {label}
            </a>
        }
        .into_any(),
        _ => view! {
            <button
                class="secondary"
                type="button"
                disabled
                title="Desktop USB hardware wallets"
            >
                {label}
            </button>
        }
        .into_any(),
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
                <p class="eyebrow">"Pay, Your Way"</p>
                <h1>"OPTN Wallet"</h1>
                <p class="description">
                    "A self-custodial Bitcoin Cash wallet. Create, import, or open a watch-only account."
                </p>

                <nav class="actions" aria-label="Wallet onboarding">
                    <For
                        each=move || onboarding_actions(&state.get())
                        key=|action| match action {
                            OnboardingAction::CreateWallet => 0u8,
                            OnboardingAction::ImportWallet => 1,
                            OnboardingAction::CreateWatchOnlyWallet => 2,
                            OnboardingAction::ConnectHardwareWallet => 3,
                        }
                        let:action
                    >
                        <LandingActionLink transport=transport state=state action=action />
                    </For>
                </nav>
                <button
                    class="secondary open-wallet"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::Navigate(AppRoute::WalletHome),
                    )
                >
                    "Open wallet"
                </button>
            </section>
        </section>
    }
}

#[cfg(target_arch = "wasm32")]
#[component]
fn App(transport: Rc<dyn AppTransport>) -> impl IntoView {
    // Do not paint Desktop defaults. That flashes USB hardware on mobile and
    // hides Watch Only if a failed/web snapshot is treated as authoritative.
    let state = RwSignal::new(AppState::for_surface(AppSurface::Web));
    let ready = RwSignal::new(false);
    let transport = StoredValue::new_local(transport);

    {
        let transport = transport.get_value();
        leptos::task::spawn_local(async move {
            if let Ok(snapshot) = transport.snapshot().await {
                state.set(snapshot);
                ready.set(true);
            }
        });
    }

    view! {
        <main
            class=move || {
                if !ready.get() {
                    return "app-shell theme-green skin-default".to_string();
                }
                let current = state.get();
                format!(
                    "app-shell {} {}",
                    current.theme.css_class(),
                    current.skin.css_class()
                )
            }
        >
            <Show
                when=move || ready.get()
                fallback=move || view! { <p class="shell-loading">"Loading OPTN"</p> }
            >
            <Show when=move || !state.get().route.is_wallet_chrome()>
                <header class="topbar">
                    <div class="brand-lockup">
                        <span class="brand-mark" aria-hidden="true"></span>
                        <div class="brand" aria-label="OPTN Wallet">"OPTN"</div>
                    </div>
                    <button
                        class="chip"
                        type="button"
                        on:click=move |_| dispatch_action(transport, state, AppAction::ToggleTheme)
                        aria-label="Toggle theme"
                    >
                        {move || match state.get().theme {
                            ThemeMode::Light => "Gray",
                            ThemeMode::Gray => "Green",
                            ThemeMode::Green => "Dark",
                            ThemeMode::Dark => "Light",
                        }}
                    </button>
                </header>
            </Show>

            {move || match state.get().route {
                AppRoute::WatchOnlyWallet => view! {
                    <WatchOnlySetup transport=transport state=state />
                }.into_any(),
                AppRoute::WalletHome => view! {
                    <WalletHome transport=transport state=state />
                }.into_any(),
                AppRoute::Coins => view! {
                    <CoinsPage transport=transport state=state />
                }.into_any(),
                AppRoute::Actions => view! {
                    <ActionsPage transport=transport state=state />
                }.into_any(),
                AppRoute::Explore => view! {
                    <ExplorePage transport=transport state=state />
                }.into_any(),
                AppRoute::Settings => view! {
                    <SettingsPage transport=transport state=state />
                }.into_any(),
                AppRoute::Flipstarter => view! {
                    <FlipstarterPage transport=transport state=state />
                }.into_any(),
                AppRoute::FundMe => view! {
                    <FundMePage transport=transport state=state />
                }.into_any(),
                AppRoute::Landing
                | AppRoute::CreateWallet
                | AppRoute::ImportWallet => view! {
                    <Landing transport=transport state=state />
                }.into_any(),
            }}

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
