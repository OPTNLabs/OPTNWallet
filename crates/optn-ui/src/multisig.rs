#![cfg(target_arch = "wasm32")]

//! Multisig cosigners, as a section of Watch Only.
//!
//! This mirrors the React wallet, where multisig is not a screen of its own:
//! the desktop watch-only card holds either a single-sig xPub or a cosigner
//! list with an m-of-n threshold.
//!
//! Nothing here decides addresses. The cosigner set goes to
//! `optn_app::multisig_setup_preview`, which sorts the keys BIP-67 and derives
//! the shared P2SH address, so every cosigner lands on the same wallet no
//! matter what order they typed each other in.

use crate::{dispatch_action, UiTransport};
use leptos::prelude::*;
use optn_app::{
    multisig_setup_preview, AppAction, AppState, Cosigner, MultisigSetupPreview, MAX_COSIGNERS,
};

/// What the user is editing, before validation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CosignerDraft {
    pub name: String,
    pub xpub: String,
    pub fingerprint: String,
}

impl CosignerDraft {
    fn to_cosigner(&self) -> Cosigner {
        Cosigner {
            name: self.name.clone(),
            account_xpub: self.xpub.clone(),
            master_fingerprint: if self.fingerprint.trim().is_empty() {
                None
            } else {
                Some(self.fingerprint.clone())
            },
        }
    }
}

/// Two is the smallest set that is actually multisig.
fn initial_drafts() -> Vec<CosignerDraft> {
    vec![CosignerDraft::default(), CosignerDraft::default()]
}

#[component]
pub fn MultisigSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let wallet_name = RwSignal::new(String::from("Shared wallet"));
    let drafts = RwSignal::new(initial_drafts());
    let required = RwSignal::new(2u8);
    let error = RwSignal::new(None::<String>);
    let preview = RwSignal::new(None::<MultisigSetupPreview>);

    let clear = move || {
        preview.set(None);
        error.set(None);
    };

    // The threshold can never exceed the number of cosigners; removing a
    // cosigner has to pull it down rather than leave an unsatisfiable policy.
    let total = move || drafts.get().len() as u8;
    Effect::new(move |_| {
        let n = total();
        if required.get_untracked() > n {
            required.set(n);
        }
    });

    let validate = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let cosigners: Vec<Cosigner> = drafts
            .get_untracked()
            .iter()
            .map(CosignerDraft::to_cosigner)
            .collect();
        match multisig_setup_preview(
            state.get_untracked().network,
            &wallet_name.get_untracked(),
            required.get_untracked(),
            &cosigners,
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
        <section class="multisig-section" data-testid="multisig-section">
            <div class="panel-head">
                <span class="field-label">"Multisig cosigners"</span>
                <span class="muted">
                    {move || format!("{} of {}", required.get(), total())}
                </span>
            </div>
            <p class="muted">
                "Every cosigner enters the same set of account xPubs. The order does not "
                "matter — the keys are sorted before the address is built, so everyone "
                "arrives at the same wallet."
            </p>

            <form class="watch-only-form" on:submit=validate>
                <label class="field">
                    <span>"Wallet name"</span>
                    <input
                        type="text"
                        maxlength="80"
                        autocomplete="off"
                        prop:value=move || wallet_name.get()
                        on:input=move |event| {
                            wallet_name.set(event_target_value(&event));
                            clear();
                        }
                    />
                </label>

                <label class="field">
                    <span>"Signatures required"</span>
                    <select
                        class="threshold-select"
                        data-testid="multisig-threshold"
                        on:change=move |event| {
                            if let Ok(value) = event_target_value(&event).parse::<u8>() {
                                required.set(value);
                                clear();
                            }
                        }
                    >
                        {move || {
                            let n = total();
                            let chosen = required.get();
                            (1..=n)
                                .map(|value| {
                                    view! {
                                        <option
                                            value=value.to_string()
                                            selected=value == chosen
                                        >
                                            {format!("{value} of {n}")}
                                        </option>
                                    }
                                })
                                .collect_view()
                        }}
                    </select>
                </label>

                {move || (0..drafts.get().len()).map(|index| view! {
                    <fieldset class="cosigner" data-testid=format!("cosigner-{index}")>
                        <legend>
                            {move || {
                                let draft = drafts.get();
                                let name = draft
                                    .get(index)
                                    .map(|d| d.name.trim().to_owned())
                                    .unwrap_or_default();
                                if name.is_empty() {
                                    format!("Cosigner {}", index + 1)
                                } else {
                                    name
                                }
                            }}
                        </legend>

                        <label class="field">
                            <span>"Name (optional)"</span>
                            <input
                                type="text"
                                maxlength="40"
                                autocomplete="off"
                                prop:value=move || {
                                    drafts.get().get(index).map(|d| d.name.clone()).unwrap_or_default()
                                }
                                on:input=move |event| {
                                    let value = event_target_value(&event);
                                    drafts.update(|list| {
                                        if let Some(draft) = list.get_mut(index) {
                                            draft.name = value;
                                        }
                                    });
                                    clear();
                                }
                            />
                        </label>

                        <label class="field">
                            <span>"Account xPub"</span>
                            <textarea
                                rows="3"
                                spellcheck="false"
                                autocomplete="off"
                                placeholder="xpub… at the BIP44 account level"
                                prop:value=move || {
                                    drafts.get().get(index).map(|d| d.xpub.clone()).unwrap_or_default()
                                }
                                on:input=move |event| {
                                    let value = event_target_value(&event);
                                    drafts.update(|list| {
                                        if let Some(draft) = list.get_mut(index) {
                                            draft.xpub = value;
                                        }
                                    });
                                    clear();
                                }
                            ></textarea>
                        </label>

                        <label class="field">
                            <span>"Master fingerprint (optional)"</span>
                            <input
                                type="text"
                                maxlength="8"
                                autocomplete="off"
                                autocapitalize="none"
                                placeholder="4c9a1f7b"
                                prop:value=move || {
                                    drafts
                                        .get()
                                        .get(index)
                                        .map(|d| d.fingerprint.clone())
                                        .unwrap_or_default()
                                }
                                on:input=move |event| {
                                    let value = event_target_value(&event);
                                    drafts.update(|list| {
                                        if let Some(draft) = list.get_mut(index) {
                                            draft.fingerprint = value;
                                        }
                                    });
                                    clear();
                                }
                            />
                        </label>

                        <Show when=move || { drafts.get().len() > 2 }>
                            <button
                                class="text-button"
                                type="button"
                                on:click=move |_| {
                                    drafts.update(|list| {
                                        if list.len() > 2 {
                                            list.remove(index);
                                        }
                                    });
                                    clear();
                                }
                            >
                                "Remove this cosigner"
                            </button>
                        </Show>
                    </fieldset>
                }).collect_view()}

                <div class="toolbar">
                    <button
                        class="secondary"
                        type="button"
                        data-testid="multisig-add-cosigner"
                        disabled=move || { drafts.get().len() >= MAX_COSIGNERS }
                        on:click=move |_| {
                            drafts.update(|list| {
                                if list.len() < MAX_COSIGNERS {
                                    list.push(CosignerDraft::default());
                                }
                            });
                            clear();
                        }
                    >
                        "Add cosigner"
                    </button>
                    <button class="primary" type="submit" data-testid="multisig-validate">
                        "Validate cosigners"
                    </button>
                </div>

                <Show when=move || error.get().is_some()>
                    <p class="form-error" role="alert">
                        {move || error.get().unwrap_or_default()}
                    </p>
                </Show>
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
                            {move || preview.get().map(|p| p.policy).unwrap_or_default()}
                        </span>
                    </div>

                    <dl class="preview-grid">
                        <div class="preview-wide">
                            <dt>"Shared receive address"</dt>
                            <dd>{move || {
                                preview.get().map(|p| p.receive_address).unwrap_or_default()
                            }}</dd>
                        </div>
                        <div class="preview-wide">
                            <dt>"Shared change address"</dt>
                            <dd>{move || {
                                preview.get().map(|p| p.change_address).unwrap_or_default()
                            }}</dd>
                        </div>
                        <div class="preview-wide">
                            <dt>"Cosigners"</dt>
                            <dd>{move || {
                                preview
                                    .get()
                                    .map(|p| p.cosigner_names.join(", "))
                                    .unwrap_or_default()
                            }}</dd>
                        </div>
                    </dl>

                    <p class="hint-card">
                        "Every cosigner must see this same address. If one of you sees a "
                        "different one, someone has a different key set."
                    </p>

                    <button
                        class="primary"
                        type="button"
                        data-testid="multisig-open"
                        on:click=move |_| {
                            if let Some(ready) = preview.get_untracked() {
                                dispatch_action(
                                    transport,
                                    state,
                                    AppAction::OpenMultisigWallet(ready),
                                );
                            }
                        }
                    >
                        "Open multisig wallet"
                    </button>
                </section>
            </Show>
        </section>
    }
}
