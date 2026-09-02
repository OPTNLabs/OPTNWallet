#![cfg(target_arch = "wasm32")]

//! Hardware wallet onboarding.
//!
//! A device hands over public material only: an account xPub plus an optional
//! master fingerprint. The private key never leaves it, so this screen looks
//! like the watch-only import — the difference is the wallet it opens, which
//! can spend, because signing goes back to the device.
//!
//! The vendor list comes from `optn-app`, which sources it from
//! `optn-platform`. When the surface has no USB the list is empty and this
//! screen says so instead of painting a device picker that cannot work.

use crate::derivation::DerivationPicker;
use crate::{dispatch_action, UiTransport};
use leptos::prelude::*;
use optn_app::{
    hardware_setup_preview, hardware_view_model, AccountPath, AppAction, AppRoute, AppState,
    HardwareSetupPreview, HardwareVendor,
};

fn vendor_hint(vendor: HardwareVendor) -> &'static str {
    match vendor {
        HardwareVendor::Ledger => "Open the Bitcoin Cash app on the device",
        HardwareVendor::Trezor => "Confirm the export on the device screen",
        HardwareVendor::OneKey => "Confirm the export on the device screen",
        HardwareVendor::Keystone => "Air-gapped: show the account QR on the device",
        HardwareVendor::Mock => "Test signer, not for real funds",
    }
}

#[component]
pub fn HardwareWalletSetup(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let name = RwSignal::new(String::from("Hardware wallet"));
    let account_xpub = RwSignal::new(String::new());
    let fingerprint = RwSignal::new(String::new());
    let error = RwSignal::new(None::<String>);
    let preview = RwSignal::new(None::<HardwareSetupPreview>);
    let account = RwSignal::new(AccountPath::default_for(state.get_untracked().network));
    let chosen = RwSignal::new(None::<HardwareVendor>);

    let model = move || hardware_view_model(&state.get());

    let validate = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let Some(vendor) = chosen.get_untracked() else {
            error.set(Some("Choose a device first.".into()));
            return;
        };
        match hardware_setup_preview(
            state.get_untracked().network,
            vendor,
            &name.get_untracked(),
            &account_xpub.get_untracked(),
            &fingerprint.get_untracked(),
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

                <p class="eyebrow">"Keys stay on the device"</p>
                <h1>"Connect hardware wallet"</h1>

                <Show
                    when=move || model().available
                    fallback=move || view! {
                        <p class="hint-card" data-testid="hardware-unavailable">
                            "Hardware wallets need a USB connection, so they are available on "
                            "desktop only. This surface cannot reach a device."
                        </p>
                    }
                >
                    <p class="description">
                        "Export the account public key from your device and paste it here. "
                        "The wallet watches those addresses and sends every spend back to the "
                        "device to be signed. No private key is imported."
                    </p>

                    <div class="choice-list" role="radiogroup" aria-label="Device">
                        <For
                            each=move || model().vendors
                            key=|vendor| vendor.id()
                            let:vendor
                        >
                            <button
                                class="network-choice"
                                class:active=move || chosen.get() == Some(vendor)
                                type="button"
                                role="radio"
                                aria-checked=move || {
                                    if chosen.get() == Some(vendor) { "true" } else { "false" }
                                }
                                data-testid=format!("hardware-{}", vendor.id())
                                on:click=move |_| {
                                    error.set(None);
                                    preview.set(None);
                                    chosen.set(Some(vendor));
                                }
                            >
                                <div>
                                    <p class="source-title">{vendor.label()}</p>
                                    <p class="muted">{vendor_hint(vendor)}</p>
                                </div>
                                <Show when=move || chosen.get() == Some(vendor)>
                                    <span class="ok">"Selected"</span>
                                </Show>
                            </button>
                        </For>
                    </div>

                    <form class="watch-only-form" on:submit=validate>
                        <label class="field">
                            <span>"Wallet name"</span>
                            <input
                                type="text"
                                maxlength="80"
                                autocomplete="off"
                                prop:value=move || name.get()
                                on:input=move |event| {
                                    name.set(event_target_value(&event));
                                    preview.set(None);
                                }
                            />
                        </label>

                        <DerivationPicker state=state selected=account error=error />

                        <label class="field">
                            <span>"Account xPub from the device"</span>
                            <textarea
                                rows="4"
                                spellcheck="false"
                                autocomplete="off"
                                placeholder="xpub… exported at the account level shown above"
                                prop:value=move || account_xpub.get()
                                on:input=move |event| {
                                    account_xpub.set(event_target_value(&event));
                                    preview.set(None);
                                    error.set(None);
                                }
                            ></textarea>
                            <small>
                                {move || format!(
                                    "Export this account: {}",
                                    account.get()
                                )}
                            </small>
                        </label>

                        <label class="field">
                            <span>"Master fingerprint (optional)"</span>
                            <input
                                type="text"
                                maxlength="8"
                                autocomplete="off"
                                autocapitalize="none"
                                placeholder="4c9a1f7b"
                                prop:value=move || fingerprint.get()
                                on:input=move |event| {
                                    fingerprint.set(event_target_value(&event));
                                    preview.set(None);
                                    error.set(None);
                                }
                            />
                            <small>
                                "Lets a PSBT say which device owns an input. Eight hex characters."
                            </small>
                        </label>

                        <Show when=move || error.get().is_some()>
                            <p class="form-error" role="alert">
                                {move || error.get().unwrap_or_default()}
                            </p>
                        </Show>

                        <button class="primary form-submit" type="submit">
                            "Validate device account"
                        </button>
                    </form>

                    <Show when=move || preview.get().is_some()>
                        <section class="watch-preview" aria-live="polite">
                            <div class="preview-heading">
                                <div>
                                    <p class="eyebrow">"Validated by optn-core"</p>
                                    <h2>{move || {
                                        preview.get().map(|p| p.wallet_name).unwrap_or_default()
                                    }}</h2>
                                </div>
                                <span class="success-badge">
                                    {move || {
                                        preview
                                            .get()
                                            .map(|p| p.vendor.label())
                                            .unwrap_or_default()
                                    }}
                                </span>
                            </div>

                            <dl class="preview-grid">
                                <div>
                                    <dt>"Account path"</dt>
                                    <dd>{move || {
                                        preview.get().map(|p| p.account_path).unwrap_or_default()
                                    }}</dd>
                                </div>
                                <div>
                                    <dt>"Master fingerprint"</dt>
                                    <dd>{move || {
                                        preview
                                            .get()
                                            .and_then(|p| p.master_fingerprint)
                                            .unwrap_or_else(|| "Not set".to_string())
                                    }}</dd>
                                </div>
                                <div class="preview-wide">
                                    <dt>"First receive address"</dt>
                                    <dd>{move || {
                                        preview.get().map(|p| p.receive_address).unwrap_or_default()
                                    }}</dd>
                                </div>
                                <div class="preview-wide">
                                    <dt>"First change address"</dt>
                                    <dd>{move || {
                                        preview.get().map(|p| p.change_address).unwrap_or_default()
                                    }}</dd>
                                </div>
                            </dl>

                            <button
                                class="primary"
                                type="button"
                                data-testid="hardware-open"
                                on:click=move |_| {
                                    if let Some(ready) = preview.get_untracked() {
                                        dispatch_action(
                                            transport,
                                            state,
                                            AppAction::OpenHardwareWallet(ready),
                                        );
                                    }
                                }
                            >
                                "Open hardware wallet"
                            </button>
                        </section>
                    </Show>
                </Show>
            </section>
        </section>
    }
}
