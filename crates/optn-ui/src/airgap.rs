#![cfg(target_arch = "wasm32")]

//! The Airgap section of Watch Only.
//!
//! Sits below the single-sig and multisig inputs, as in the React wallet:
//! pick a signer, press Enter, the camera opens, and the account arrives by
//! QR. The device never touches a cable and never sees a PSBT.
//!
//! SeedCash sends the bare xPub, so its account path is chosen here and the
//! fingerprint is optional. Keystone sends BC-UR carrying its own origin, so
//! nothing is typed — once the decoder exists. Until then a Keystone scan is
//! reported precisely rather than half-parsed into a plausible wrong key.

use crate::derivation::DerivationPicker;
use crate::scan::can_scan;
use crate::{dispatch_action, UiTransport};
use leptos::prelude::*;
use optn_app::{
    classify_scanned_account, watch_only_setup_preview, AccountPath, AirgapDevice, AppAction,
    AppState, ScannedAccount, WatchOnlySetupPreview, AIRGAP_SUBTITLE, AIRGAP_TITLE,
};

#[component]
pub fn AirgapSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let chosen = RwSignal::new(None::<AirgapDevice>);
    let wallet_name = RwSignal::new(String::new());
    let fingerprint = RwSignal::new(String::new());
    let account = RwSignal::new(AccountPath::default_for(state.get_untracked().network));
    let scanned_xpub = RwSignal::new(String::new());
    let status = RwSignal::new(None::<String>);
    let error = RwSignal::new(None::<String>);
    let preview = RwSignal::new(None::<WatchOnlySetupPreview>);
    let busy = RwSignal::new(false);

    let default_name = move || match chosen.get() {
        // The React flow names a Keystone wallet after the device when the
        // user has not typed one.
        Some(signer) => signer.label().to_owned(),
        None => "Airgap wallet".to_owned(),
    };

    let start_scan = move || {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        error.set(None);
        status.set(Some("Point the camera at the account QR…".into()));
        let scanner = transport.get_value();
        leptos::task::spawn_local(async move {
            match scanner.scan_qr().await {
                Ok(payload) => match classify_scanned_account(&payload) {
                    Ok(ScannedAccount::Xpub(xpub)) => {
                        scanned_xpub.set(xpub);
                        status.set(Some("Account key received.".into()));
                        error.set(None);
                    }
                    Ok(ScannedAccount::UniformResource { ur_type, sequence }) => {
                        // Honest, not silent: the frame was read, the decoder
                        // for it is not here yet.
                        scanned_xpub.set(String::new());
                        status.set(None);
                        error.set(Some(match sequence {
                            Some((index, total)) => format!(
                                "Read frame {index} of {total} of a {ur_type} code. \
                                 Decoding animated Keystone exports is not built yet, \
                                 so this cannot open a wallet."
                            ),
                            None => format!(
                                "That is a {ur_type} code. Decoding Keystone's BC-UR \
                                 export is not built yet, so this cannot open a wallet."
                            ),
                        }));
                    }
                    Err(message) => {
                        status.set(None);
                        error.set(Some(message.to_string()));
                    }
                },
                Err(optn_transport::TransportError::Unsupported) => {
                    status.set(None);
                    error.set(Some(
                        "This build cannot open a camera, so an air-gapped device \
                         cannot be scanned here."
                            .into(),
                    ));
                }
                Err(_) => {
                    status.set(None);
                    error.set(Some("Could not read a QR code.".into()));
                }
            }
            busy.set(false);
        });
    };

    let validate = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let name = {
            let typed = wallet_name.get_untracked();
            if typed.trim().is_empty() {
                default_name()
            } else {
                typed
            }
        };
        match watch_only_setup_preview(
            state.get_untracked().network,
            &name,
            &scanned_xpub.get_untracked(),
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
        <section class="airgap-section" data-testid="airgap-section">
            <div class="panel-head">
                <span class="field-label">{AIRGAP_TITLE}</span>
            </div>
            <p class="muted">{AIRGAP_SUBTITLE}</p>

            <div class="choice-list" role="radiogroup" aria-label="Air-gapped signer">
                {move || {
                    let selected = chosen.get();
                    AirgapDevice::OFFERED
                        .iter()
                        .map(|signer| {
                            let signer = *signer;
                            view! {
                                <button
                                    class="network-choice"
                                    class:active=move || chosen.get() == Some(signer)
                                    type="button"
                                    role="radio"
                                    aria-checked=if selected == Some(signer) { "true" } else { "false" }
                                    data-testid=format!("airgap-{}", signer.id())
                                    on:click=move |_| {
                                        chosen.set(Some(signer));
                                        preview.set(None);
                                        error.set(None);
                                        status.set(None);
                                    }
                                >
                                    <div>
                                        <p class="source-title">{signer.label()}</p>
                                        <p class="muted">{signer.description()}</p>
                                    </div>
                                    <Show when=move || chosen.get() == Some(signer)>
                                        <span class="ok">"Selected"</span>
                                    </Show>
                                </button>
                            }
                        })
                        .collect_view()
                }}
            </div>

            <Show when=move || chosen.get().is_some()>
                <form class="watch-only-form" on:submit=validate>
                    <Show
                        when=move || can_scan(state)
                        fallback=move || view! {
                            <p class="hint-card" data-testid="airgap-no-camera">
                                "An air-gapped device is scanned with the camera, and this "
                                "build cannot open one."
                            </p>
                        }
                    >
                        <button
                            class="primary"
                            type="button"
                            data-testid="airgap-scan"
                            disabled=move || busy.get()
                            on:click=move |_| start_scan()
                        >
                            {move || if busy.get() { "Scanning…" } else { "Enter — open camera" }}
                        </button>
                    </Show>

                    <Show when=move || status.get().is_some()>
                        <p class="muted" aria-live="polite">
                            {move || status.get().unwrap_or_default()}
                        </p>
                    </Show>

                    <Show when=move || { !scanned_xpub.get().is_empty() }>
                        <p class="mono" data-testid="airgap-xpub">
                            {move || scanned_xpub.get()}
                        </p>
                    </Show>

                    // SeedCash sends the key alone, so its origin is supplied
                    // here. Keystone's export carries both, so once decoding
                    // lands these stop being asked for.
                    <Show when=move || chosen.get().is_some_and(|s| !s.carries_origin())>
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
                                }
                            />
                            <small>
                                "Read it off the device screen. The wallet works without it; "
                                "it only labels PSBT key origins."
                            </small>
                        </label>
                    </Show>

                    <Show when=move || chosen.get().is_some_and(|s| !s.carries_origin())>
                        <DerivationPicker state=state selected=account error=error />
                    </Show>

                    <label class="field">
                        <span>"Wallet name"</span>
                        <input
                            type="text"
                            maxlength="80"
                            autocomplete="off"
                            prop:value=move || wallet_name.get()
                            placeholder=move || default_name()
                            on:input=move |event| {
                                wallet_name.set(event_target_value(&event));
                                preview.set(None);
                            }
                        />
                    </label>

                    <Show when=move || error.get().is_some()>
                        <p class="form-error" role="alert">
                            {move || error.get().unwrap_or_default()}
                        </p>
                    </Show>

                    <button
                        class="secondary"
                        type="submit"
                        data-testid="airgap-validate"
                        disabled=move || { scanned_xpub.get().is_empty() }
                    >
                        "Validate account"
                    </button>
                </form>
            </Show>

            <Show when=move || preview.get().is_some()>
                <section class="watch-preview" aria-live="polite">
                    <div class="preview-heading">
                        <div>
                            <p class="eyebrow">"Validated by optn-core"</p>
                            <h2>{move || preview.get().map(|p| p.wallet_name).unwrap_or_default()}</h2>
                        </div>
                        <span class="success-badge">
                            {move || chosen.get().map(|s| s.label()).unwrap_or_default()}
                        </span>
                    </div>
                    <dl class="preview-grid">
                        <div>
                            <dt>"Account path"</dt>
                            <dd>{move || preview.get().map(|p| p.account_path).unwrap_or_default()}</dd>
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
                    </dl>
                    <button
                        class="primary"
                        type="button"
                        data-testid="airgap-open"
                        on:click=move |_| {
                            if let Some(ready) = preview.get_untracked() {
                                dispatch_action(
                                    transport,
                                    state,
                                    AppAction::OpenWatchOnlyWallet(ready),
                                );
                            }
                        }
                    >
                        "Open airgap wallet"
                    </button>
                </section>
            </Show>
        </section>
    }
}
