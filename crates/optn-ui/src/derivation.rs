#![cfg(target_arch = "wasm32")]

//! Derivation on Create/Import: standard path, with Customize for a typed account.

use crate::onboarding::derivation_for_network;
use leptos::prelude::*;
use optn_app::{parse_account_path, AccountPath, AppState};

/// Account selection for a new or imported seed wallet.
///
/// `selected` is owned by the caller so the surrounding form can derive its
/// preview from the same value the picker shows.
///
/// Network is read from `state` through a Memo. Capturing it once left
/// Chipnet on Create offering mainnet coin types.
#[component]
pub fn DerivationPicker(
    state: RwSignal<AppState>,
    selected: RwSignal<AccountPath>,
    /// Set when a typed path is rejected, cleared when it parses.
    error: RwSignal<Option<String>>,
) -> impl IntoView {
    let custom = RwSignal::new(String::new());
    let advanced = RwSignal::new(false);
    let network = Memo::new(move |_| state.get().network);

    Effect::new(move |_| {
        selected.set(derivation_for_network(network.get()));
    });

    view! {
        <section class="derivation-picker">
            <div class="panel-head">
                <span class="field-label">"Derivation path"</span>
                <button
                    class="text-button"
                    type="button"
                    on:click=move |_| {
                        let next = !advanced.get_untracked();
                        advanced.set(next);
                        if !next {
                            error.set(None);
                            custom.set(String::new());
                            selected.set(derivation_for_network(network.get_untracked()));
                        }
                    }
                >
                    {move || if advanced.get() { "Use standard path" } else { "Customize" }}
                </button>
            </div>
            <p class="mono">{move || selected.get().to_string()}</p>
            <Show when=move || advanced.get()>
                <label class="field">
                    <span>"Custom account path"</span>
                    <input
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        autocapitalize="none"
                        placeholder="m/44'/145'/0'"
                        prop:value=move || custom.get()
                        on:input=move |event| {
                            let typed = event_target_value(&event);
                            custom.set(typed.clone());
                            if typed.trim().is_empty() {
                                error.set(None);
                                return;
                            }
                            match parse_account_path(&typed) {
                                Ok(account) => {
                                    error.set(None);
                                    selected.set(account);
                                }
                                Err(message) => error.set(Some(message.to_string())),
                            }
                        }
                    />
                    <small>
                        "Account level only, such as m/44'/145'/0'. An address path is refused."
                    </small>
                </label>
            </Show>
        </section>
    }
}
