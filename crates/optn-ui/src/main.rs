#![forbid(unsafe_code)]

mod onboarding;

#[cfg(target_arch = "wasm32")]
use leptos::prelude::*;
#[cfg(target_arch = "wasm32")]
use leptos::reactive::owner::LocalStorage;
#[cfg(target_arch = "wasm32")]
mod airgap;
#[cfg(target_arch = "wasm32")]
mod derivation;
#[cfg(target_arch = "wasm32")]
mod hardware;
#[cfg(target_arch = "wasm32")]
mod multisig;
#[cfg(target_arch = "wasm32")]
mod scan;
#[cfg(target_arch = "wasm32")]
mod settings;
#[cfg(target_arch = "wasm32")]
mod tools;

#[cfg(target_arch = "wasm32")]
use airgap::AirgapSection;
#[cfg(target_arch = "wasm32")]
use derivation::DerivationPicker;
#[cfg(target_arch = "wasm32")]
use hardware::HardwareSection;
#[cfg(target_arch = "wasm32")]
use multisig::MultisigSection;
#[cfg(target_arch = "wasm32")]
use optn_app::{
    create_confirm_indices, entropy_len_for_word_count, mnemonic_from_entropy, onboarding_actions,
    onboarding_view_model, seed_wallet_preview_at, watch_only_setup_preview, AppAction, AppRoute,
    AppState, AppSurface, AuthScope, CreateStep, ImportStep, Network, OnboardingAction, ThemeMode,
    WatchOnlyKind, WatchOnlySetupPreview, BIP39_DEFAULT_WORD_COUNT, BIP39_WORD_COUNTS,
};
#[cfg(target_arch = "wasm32")]
use optn_transport::AppTransport;
#[cfg(all(target_arch = "wasm32", not(feature = "tauri-transport")))]
use optn_transport::LocalTransport;
#[cfg(target_arch = "wasm32")]
use scan::ScanButton;
#[cfg(target_arch = "wasm32")]
use settings::SettingsPage;
#[cfg(target_arch = "wasm32")]
use std::rc::Rc;
#[cfg(target_arch = "wasm32")]
use tools::{
    ActionsPage, CoinsPage, ExplorePage, FlipstarterPage, FundMePage, HistoryPage, ReceivePage,
    SendPage, WalletHome,
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
        // Appearance may be applied even when its durable save fails. Refresh
        // authoritative state after either result; keep current state if unavailable.
        let _ = transport.dispatch(action).await;
        if let Ok(snapshot) = transport.snapshot().await {
            state.set(snapshot);
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
                        AppAction::GoBack,
                    )
                >
                    {move || format!("← {}", state.get().flow().back_label)}
                </button>

                <p class="eyebrow">"Public keys only"</p>
                <h1>{move || state.get().flow().title}</h1>
                <p class="description">
                    "Import an account xPub without importing a seed or private key. "
                    "A shared wallet is the same public-only import with an m-of-n policy."
                </p>

                <div class="network-picker" role="group" aria-label="Watch-only kind">
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().watch_only_kind == WatchOnlyKind::Single
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::SetWatchOnlyKind(WatchOnlyKind::Single),
                        )
                    >
                        "Account xPub"
                    </button>
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().watch_only_kind == WatchOnlyKind::Shared
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::SetWatchOnlyKind(WatchOnlyKind::Shared),
                        )
                    >
                        "Shared wallet"
                    </button>
                </div>

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

                <Show when=move || state.get().watch_only_kind == WatchOnlyKind::Single>
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
                        <ScanButton
                            transport=transport
                            state=state
                            label="xpub"
                            error=error
                            on_payload=Callback::new(move |scanned: String| {
                                account_xpub.set(scanned);
                                preview.set(None);
                            })
                        />
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
                </Show>

                <Show when=move || state.get().watch_only_kind == WatchOnlyKind::Shared>
                    <MultisigSection transport=transport state=state />
                </Show>

                <HardwareSection transport=transport state=state />

                <AirgapSection transport=transport state=state />

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

                        <button
                            class="primary"
                            type="button"
                            on:click=move |_| {
                                if let Some(preview) = preview.get_untracked() {
                                    dispatch_action(
                                        transport,
                                        state,
                                        AppAction::OpenWatchOnlyWallet(preview),
                                    );
                                }
                            }
                        >
                            "Open watch-only wallet"
                        </button>
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
                data-testid=if matches!(action, OnboardingAction::CreateWatchOnlyWallet) {
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
            </section>
        </section>
    }
}

#[cfg(target_arch = "wasm32")]
fn fill_entropy(len: usize) -> Result<Vec<u8>, String> {
    let crypto = web_sys::window()
        .ok_or_else(|| "browser window is unavailable".to_string())?
        .crypto()
        .map_err(|_| "Web Crypto is unavailable".to_string())?;
    let mut entropy = vec![0u8; len];
    crypto
        .get_random_values_with_u8_array(entropy.as_mut_slice())
        .map_err(|_| "could not gather entropy".to_string())?;
    Ok(entropy)
}

#[cfg(target_arch = "wasm32")]
#[component]
fn CreateWallet(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let name = RwSignal::new(String::from("My wallet"));
    let phrase = RwSignal::new(String::new());
    let error = RwSignal::new(None::<String>);
    let word_count = RwSignal::new(BIP39_DEFAULT_WORD_COUNT);
    let answers = RwSignal::new([String::new(), String::new(), String::new()]);
    let account = RwSignal::new(onboarding::derivation_for_network(
        state.get_untracked().network,
    ));

    Effect::new(move |_| {
        let words = word_count.get();
        match entropy_len_for_word_count(words)
            .map_err(|error| error.to_string())
            .and_then(fill_entropy)
            .and_then(|entropy| mnemonic_from_entropy(&entropy).map_err(|error| error.to_string()))
        {
            Ok(next) => {
                error.set(None);
                phrase.set(next);
            }
            Err(message) => error.set(Some(message)),
        }
    });

    view! {
        <section class="watch-only-page">
            <section class="watch-only-card">
                <button
                    class="text-button"
                    type="button"
                    on:click=move |_| dispatch_action(transport, state, AppAction::GoBack)
                >
                    {move || format!("← {}", state.get().flow().back_label)}
                </button>
                <p class="eyebrow">"New seed wallet"</p>
                <h1>{move || state.get().flow().title}</h1>
                <Show when=move || state.get().create_step == CreateStep::Reveal>
                    <div class="network-picker" role="group" aria-label="Wallet network">
                        <button
                            type="button"
                            class="network-option"
                            class:active=move || state.get().network == Network::Chipnet
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::SetNetwork(Network::Chipnet),
                            )
                        >
                            "Chipnet"
                        </button>
                        <button
                            type="button"
                            class="network-option"
                            class:active=move || state.get().network == Network::Mainnet
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::SetNetwork(Network::Mainnet),
                            )
                        >
                            "Mainnet"
                        </button>
                    </div>
                    <div class="network-picker" role="group" aria-label="Recovery phrase length">
                        <For
                            each=|| BIP39_WORD_COUNTS
                            key=|words| *words
                            let:words
                        >
                            <button
                                class="network-option"
                                class:active=move || word_count.get() == words
                                type="button"
                                on:click=move |_| word_count.set(words)
                            >
                                {format!("{words} words")}
                            </button>
                        </For>
                    </div>
                    <p class="lede">"Write this phrase down. It is not stored in application state."</p>
                    <p class="mono">{move || phrase.get()}</p>
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::AdvanceOnboarding,
                        )
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || state.get().create_step == CreateStep::Confirm>
                    <p class="lede">"Type the requested words to prove you wrote the phrase down."</p>
                    <p class="muted">
                        {move || {
                            let count = phrase.get().split_whitespace().count();
                            let idx = create_confirm_indices(count);
                            format!("Words {}, {}, and {}", idx[0] + 1, idx[1] + 1, idx[2] + 1)
                        }}
                    </p>
                    <label class="field">
                        <span>"First requested word"</span>
                        <input type="text" spellcheck="false" autocomplete="off"
                            on:input=move |event| {
                                let mut next = answers.get_untracked();
                                next[0] = event_target_value(&event);
                                answers.set(next);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"Second requested word"</span>
                        <input type="text" spellcheck="false" autocomplete="off"
                            on:input=move |event| {
                                let mut next = answers.get_untracked();
                                next[1] = event_target_value(&event);
                                answers.set(next);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"Third requested word"</span>
                        <input type="text" spellcheck="false" autocomplete="off"
                            on:input=move |event| {
                                let mut next = answers.get_untracked();
                                next[2] = event_target_value(&event);
                                answers.set(next);
                            }
                        />
                    </label>
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| {
                            let phrase_text = phrase.get_untracked();
                            let words: Vec<_> = phrase_text.split_whitespace().collect();
                            let idx = create_confirm_indices(words.len());
                            let given = answers.get_untracked();
                            let ok = (0..3).all(|slot| {
                                words
                                    .get(idx[slot])
                                    .is_some_and(|expected| {
                                        given[slot].trim().eq_ignore_ascii_case(expected)
                                    })
                            });
                            if ok {
                                error.set(None);
                                dispatch_action(transport, state, AppAction::AdvanceOnboarding);
                            } else {
                                error.set(Some("those words do not match.".into()));
                            }
                        }
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || state.get().create_step == CreateStep::Path>
                    <DerivationPicker
                        state=state
                        selected=account
                        error=error
                    />
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::AdvanceOnboarding,
                        )
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || state.get().create_step == CreateStep::Name>
                    <label class="field">
                        <span>"Wallet name"</span>
                        <input
                            type="text"
                            maxlength="80"
                            prop:value=move || name.get()
                            on:input=move |event| name.set(event_target_value(&event))
                        />
                    </label>
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| {
                            match seed_wallet_preview_at(
                                state.get_untracked().network,
                                &name.get_untracked(),
                                &phrase.get_untracked(),
                                account.get_untracked(),
                            ) {
                                Ok(opened) => dispatch_action(
                                    transport,
                                    state,
                                    AppAction::OpenCreatedWallet {
                                        name: opened.name,
                                        receive_address: opened.receive_address,
                                        account_path: opened.account_path,
                                    },
                                ),
                                Err(message) => error.set(Some(message)),
                            }
                        }
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || error.get().is_some()>
                    <p class="form-error" role="alert">
                        {move || error.get().unwrap_or_default()}
                    </p>
                </Show>
            </section>
        </section>
    }
}

#[cfg(target_arch = "wasm32")]
#[component]
fn ImportWallet(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let name = RwSignal::new(String::from("Imported wallet"));
    let phrase = RwSignal::new(String::new());
    let error = RwSignal::new(None::<String>);
    let account = RwSignal::new(onboarding::derivation_for_network(
        state.get_untracked().network,
    ));

    view! {
        <section class="watch-only-page">
            <section class="watch-only-card">
                <button
                    class="text-button"
                    type="button"
                    on:click=move |_| dispatch_action(transport, state, AppAction::GoBack)
                >
                    {move || format!("← {}", state.get().flow().back_label)}
                </button>
                <p class="eyebrow">"Existing seed"</p>
                <h1>{move || state.get().flow().title}</h1>
                <Show when=move || state.get().import_step == ImportStep::Words>
                <div class="network-picker" role="group" aria-label="Wallet network">
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().network == Network::Chipnet
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::SetNetwork(Network::Chipnet),
                        )
                    >
                        "Chipnet"
                    </button>
                    <button
                        type="button"
                        class="network-option"
                        class:active=move || state.get().network == Network::Mainnet
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::SetNetwork(Network::Mainnet),
                        )
                    >
                        "Mainnet"
                    </button>
                </div>
                <label class="field">
                    <span>"Recovery phrase"</span>
                    <textarea
                        rows="4"
                        spellcheck="false"
                        autocomplete="off"
                        autocapitalize="none"
                        placeholder="12, 15, 18, 21, or 24 words"
                        prop:value=move || phrase.get()
                        on:input=move |event| phrase.set(event_target_value(&event))
                    ></textarea>
                    <small>"Same lengths as optn new --words: 12, 15, 18, 21, or 24."</small>
                </label>
                <button
                    class="primary"
                    type="button"
                    on:click=move |_| {
                        match seed_wallet_preview_at(
                            state.get_untracked().network,
                            &name.get_untracked(),
                            &phrase.get_untracked(),
                            account.get_untracked(),
                        ) {
                            Ok(_) => {
                                error.set(None);
                                dispatch_action(transport, state, AppAction::AdvanceOnboarding);
                            }
                            Err(message) => error.set(Some(message)),
                        }
                    }
                >
                    {move || state.get().flow().next_label}
                </button>
                </Show>
                <Show when=move || state.get().import_step == ImportStep::Path>
                    <DerivationPicker
                        state=state
                        selected=account
                        error=error
                    />
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::AdvanceOnboarding,
                        )
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || state.get().import_step == ImportStep::Name>
                    <label class="field">
                        <span>"Wallet name"</span>
                        <input
                            type="text"
                            maxlength="80"
                            prop:value=move || name.get()
                            on:input=move |event| name.set(event_target_value(&event))
                        />
                    </label>
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| {
                            match seed_wallet_preview_at(
                                state.get_untracked().network,
                                &name.get_untracked(),
                                &phrase.get_untracked(),
                                account.get_untracked(),
                            ) {
                                Ok(opened) => dispatch_action(
                                    transport,
                                    state,
                                    AppAction::OpenImportedWallet {
                                        name: opened.name,
                                        receive_address: opened.receive_address,
                                        account_path: opened.account_path,
                                    },
                                ),
                                Err(message) => error.set(Some(message)),
                            }
                        }
                    >
                        {move || state.get().flow().next_label}
                    </button>
                </Show>
                <Show when=move || error.get().is_some()>
                    <p class="form-error" role="alert">
                        {move || error.get().unwrap_or_default()}
                    </p>
                </Show>
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

    // Track route only. A Chipnet/theme snapshot must not remount Create/Import
    // and wipe the mnemonic or xPub sitting in local signals.
    let page = Memo::new(move |_| onboarding::mounted_page(&state.get()));

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

            {move || match page.get() {
                AppRoute::WatchOnlyWallet => view! {
                    <WatchOnlySetup transport=transport state=state />
                }.into_any(),
                AppRoute::HardwareWallet => view! {
                    <section class="watch-only-page">
                        <section class="watch-only-card">
                            <button
                                class="text-button"
                                type="button"
                                on:click=move |_| dispatch_action(
                                    transport,
                                    state,
                                    AppAction::GoBack,
                                )
                            >
                                {move || format!("← {}", state.get().flow().back_label)}
                            </button>
                            <HardwareSection transport=transport state=state />
                        </section>
                    </section>
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
                AppRoute::History => view! {
                    <HistoryPage transport=transport state=state />
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
                AppRoute::Receive => view! {
                    <ReceivePage transport=transport state=state />
                }.into_any(),
                AppRoute::Send => view! {
                    <SendPage transport=transport state=state />
                }.into_any(),
                AppRoute::CreateWallet => view! {
                    <CreateWallet transport=transport state=state />
                }.into_any(),
                AppRoute::ImportWallet => view! {
                    <ImportWallet transport=transport state=state />
                }.into_any(),
                AppRoute::Landing => view! {
                    <Landing transport=transport state=state />
                }.into_any(),
            }}

            <Show when=move || state.get().lock.prompt.is_some()>
                <div
                    class="modal-backdrop"
                    role="presentation"
                    on:click=move |_| dispatch_action(transport, state, AppAction::CancelAuth)
                >
                    <section
                        class="modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="auth-title"
                        on:click=move |event| event.stop_propagation()
                    >
                        <h2 id="auth-title">
                            {move || state.get().lock.prompt.map(AuthScope::title).unwrap_or("Confirm")}
                        </h2>
                        <p>
                            {move || state.get().lock.prompt.map(AuthScope::description).unwrap_or_default()}
                        </p>
                        <label class="field">
                            <span>"Password"</span>
                            <input type="password" autocomplete="current-password" />
                        </label>
                        <button
                            class="primary"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::ConfirmAuth { now_ms: js_sys::Date::now() as u64 },
                            )
                        >
                            "Confirm"
                        </button>
                        <button
                            class="secondary"
                            type="button"
                            on:click=move |_| dispatch_action(transport, state, AppAction::CancelAuth)
                        >
                            "Cancel"
                        </button>
                    </section>
                </div>
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
