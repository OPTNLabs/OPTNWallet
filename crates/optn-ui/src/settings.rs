#![cfg(target_arch = "wasm32")]

//! Settings: appearance and network.
//!
//! Theme mode and skin are `AppAction`s on `AppState`, not renderer-local
//! signals. Switching either one must not touch wallets, keys, or the network,
//! so this screen dispatches through the transport like every other surface
//! and reads the result back out of the snapshot.

use crate::tools::WalletChrome;
use crate::{dispatch_action, UiTransport};
use leptos::prelude::*;
use optn_app::{
    settings_view_model, AppAction, AppState, FeatureFlag, Network, SettingsRowId, ThemeMode,
    UiSkin, WalletKind,
};

/// Every theme mode, in the product's documented order.
///
/// Walked from [`ThemeMode::next`] rather than written out, because a mode
/// added to the domain and missing from this list would be a mode the user
/// can reach with the topbar toggle but cannot find in Settings.
fn theme_modes() -> Vec<ThemeMode> {
    let start = ThemeMode::Light;
    let mut modes = vec![start];
    let mut cursor = start.next();
    while cursor != start {
        modes.push(cursor);
        cursor = cursor.next();
    }
    modes
}

/// Exhaustive on purpose: a new mode must fail to compile here rather than
/// render as a blank row.
fn theme_copy(mode: ThemeMode) -> (&'static str, &'static str) {
    match mode {
        ThemeMode::Light => ("Light", "Light surfaces, dark text"),
        ThemeMode::Gray => ("Gray", "Charcoal everyday dark, not OLED black"),
        ThemeMode::Green => ("Green", "OPTN wallet green — the product default"),
        ThemeMode::Dark => ("Dark", "True black for OLED screens"),
    }
}

fn skins() -> [UiSkin; 2] {
    [UiSkin::Default, UiSkin::Cyberpunk]
}

fn skin_copy(skin: UiSkin) -> (&'static str, &'static str) {
    match skin {
        UiSkin::Default => ("Default", "OPTN product chrome"),
        UiSkin::Cyberpunk => ("Cyberpunk", "Neon accent over the selected mode"),
    }
}

fn network_copy(network: Network) -> (&'static str, &'static str) {
    match network {
        Network::Mainnet => ("Mainnet", "Real BCH network"),
        Network::Chipnet => ("Chipnet", "BCH testing network"),
    }
}

fn settings_rows_snapshot(state: RwSignal<AppState>) -> Vec<SettingsRowId> {
    settings_view_model(&state.get()).rows
}

#[component]
pub fn SettingsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"Settings"</h1>
                <p class="lede">"Wallet controls. CashFusion is a desktop flag."</p>
                <AppearanceSection transport=transport state=state />
                <For
                    each=move || settings_rows_snapshot(state)
                    key=|row| *row as u8
                    let:row
                >
                    <SettingsRow transport=transport state=state row=row />
                </For>
            </section>
        </WalletChrome>
    }
}

#[component]
fn SettingsRow(
    transport: UiTransport,
    state: RwSignal<AppState>,
    row: SettingsRowId,
) -> impl IntoView {
    view! {
        <article class="panel settings-row">
            <p class="source-title">{row.title()}</p>
            <p class="muted">{row.description()}</p>
            {match row {
                SettingsRowId::Network => view! {
                    <NetworkSection transport=transport state=state />
                }.into_any(),
                SettingsRowId::Faucet => view! {
                    <p class="mono">
                        {move || settings_view_model(&state.get()).faucet_url.unwrap_or_default()}
                    </p>
                }.into_any(),
                SettingsRowId::WalletInfo => view! {
                    <p class="mono">
                        {move || {
                            let vm = settings_view_model(&state.get());
                            format!(
                                "{} · {} · {}",
                                vm.wallet_name.unwrap_or_else(|| "Wallet".into()),
                                match vm.wallet_kind {
                                    Some(WalletKind::WatchOnly) => "Watch-only",
                                    Some(WalletKind::Hardware) => "Hardware",
                                    Some(WalletKind::Seed) => "Seed",
                                    None => "Closed",
                                },
                                network_copy(vm.network).0
                            )
                        }}
                    </p>
                    <p class="mono">
                        {move || settings_view_model(&state.get()).receive_address.unwrap_or_default()}
                    </p>
                }.into_any(),
                SettingsRowId::Derivation => view! {
                    <p class="mono">{move || settings_view_model(&state.get()).derivation_path}</p>
                }.into_any(),
                SettingsRowId::Recovery => view! {
                    <p class="muted">
                        {move || match settings_view_model(&state.get()).wallet_kind {
                            Some(WalletKind::WatchOnly) => {
                                "Watch-only wallets have no recovery phrase."
                            }
                            _ => "The phrase stays in the keychain. It is never shown here.",
                        }}
                    </p>
                }.into_any(),
                SettingsRowId::RebuildWallet => view! {
                    <button
                        class="secondary"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::RebuildWallet,
                        )
                    >
                        "Rebuild wallet"
                    </button>
                }.into_any(),
                SettingsRowId::Servers => view! { <NodeSection state=state /> }.into_any(),
                SettingsRowId::CashFusion => view! {
                    <button
                        class="secondary"
                        type="button"
                        on:click=move |_| {
                            let enabled = settings_view_model(&state.get()).show_cash_fusion;
                            dispatch_action(
                                transport,
                                state,
                                AppAction::SetFeatureEnabled {
                                    flag: FeatureFlag::CashFusion,
                                    enabled: !enabled,
                                },
                            );
                        }
                    >
                        {move || if settings_view_model(&state.get()).show_cash_fusion {
                            "On"
                        } else {
                            "Off"
                        }}
                    </button>
                }.into_any(),
            }}
        </article>
    }
}

#[component]
fn AppearanceSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <section class="panel">
            <div class="panel-head">
                <h2>"Theme mode"</h2>
                <span class="muted">"Colour scheme"</span>
            </div>
            <p class="muted">
                "Changing the mode does not change your wallets, keys, or network."
            </p>
            <div class="choice-list" role="radiogroup" aria-label="Theme mode">
                <For each=theme_modes key=|mode| mode.css_class() let:mode>
                    <ThemeChoice transport=transport state=state mode=mode />
                </For>
            </div>

            <div class="panel-head">
                <h2>"Skin"</h2>
                <span class="muted">"Chrome on top of the mode"</span>
            </div>
            <div class="choice-list" role="radiogroup" aria-label="Skin">
                <For each=skins key=|skin| skin.css_class() let:skin>
                    <SkinChoice transport=transport state=state skin=skin />
                </For>
            </div>
        </section>
    }
}

#[component]
fn ThemeChoice(
    transport: UiTransport,
    state: RwSignal<AppState>,
    mode: ThemeMode,
) -> impl IntoView {
    let (name, description) = theme_copy(mode);
    let selected = move || state.get().theme == mode;
    view! {
        <button
            class="network-choice"
            class:active=selected
            type="button"
            role="radio"
            aria-checked=move || if selected() { "true" } else { "false" }
            data-testid=format!("theme-{}", mode.css_class())
            on:click=move |_| dispatch_action(transport, state, AppAction::SetTheme(mode))
        >
            <span class=format!("theme-swatch {}", mode.css_class()) aria-hidden="true"></span>
            <div>
                <p class="source-title">{name}</p>
                <p class="muted">{description}</p>
            </div>
            <Show when=selected>
                <span class="ok">"Active"</span>
            </Show>
        </button>
    }
}

#[component]
fn SkinChoice(transport: UiTransport, state: RwSignal<AppState>, skin: UiSkin) -> impl IntoView {
    let (name, description) = skin_copy(skin);
    let selected = move || state.get().skin == skin;
    view! {
        <button
            class="network-choice"
            class:active=selected
            type="button"
            role="radio"
            aria-checked=move || if selected() { "true" } else { "false" }
            data-testid=format!("skin-{}", skin.css_class())
            on:click=move |_| dispatch_action(transport, state, AppAction::SetSkin(skin))
        >
            <span
                class=move || format!("theme-swatch {} {}", state.get().theme.css_class(), skin.css_class())
                aria-hidden="true"
            ></span>
            <div>
                <p class="source-title">{name}</p>
                <p class="muted">{description}</p>
            </div>
            <Show when=selected>
                <span class="ok">"Active"</span>
            </Show>
        </button>
    }
}

#[component]
fn NetworkSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <div class="choice-list" role="radiogroup" aria-label="Network">
            <For
                each=|| [Network::Mainnet, Network::Chipnet]
                key=|network| network_copy(*network).0
                let:network
            >
                <NetworkChoice transport=transport state=state network=network />
            </For>
        </div>
    }
}

#[component]
fn NetworkChoice(
    transport: UiTransport,
    state: RwSignal<AppState>,
    network: Network,
) -> impl IntoView {
    let (name, description) = network_copy(network);
    let selected = move || state.get().network == network;
    view! {
        <button
            class="network-choice"
            class:active=selected
            type="button"
            role="radio"
            aria-checked=move || if selected() { "true" } else { "false" }
            on:click=move |_| dispatch_action(transport, state, AppAction::SetNetwork(network))
        >
            <div>
                <p class="source-title">{name}</p>
                <p class="muted">{description}</p>
            </div>
            <Show when=selected>
                <span class="ok">"Active"</span>
            </Show>
        </button>
    }
}

/// The node the selected network resolves to.
///
/// Read-only for now: the endpoint is the network's documented default, and
/// nothing in application state overrides it yet. Showing it beats showing
/// nothing, because "which node am I on" is the first question when a balance
/// looks wrong.
#[component]
fn NodeSection(state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <dl class="preview-grid">
            <div>
                <dt>"Host"</dt>
                <dd class="mono">{move || state.get().network.default_host()}</dd>
            </div>
            <div>
                <dt>"Port"</dt>
                <dd class="mono">{move || state.get().network.default_port().to_string()}</dd>
            </div>
            <div class="preview-wide">
                <dt>"Address prefix"</dt>
                <dd class="mono">{move || format!("{}:", state.get().network.prefix())}</dd>
            </div>
        </dl>
        <p class="muted">
            "This wallet uses the network's default Electrum endpoint."
        </p>
    }
}
