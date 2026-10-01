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
        // Named individually because the screen is the only place the three
        // test chains differ: they share `bchtest:`, so an address cannot say
        // which one a wallet is on.
        Network::Testnet3 => ("Testnet3", "Long-running BCH test network"),
        Network::Testnet4 => ("Testnet4", "Shorter BCH test network"),
        Network::Chipnet => ("Chipnet", "BCH testing network"),
        // Its own prefix, genesis and no retargeting -- named so a regtest
        // wallet is never mistaken on screen for one on a shared network.
        Network::Regtest => ("Regtest", "Locally mined chain for testing"),
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
    // The app receives a fresh authoritative snapshot every second. A selected
    // row owns local form state and in-flight IPC, so it must remount only
    // when the selected row actually changes, not for unrelated balance or
    // sync-status updates in that snapshot.
    let focused_row = Memo::new(move |_| state.get().settings_focus);

    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <Show when=move || focused_row.get().is_none()>
                    <h1>"Settings"</h1>
                    <p class="lede">"Wallet controls. CashFusion is a desktop flag."</p>
                    <AppearanceSection transport=transport state=state />
                    <TorSection transport=transport />
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
                <Show when=move || focused_row.get().is_some()>
                    <button
                        class="text-link back"
                        type="button"
                        on:click=move |_| dispatch_action(transport, state, AppAction::GoBack)
                    >
                        {move || format!("‹ {}", state.get().flow().back_label)}
                    </button>
                    {move || focused_row.get().map(|row| {
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
                SettingsRowId::RescanFromHeight => view! {
                    <BirthdaySection transport=transport state=state />
                    <RescanSection transport=transport state=state />
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

/// What the chain layer found when it went looking for a proxy, and the one
/// action that fixes it.
///
/// This renderer had no Tor awareness at all, which is #75 row 4's remaining
/// half: a holder here saw every public source refused for want of Tor with
/// nothing saying so and nothing to press. The React surface has had this for
/// a while; the point is that both surfaces ask the runtime the same question
/// rather than each deciding for itself what a listening proxy means.
///
/// Nothing is probed here. `tor_status` reports what the chain stack
/// concluded, so a screen cannot disagree with the routes.
#[component]
pub(crate) fn TorSection(transport: UiTransport) -> impl IntoView {
    let status = RwSignal::new(None::<optn_transport::WireTorStatus>);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let custom_port = RwSignal::new(String::new());

    let refresh = move || {
        let transport = transport.get_value();
        leptos::task::spawn_local(async move {
            match transport.tor_status().await {
                Ok(value) => status.set(Some(value)),
                // Unsupported is the honest answer on a shell with no chain
                // runtime; it is not an error worth showing.
                Err(optn_transport::TransportError::Unsupported) => status.set(None),
                Err(failure) => error.set(Some(format!("{failure:?}"))),
            }
        });
    };
    leptos::prelude::Effect::new(move |_| refresh());

    view! {
        <Show when=move || {
            status.get().is_some_and(|value| {
                !matches!(value.state, optn_transport::WireTorState::NotNeeded)
            })
        }>
            <div class="panel stack">
                <p class="source-title">"Tor"</p>
                {move || {
                    let Some(value) = status.get() else { return ().into_any() };
                    match value.state {
                        optn_transport::WireTorState::Verified => view! {
                            <p class="muted">
                                {format!(
                                    "Public sources are reached through the proxy on port {}.",
                                    value.socks_port.unwrap_or_default(),
                                )}
                            </p>
                        }
                        .into_any(),
                        optn_transport::WireTorState::Unverified => {
                            let port = value.socks_port.unwrap_or_default();
                            view! {
                                <p class="muted">
                                    {format!(
                                        "A SOCKS proxy is listening on port {port}, but nothing                                          shows it is Tor -- every SOCKS proxy answers the same                                          way. Public sources stay refused until you confirm it.",
                                    )}
                                </p>
                                <button
                                    class="secondary"
                                    type="button"
                                    disabled=move || busy.get()
                                    on:click=move |_| {
                                        busy.set(true);
                                        error.set(None);
                                        let transport = transport.get_value();
                                        leptos::task::spawn_local(async move {
                                            if let Err(failure) =
                                                transport.trust_socks_port(port, true).await
                                            {
                                                error.set(Some(format!("{failure:?}")));
                                            }
                                            busy.set(false);
                                            refresh();
                                        });
                                    }
                                >
                                    {format!("Yes, {port} is my Tor")}
                                </button>
                            }
                            .into_any()
                        }
                        optn_transport::WireTorState::Absent => view! {
                            <p class="muted">
                                "Public sources are reached through Tor, and none is running.                                  A source you marked as your own is dialled directly instead."
                            </p>
                            <button
                                class="secondary"
                                type="button"
                                disabled=move || busy.get()
                                on:click=move |_| {
                                    busy.set(true);
                                    error.set(None);
                                    let transport = transport.get_value();
                                    leptos::task::spawn_local(async move {
                                        match transport.start_tor().await {
                                            Ok(value) => status.set(Some(value)),
                                            Err(failure) => {
                                                error.set(Some(format!("{failure:?}")))
                                            }
                                        }
                                        busy.set(false);
                                    });
                                }
                            >
                                {move || {
                                    if busy.get() {
                                        let percent = status
                                            .get()
                                            .map(|value| value.bootstrap_percent)
                                            .unwrap_or_default();
                                        format!("Starting Tor... {percent}%")
                                    } else {
                                        "Start Tor for chain routes".to_owned()
                                    }
                                }}
                            </button>
                        }
                        .into_any(),
                        optn_transport::WireTorState::NotNeeded => ().into_any(),
                    }
                }}
                <details>
                    <summary>"Use Tor on another local port"</summary>
                    <p class="muted">"Only confirm a Tor proxy you run or trust. A SOCKS listener alone does not prove it is Tor."</p>
                    <label>
                        "Local Tor SOCKS port"
                        <input
                            type="number" min="1" max="65535" step="1"
                            prop:value=move || custom_port.get()
                            on:input=move |event| custom_port.set(event_target_value(&event))
                        />
                    </label>
                    <button
                        class="secondary" type="button"
                        disabled=move || busy.get()
                        on:click=move |_| {
                            let Ok(port) = custom_port.get().parse::<std::num::NonZeroU16>() else {
                                error.set(Some("Enter a port from 1 to 65535.".into()));
                                return;
                            };
                            busy.set(true);
                            error.set(None);
                            let transport = transport.get_value();
                            leptos::task::spawn_local(async move {
                                if let Err(failure) = transport.trust_socks_port(port.get(), true).await {
                                    error.set(Some(format!("{failure:?}")));
                                }
                                busy.set(false);
                                refresh();
                            });
                        }
                    >"Confirm this is my Tor"</button>
                </details>
                {move || error.get().map(|message| view! { <p class="error">{message}</p> })}
            </div>
        </Show>
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
        <crate::chain_sources::ChainSourcesSection transport=transport state=state />

    }
}

#[component]
pub(crate) fn ServerField(
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
        <crate::security::SecuritySettings transport=transport state=state />
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

#[component]
fn BirthdaySection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    use optn_transport::security::{WalletBirthdayInput, WalletBirthdayView};
    use optn_transport::WalletSecurityRequest as Request;
    let status = RwSignal::new(None::<optn_transport::WalletSecurityStatus>);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let kind = RwSignal::new(String::from("unknown"));
    let height = RwSignal::new(String::new());
    let date = RwSignal::new(None::<u32>);
    let confirming = RwSignal::new(false);
    let clearing_rescan = RwSignal::new(false);
    let restore_revision = Memo::new(move |_| {
        state.with(|state| (state.lock.unlock_epoch, state.wallet_sync.rescan_requested))
    });
    Effect::new(move |_| {
        restore_revision.get();
        crate::security::submit(transport, state, Request::Status, status, error, busy);
    });
    let selection = move || match kind.get().as_str() {
        "height" => height
            .get()
            .trim()
            .parse::<u32>()
            .ok()
            .map(|height| WalletBirthdayInput::Height { height }),
        "time" => date
            .get()
            .map(|requested_time| WalletBirthdayInput::Time { requested_time }),
        _ => Some(WalletBirthdayInput::Unknown),
    };
    view! {
        <section class="stack" aria-label="Wallet history start">
            <h3>"Wallet history start"</h3>
            <p class="muted">{move || match status.get().and_then(|s| s.restore_birthday) {
                Some(WalletBirthdayView::ImportedAtHeight { height }) => format!("Saved start: block {height}."),
                Some(WalletBirthdayView::ImportedAtTime { requested_time }) => {
                    let iso = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(f64::from(requested_time) * 1000.0))
                        .to_iso_string().as_string().unwrap_or_default();
                    format!("Saved start: {} (UTC).", iso.get(..10).unwrap_or("unknown date"))
                },
                Some(WalletBirthdayView::CreatedAt { height, .. }) => format!("Recorded creation: block {height}."),
                Some(WalletBirthdayView::Unknown) => "Saved start: unknown; scan full history.".into(),
                None => "Open a wallet to save its history start.".into(),
            }}</p>
            <label class="field">"Known wallet start"
                <select prop:value=move || kind.get() on:change=move |event| {
                    kind.set(event_target_value(&event)); date.set(None); confirming.set(false);
                }>
                    <option value="unknown">"Unknown — full history"</option>
                    <option value="height">"Block height"</option>
                    <option value="time">"Date (UTC)"</option>
                </select>
            </label>
            <Show when=move || kind.get() == "height">
                <label class="field">"Earliest block"
                    <input type="text" inputmode="numeric" prop:value=move || height.get()
                        on:input=move |event| { height.set(event_target_value(&event)); confirming.set(false); } />
                </label>
            </Show>
            <Show when=move || kind.get() == "time">
                <label class="field">"Earliest date (UTC)"
                    <input type="date" on:input=move |event| {
                        let seconds = event_target::<web_sys::HtmlInputElement>(&event).value_as_number() / 1000.0;
                        date.set((seconds.is_finite() && seconds >= 0.0 && seconds <= f64::from(u32::MAX))
                            .then_some(seconds as u32));
                        confirming.set(false);
                    } />
                </label>
            </Show>
            <p class="muted">"Saved separately from a manual rescan, which takes precedence. Choose Unknown if you are unsure when this wallet first received funds."</p>
            {move || status.get().and_then(|s| s.manual_rescan_from).map(|height| view! {
                <p class="muted">{format!("Manual rescan override: block {height}.")}</p>
            })}
            {move || error.get().map(|message| view! { <p class="warning" role="alert">{message}</p> })}
            <Show when=move || confirming.get() fallback=move || view! {
                <button class="secondary" type="button"
                    disabled=move || busy.get() || selection().is_none() || status.get().and_then(|s| s.restore_birthday).is_none()
                    on:click=move |_| { clearing_rescan.set(false); confirming.set(true); }>"Save history start"</button>
            }>
                <p class="warning">{move || if clearing_rescan.get() {
                    "Remove the manual override and return to the saved wallet history start? A later start can hide earlier funds. Refresh afterward to apply it."
                } else {
                    "A start later than your first payment can hide funds and history. Save this choice? Refresh the wallet afterward to apply it."
                }}</p>
                <div class="row">
                    <button class="primary" type="button" disabled=move || busy.get()
                        on:click=move |_| {
                            let Some(current) = status.get_untracked() else { return };
                            let request = if clearing_rescan.get_untracked() {
                                Request::ClearRescan { epoch: current.epoch }
                            } else {
                                let Some(birthday) = selection() else { return };
                                Request::SetBirthday { epoch: current.epoch, birthday }
                            };
                            confirming.set(false);
                            crate::security::submit(transport, state, request, status, error, busy);
                        }>"Confirm history start"</button>
                    <button class="secondary" type="button" on:click=move |_| confirming.set(false)>"Cancel"</button>
                </div>
            </Show>
            <Show when=move || !confirming.get() && status.get().and_then(|s| s.manual_rescan_from).is_some()>
                <button class="secondary" type="button" disabled=move || busy.get()
                    on:click=move |_| { clearing_rescan.set(true); confirming.set(true); }>
                    "Use saved wallet history start"
                </button>
            </Show>
        </section>
    }
}

/// Read the chain again from a block the holder chooses.
///
/// Two steps on purpose. A height typed by hand is easy to get wrong, and a
/// number that is too high quietly leaves coins out of the wallet rather than
/// failing, so the confirm step says what will be skipped before it happens.
#[component]
fn RescanSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let entry = RwSignal::new(String::new());
    let confirming = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);

    // A height above the verified tip is not a scan, it is a typo.
    let parsed = move || {
        let raw = entry.get();
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(String::new());
        }
        let height: u32 = trimmed
            .parse()
            .map_err(|_| "Enter a block height as a whole number.".to_owned())?;
        match settings_view_model(&state.get()).tip_height {
            Some(tip) if height > tip => {
                Err(format!("This wallet has only verified up to block {tip}."))
            }
            _ => Ok(height),
        }
    };

    view! {
        <div class="stack">
            <p class="muted">
                {move || {
                    let model = settings_view_model(&state.get());
                    match (model.rescan_requested, model.scan_coverage) {
                        (Some(height), _) => format!(
                            "Waiting on a rescan from block {height}.                              Balances below stay as they were until it finishes."
                        ),
                        (None, Some(coverage)) => match coverage.skipped_below {
                            Some(skipped) => format!(
                                "Scanning from block {}. Blocks below {skipped} are not                                  covered, so coins received earlier and never spent are                                  missing from the totals.",
                                coverage.from_height
                            ),
                            None => format!("Scanning from block {}.", coverage.from_height),
                        },
                        (None, None) => "Scanning from this wallet's own start point.".into(),
                    }
                }}
            </p>
            <label class="field">
                "Block height"
                <input
                    class="mono"
                    type="text"
                    inputmode="numeric"
                    placeholder="e.g. 800000"
                    prop:value=move || entry.get()
                    on:input=move |event| {
                        entry.set(event_target_value(&event));
                        confirming.set(false);
                        error.set(None);
                    }
                />
            </label>
            {move || error.get().map(|message| view! { <p class="warning">{message}</p> })}
            <Show
                when=move || confirming.get()
                fallback=move || view! {
                    <button
                        class="secondary"
                        type="button"
                        disabled=move || busy.get() || parsed().is_err()
                        on:click=move |_| {
                            match parsed() {
                                Ok(_) => { error.set(None); confirming.set(true); }
                                Err(message) if message.is_empty() => {}
                                Err(message) => error.set(Some(message)),
                            }
                        }
                    >
                        "Rescan from this height"
                    </button>
                }
            >
                <p class="warning">
                    {move || match parsed() {
                        Ok(height) => format!(
                            "Rescan from block {height}? Anything before it is left                              unscanned, including coins you still hold. Your keys and                              addresses are untouched."
                        ),
                        Err(_) => String::new(),
                    }}
                </p>
                <div class="row">
                    <button
                        class="primary"
                        type="button"
                        disabled=move || busy.get()
                        on:click=move |_| {
                            let Ok(height) = parsed() else { return };
                            if busy.get_untracked() { return; }
                            busy.set(true);
                            error.set(None);
                            confirming.set(false);
                            let transport = transport.get_value();
                            leptos::task::spawn_local(async move {
                                if let Err(failure) = transport.rescan_from_height(height).await {
                                    error.try_set(Some(match failure {
                                        optn_transport::TransportError::Other(message)
                                        | optn_transport::TransportError::InvalidData(message) => {
                                            message
                                        }
                                        _ => "Rescanning is unavailable on this interface."
                                            .into(),
                                    }));
                                }
                                if let Ok(snapshot) = transport.snapshot().await {
                                    crate::apply_snapshot(state, snapshot);
                                }
                                busy.try_set(false);
                            });
                        }
                    >
                        "Confirm rescan"
                    </button>
                    <button
                        class="secondary"
                        type="button"
                        on:click=move |_| confirming.set(false)
                    >
                        "Cancel"
                    </button>
                </div>
            </Show>
        </div>
    }
}
