#![cfg(target_arch = "wasm32")]
use crate::UiTransport;
use leptos::prelude::*;
use optn_app::{AppState, SecretText};
use optn_transport::{TransportError, WalletSecurityRequest as Request, WalletSecurityStatus};

pub fn submit(
    transport: UiTransport,
    state: RwSignal<AppState>,
    request: Request,
    status: RwSignal<Option<WalletSecurityStatus>>,
    error: RwSignal<Option<String>>,
    busy: RwSignal<bool>,
) {
    if busy.get_untracked() {
        return;
    }
    busy.set(true);
    error.set(None);
    let refresh = !matches!(request, Request::Status);
    let transport = transport.get_value();
    leptos::task::spawn_local(async move {
        match transport.wallet_security(request).await {
            Ok(next) => {
                error.set(next.warning.clone());
                status.set(Some(next));
            }
            Err(TransportError::Other(message) | TransportError::InvalidData(message)) => {
                error.set(Some(message))
            }
            Err(_) => error.set(Some(
                "Wallet security is unavailable on this interface.".into(),
            )),
        }
        if refresh {
            if let Ok(snapshot) = transport.snapshot().await {
                crate::apply_snapshot(state, snapshot);
            }
        }
        busy.set(false);
    });
}

#[component]
pub fn NewPasswordFields(
    password: RwSignal<String>,
    confirmation: RwSignal<String>,
) -> impl IntoView {
    view! {
        <label class="field"><span>"New password"</span>
            <input type="password" autocomplete="new-password" prop:value=move || password.get()
                on:input=move |event| password.set(event_target_value(&event)) />
        </label>
        <label class="field"><span>"Confirm new password"</span>
            <input type="password" autocomplete="new-password" prop:value=move || confirmation.get()
                on:input=move |event| confirmation.set(event_target_value(&event)) />
        </label>
    }
}

#[component]
pub fn SaveWatchOnly(
    transport: UiTransport,
    state: RwSignal<AppState>,
    preview: RwSignal<Option<optn_app::WatchOnlySetupPreview>>,
    error: RwSignal<Option<String>>,
    #[prop(default = "watch-only-save")] test_id: &'static str,
) -> impl IntoView {
    let password = RwSignal::new(String::new());
    let confirmation = RwSignal::new(String::new());
    let status = RwSignal::new(None);
    let busy = RwSignal::new(false);
    view! {
        <Show when=|| cfg!(feature = "tauri-transport")>
            <NewPasswordFields password=password confirmation=confirmation />
            <p class="muted">"A password protects the saved account and history on this device. Leave it empty for no password protection. This wallet cannot sign transactions."</p>
        </Show>
        <Show when=|| !cfg!(feature = "tauri-transport")>
            <p class="muted">"This preview is temporary and will be lost when this page closes."</p>
        </Show>
        <button class="primary" type="button" data-testid=test_id disabled=move || busy.get()
            on:click=move |_| {
                if busy.get_untracked() { return; }
                if let Some(preview) = preview.get_untracked() {
                    if cfg!(feature = "tauri-transport") {
                        let request = Request::ImportWatchOnly {
                            name: preview.wallet_name,
                            account_xpub: SecretText::new(preview.account_xpub),
                            master_fingerprint: preview.master_fingerprint.unwrap_or_default(),
                            account_path: preview.account_path,
                            network: state.get_untracked().network.to_string(),
                            password: SecretText::new(password.get_untracked()),
                            confirmation: SecretText::new(confirmation.get_untracked()),
                        };
                        password.set(String::new()); confirmation.set(String::new());
                        submit(transport, state, request, status, error, busy);
                    } else {
                        crate::dispatch_action(transport, state, optn_app::AppAction::OpenWatchOnlyWallet(preview));
                    }
                }
            }>
            {if cfg!(feature = "tauri-transport") { "Save and open watch-only wallet" } else { "Open temporary watch-only wallet" }}
        </button>
    }
}

#[component]
pub fn ConfirmPassword(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let prompt_epoch = state.get_untracked().lock.unlock_epoch;
    let password = RwSignal::new(String::new());
    let status = RwSignal::new(None);
    let error = RwSignal::new(None);
    let busy = RwSignal::new(false);
    submit(transport, state, Request::Status, status, error, busy);
    view! {
        <form on:submit=move |event| {
            event.prevent_default();
            let credential = SecretText::new(password.get_untracked());
            password.set(String::new());
            submit(transport, state, Request::Authenticate {
                password: credential, epoch: prompt_epoch,
            }, status, error, busy);
        }>
            <Show when=move || status.get().and_then(|status| status.has_password) != Some(false)>
            <label class="field"><span>"Wallet password"</span>
                <input type="password" autocomplete="current-password" prop:value=move || password.get()
                    on:input=move |event| password.set(event_target_value(&event)) />
            </label>
            </Show>
            <p role="alert">{move || error.get()}</p>
            <button class="primary" type="submit" disabled=move || busy.get()>
                {move || if busy.get() { "Verifying…" } else { "Confirm" }}
            </button>
        </form>
    }
}

#[component]
pub fn SecuritySettings(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let status = RwSignal::new(None::<WalletSecurityStatus>);
    let error = RwSignal::new(None);
    let busy = RwSignal::new(false);
    let current = RwSignal::new(String::new());
    let password = RwSignal::new(String::new());
    let confirmation = RwSignal::new(String::new());
    let biometric_password = RwSignal::new(String::new());
    let epoch = Memo::new(move |_| state.with(|state| state.lock.unlock_epoch));
    Effect::new(move |_| {
        let _ = epoch.get();
        submit(transport, state, Request::Status, status, error, busy);
    });
    view! {
        <Show when=move || status.get().is_some_and(|status| status.active.is_some())>
            <h3>{move || if status.get().and_then(|s| s.has_password) == Some(false) { "Set password" } else { "Change password" }}</h3>
            <form on:submit=move |event| {
                event.prevent_default();
                let old = if status.get_untracked().and_then(|s| s.has_password) == Some(false) { None }
                    else { Some(SecretText::new(current.get_untracked())) };
                let request = Request::ChangePassword { current: old,
                    password: SecretText::new(password.get_untracked()),
                    confirmation: SecretText::new(confirmation.get_untracked()),
                    epoch: status.get_untracked().map(|status| status.epoch).unwrap_or(u64::MAX),
                };
                current.set(String::new()); password.set(String::new()); confirmation.set(String::new());
                submit(transport, state, request, status, error, busy);
            }>
                <Show when=move || status.get().and_then(|s| s.has_password) == Some(true)>
                    <label class="field"><span>"Current password"</span>
                        <input type="password" autocomplete="current-password" prop:value=move || current.get()
                            on:input=move |event| current.set(event_target_value(&event)) />
                    </label>
                    <p class="muted">"Leave the new password empty to remove password protection."</p>
                </Show>
                <NewPasswordFields password=password confirmation=confirmation />
                <button class="primary" type="submit" disabled=move || busy.get()>"Save password"</button>
            </form>
            <Show when=move || status.get().is_some_and(|s| s.biometric_available)>
                <h3>"Biometric / PIN"</h3>
                <p class="muted">"Use your device’s authentication to unlock this wallet."</p>
                <p class="muted">"Enable it here after moving from the previous app. Your device manages its PIN."</p>
                <form on:submit=move |event| {
                    event.prevent_default();
                    let enabled = !status.get_untracked().is_some_and(|s| s.biometric_enabled);
                    let request = Request::SetBiometric { enabled,
                        password: enabled.then(|| SecretText::new(biometric_password.get_untracked())),
                        epoch: status.get_untracked().map(|status| status.epoch).unwrap_or(u64::MAX),
                    };
                    biometric_password.set(String::new());
                    submit(transport, state, request, status, error, busy);
                }>
                    <Show when=move || !status.get().is_some_and(|s| s.biometric_enabled)
                        && status.get().and_then(|s| s.has_password) == Some(true)>
                        <label class="field"><span>"Wallet password"</span>
                            <input type="password" autocomplete="current-password" prop:value=move || biometric_password.get()
                                on:input=move |event| biometric_password.set(event_target_value(&event)) />
                        </label>
                    </Show>
                    <button class="secondary" type="submit" disabled=move || busy.get()>
                        {move || if status.get().is_some_and(|s| s.biometric_enabled) { "Disable biometric / PIN" } else { "Enable biometric / PIN" }}
                    </button>
                </form>
            </Show>
        </Show>
        <p role="alert">{move || error.get()}</p>
    }
}

#[component]
pub fn SavedWallets(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let status = RwSignal::new(None::<WalletSecurityStatus>);
    let error = RwSignal::new(None);
    let busy = RwSignal::new(false);
    let selected = RwSignal::new(String::new());
    let password = RwSignal::new(String::new());
    submit(transport, state, Request::Status, status, error, busy);
    view! {
        <Show when=move || status.get().is_some_and(|s| !s.wallets.is_empty())>
            <h2>"Your wallets"</h2>
            <Show when=move || status.get().is_some_and(|s| s.needs_auto_lock_confirmation)>
                <label class="field"><span>"Confirm your previous auto-lock setting"</span>
                    <select on:change=move |event| {
                        if let Ok(minutes) = event_target_value(&event).parse::<u32>() {
                            crate::dispatch_action(transport, state, optn_app::AppAction::SetAutoLockMinutes(minutes));
                        }
                    }>
                        <option value="" disabled selected>"Choose a duration"</option>
                        {optn_app::AutoLockMinutes::offered().into_iter().map(|value| view! {
                            <option value=value.as_minutes().to_string()>{value.label()}</option>
                        }).collect_view()}
                    </select>
                </label>
            </Show>
            <For each=move || status.get().map(|s| s.wallets).unwrap_or_default()
                key=|wallet| wallet.handle.clone() let:wallet>
                <button class="secondary" type="button" on:click=move |_| { selected.set(wallet.handle.clone()); password.set(String::new()); }>
                    {wallet.name}
                </button>
            </For>
            <Show when=move || !selected.get().is_empty()>
                <form on:submit=move |event| {
                    event.prevent_default();
                    let request = Request::Open { handle: selected.get_untracked(), password: SecretText::new(password.get_untracked()) };
                    password.set(String::new());
                    submit(transport, state, request, status, error, busy);
                }>
                    <label class="field"><span>"Wallet password"</span>
                        <input type="password" autocomplete="current-password" prop:value=move || password.get()
                            on:input=move |event| password.set(event_target_value(&event)) />
                    </label>
                    <button class="primary" type="submit" disabled=move || busy.get()>"Open wallet"</button>
                </form>
                <Show when=move || status.get().is_some_and(|s| s.biometric_available)>
                    <button class="secondary" type="button" disabled=move || busy.get()
                        on:click=move |_| submit(transport, state, Request::UnlockBiometric { handle: selected.get_untracked() }, status, error, busy)>
                        "Unlock with biometric / PIN"
                    </button>
                </Show>
            </Show>
            <p role="alert">{move || error.get()}</p>
        </Show>
    }
}
