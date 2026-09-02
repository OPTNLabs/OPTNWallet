#![cfg(target_arch = "wasm32")]

//! Account picker shared by Create and Import.
//!
//! The offered paths come from `optn_app::account_choices`, which is generated
//! from the same coin types discovery scans. A renderer-local menu could drift
//! from that set and offer a branch the wallet never looks at.

use leptos::prelude::*;
use optn_app::{account_choices, parse_account_path, AccountPath, Network};

/// Label for one offered account, explaining why it is on the list.
fn choice_note(account: AccountPath, network: Network) -> &'static str {
    if account.is_default_for(network) {
        return "Standard for this network";
    }
    match (account.coin_type(), account.account()) {
        (145, _) => "Bitcoin Cash coin type",
        (1, _) => "Test-net coin type",
        (0, _) => "Legacy coin type, used by older tooling",
        _ => "Scanned during discovery",
    }
}

/// Account selection for a new or imported seed wallet.
///
/// `selected` is owned by the caller so the surrounding form can derive its
/// preview from the same value the picker shows.
#[component]
pub fn DerivationPicker(
    network: Network,
    selected: RwSignal<AccountPath>,
    /// Set when a typed path is rejected, cleared when it parses.
    error: RwSignal<Option<String>>,
) -> impl IntoView {
    let custom = RwSignal::new(String::new());
    let advanced = RwSignal::new(false);

    // Keep the selection valid when the network changes underneath: an
    // account scanned on mainnet is not necessarily scanned on chipnet.
    Effect::new(move |_| {
        let current = selected.get_untracked();
        if !current.is_scanned_for(network) {
            selected.set(AccountPath::default_for(network));
        }
    });

    view! {
        <section class="derivation-picker">
            <div class="panel-head">
                <span class="field-label">"Derivation path"</span>
                <span class="mono muted">{move || selected.get().to_string()}</span>
            </div>

            <div class="choice-list" role="radiogroup" aria-label="Derivation path">
                <For
                    each=move || account_choices(network)
                    key=|account| account.to_string()
                    let:account
                >
                    <button
                        class="network-choice"
                        class:active=move || selected.get() == account
                        type="button"
                        role="radio"
                        attr:aria-checked=move || {
                            if selected.get() == account { "true" } else { "false" }
                        }
                        attr:data-testid=format!("derivation-{}", account.account())
                        on:click=move |_| {
                            error.set(None);
                            custom.set(String::new());
                            selected.set(account);
                        }
                    >
                        <div>
                            <p class="source-title mono">{account.to_string()}</p>
                            <p class="muted">{choice_note(account, network)}</p>
                        </div>
                        <Show when=move || selected.get() == account>
                            <span class="ok">"Selected"</span>
                        </Show>
                    </button>
                </For>
            </div>

            <button
                class="text-button"
                type="button"
                on:click=move |_| advanced.update(|open| *open = !*open)
            >
                {move || if advanced.get() { "Hide custom path" } else { "Use a custom path" }}
            </button>

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

            <Show when=move || !selected.get().is_default_for(network)>
                <p class="hint-card">
                    "This is not the standard account for this network. Use it only if you "
                    "know your funds were derived there."
                </p>
            </Show>
        </section>
    }
}
