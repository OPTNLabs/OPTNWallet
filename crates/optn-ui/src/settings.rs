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
    app_lock_view_model, settings_view_model, AppAction, AppState, AutoLockMinutes, FeatureFlag,
    HardwareVendor, LedgerLink, Network, ServerKind, SettingsRowId, ThemeMode, UiSkin, WalletKind,
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

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[component]
pub fn SettingsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <Show when=move || state.get().settings_focus.is_none()>
                    <h1>"Settings"</h1>
                    <p class="lede">"Wallet controls. CashFusion is a desktop flag."</p>
                    <AppearanceSection transport=transport state=state />
                    <For
                        each=move || settings_rows_snapshot(state)
                        key=|row| *row as u8
                        let:row
                    >
                        <button
                            class="panel settings-row"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::OpenSettingsRow(row),
                            )
                        >
                            <p class="source-title">{row.title()}</p>
                            <p class="muted">{row.description()}</p>
                        </button>
                    </For>
                </Show>
                <Show when=move || state.get().settings_focus.is_some()>
                    <button
                        class="text-link back"
                        type="button"
                        on:click=move |_| dispatch_action(transport, state, AppAction::GoBack)
                    >
                        {move || format!("‹ {}", state.get().flow().back_label)}
                    </button>
                    {move || state.get().settings_focus.map(|row| {
                        view! { <SettingsRow transport=transport state=state row=row /> }
                    })}
                </Show>
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
                            _ => "The phrase stays in the keychain as ciphertext. Revealing it always asks for the password.",
                        }}
                    </p>
                    <Show when=move || {
                        settings_view_model(&state.get()).wallet_kind == Some(WalletKind::Seed)
                    }>
                        <button
                            class="secondary"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::RequestReveal { now_ms: now_ms() },
                            )
                        >
                            "Reveal backup"
                        </button>
                    </Show>
                }.into_any(),
                SettingsRowId::AppLock => view! {
                    <AppLockSection transport=transport state=state />
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
                SettingsRowId::Servers => view! {
                    <NodeSection transport=transport state=state />
                }.into_any(),
                SettingsRowId::Device => view! {
                    <DeviceSection transport=transport state=state />
                }.into_any(),
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

fn selected_server_entry(state: &AppState, kind: ServerKind) -> String {
    state
        .servers
        .for_network(state.network)
        .get(kind)
        .unwrap_or_default()
        .to_owned()
}

#[component]
fn NodeSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <p class="muted">
            "Overrides apply only to the selected network. Leave a field blank to use its default."
        </p>
        <dl class="preview-grid">
            <div>
                <dt>"Default host"</dt>
                <dd class="mono">{move || state.get().network.default_host()}</dd>
            </div>
            <div>
                <dt>"Default port"</dt>
                <dd class="mono">{move || state.get().network.default_port().to_string()}</dd>
            </div>
            <div class="preview-wide">
                <dt>"Address prefix"</dt>
                <dd class="mono">{move || format!("{}:", state.get().network.prefix())}</dd>
            </div>
        </dl>
        <ServerField transport=transport state=state kind=ServerKind::Electrum />
        <ServerField transport=transport state=state kind=ServerKind::Peer />
        <ServerField transport=transport state=state kind=ServerKind::Explorer />
        <button
            class="secondary"
            type="button"
            data-testid="use-network-default-servers"
            on:click=move |_| dispatch_action(
                transport,
                state,
                AppAction::UseNetworkDefaultServers,
            )
        >
            "Use network default"
        </button>
    }
}

#[component]
fn ServerField(
    transport: UiTransport,
    state: RwSignal<AppState>,
    kind: ServerKind,
) -> impl IntoView {
    let entry = RwSignal::new(selected_server_entry(&state.get_untracked(), kind));
    let saved_entry = Memo::new(move |_| selected_server_entry(&state.get(), kind));
    let last_saved_entry = RwSignal::new(saved_entry.get_untracked());

    // Keep the input authoritative after a successful save or a network switch,
    // while preserving a draft when unrelated state changes.
    Effect::new(move |_| {
        let saved = saved_entry.get();
        if last_saved_entry.get_untracked() != saved {
            entry.set(saved.clone());
            last_saved_entry.set(saved);
        }
    });

    view! {
        <form
            class="watch-only-form"
            data-testid=format!("server-{}-form", kind.id())
            on:submit=move |event| {
                event.prevent_default();
                dispatch_action(
                    transport,
                    state,
                    AppAction::SetServer {
                        kind,
                        entry: entry.get_untracked(),
                    },
                );
            }
        >
            <label class="field">
                <span>{kind.label()}</span>
                <input
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    autocapitalize="none"
                    placeholder=kind.hint()
                    data-testid=format!("server-{}", kind.id())
                    prop:value=move || entry.get()
                    on:input=move |event| entry.set(event_target_value(&event))
                />
            </label>
            <button class="secondary" type="submit">
                "Save"
            </button>
        </form>
    }
}

#[component]
fn AppLockSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <p class="muted">
            {move || {
                let vm = app_lock_view_model(
                    &state.get().lock,
                    state.get().wallet.as_ref().map(|wallet| wallet.kind),
                );
                if vm.secrets_are_ciphertext {
                    "This wallet file stores ciphertext. The key is derived for each operation and discarded."
                } else {
                    "Watch-only and hardware wallets have no seed ciphertext on this device."
                }
            }}
        </p>
        <p class="muted">
            {move || {
                let vm = app_lock_view_model(
                    &state.get().lock,
                    state.get().wallet.as_ref().map(|wallet| wallet.kind),
                );
                if vm.auto_lock.is_never() {
                    format!(
                        "Never: password pops up only on Send after {} minutes. CashFusion, auto-fusion, and chat do not ask.",
                        vm.cache_minutes
                    )
                } else {
                    "A timer is set, so Send does not re-prompt — the wallet auto-locks after idle.".into()
                }
            }}
        </p>
        <div class="choice-list" role="radiogroup" aria-label="Auto-lock after">
            <For
                each=move || AutoLockMinutes::offered().to_vec()
                key=|option| option.as_minutes()
                let:option
            >
                <button
                    class="network-choice"
                    class:active=move || state.get().lock.auto_lock == option
                    type="button"
                    role="radio"
                    aria-checked=move || if state.get().lock.auto_lock == option { "true" } else { "false" }
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::SetAutoLockMinutes(option.as_minutes()),
                    )
                >
                    <div>
                        <p class="source-title">{option.label()}</p>
                    </div>
                </button>
            </For>
        </div>
        <button
            class="secondary"
            type="button"
            on:click=move |_| dispatch_action(transport, state, AppAction::LockWallet)
        >
            "Lock now"
        </button>
    }
}

/// The connected signer, and every field the session holds.
///
/// Rendered only where a device can be reached, because the row itself is
/// only offered there.
#[component]
fn DeviceSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let session = move || settings_view_model(&state.get()).hardware;

    view! {
        <div class="device-section">
            <div class="choice-list" role="radiogroup" aria-label="Hardware device">
                {move || {
                    let chosen = session().vendor;
                    HardwareVendor::USB_DEVICES
                        .iter()
                        .map(|vendor| {
                            let vendor = *vendor;
                            view! {
                                <button
                                    class="network-choice"
                                    class:active=move || session().vendor == Some(vendor)
                                    type="button"
                                    role="radio"
                                    aria-checked=if chosen == Some(vendor) { "true" } else { "false" }
                                    data-testid=format!("device-{}", vendor.id())
                                    on:click=move |_| dispatch_action(
                                        transport,
                                        state,
                                        AppAction::SelectHardwareVendor(Some(vendor)),
                                    )
                                >
                                    <div>
                                        <p class="source-title">{vendor.label()}</p>
                                    </div>
                                    <Show when=move || session().vendor == Some(vendor)>
                                        <span class="ok">"Selected"</span>
                                    </Show>
                                </button>
                            }
                        })
                        .collect_view()
                }}
            </div>

            <Show when=move || session().vendor.is_some()>
                <dl class="preview-grid">
                    <div>
                        <dt>"Status"</dt>
                        <dd data-testid="device-status">
                            {move || if session().connected { "Connected" } else { "Not connected" }}
                        </dd>
                    </div>
                    <div>
                        <dt>"Device"</dt>
                        <dd>{move || session().device_label.unwrap_or_else(|| "-".into())}</dd>
                    </div>
                    <div>
                        <dt>"Account"</dt>
                        // Resolved by the application. A device with no chosen
                        // account derives where the wallet does, and this screen
                        // does not hold that rule -- the React one had to compare
                        // against a mainnet sentinel string in three places.
                        <dd class="mono" data-testid="device-path">
                            {move || settings_view_model(&state.get()).hardware_derivation_path}
                        </dd>
                    </div>
                </dl>

                <Show when=move || {
                    settings_view_model(&state.get()).hardware_path_warning.is_some()
                }>
                    <p class="warn" data-testid="device-path-warning">
                        {move || {
                            settings_view_model(&state.get())
                                .hardware_path_warning
                                .unwrap_or_default()
                        }}
                    </p>
                </Show>

                // Ledger is the only vendor with a wire to choose.
                <Show when=move || session().offers_link_choice()>
                    <div class="choice-list" role="radiogroup" aria-label="Ledger connection">
                        {move || {
                            let current = session().ledger_link;
                            [LedgerLink::Usb, LedgerLink::Bluetooth]
                                .into_iter()
                                .map(|link| view! {
                                    <button
                                        class="network-choice"
                                        class:active=move || session().ledger_link == link
                                        type="button"
                                        role="radio"
                                        aria-checked=if current == link { "true" } else { "false" }
                                        data-testid=format!(
                                            "ledger-link-{}",
                                            link.label().to_lowercase()
                                        )
                                        on:click=move |_| dispatch_action(
                                            transport,
                                            state,
                                            AppAction::SetLedgerLink(link),
                                        )
                                    >
                                        <div><p class="source-title">{link.label()}</p></div>
                                    </button>
                                })
                                .collect_view()
                        }}
                    </div>
                </Show>

                <button
                    class="secondary"
                    type="button"
                    data-testid="device-forget"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::SelectHardwareVendor(None),
                    )
                >
                    "Forget this device"
                </button>
            </Show>
        </div>
    }
}
