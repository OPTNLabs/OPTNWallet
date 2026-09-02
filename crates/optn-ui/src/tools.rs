#![cfg(target_arch = "wasm32")]

use crate::{dispatch_action, UiTransport};
use leptos::prelude::*;
use optn_app::{
    chipnet_demo_coin, coins_view_model, flipstarter_view_model, format_bch, fundme_view_model,
    product_nav, sample_chipnet_campaign_blob, AppAction, AppRoute, AppState, Coin, FreezeReason,
    Network, PledgeStatus, ProductNavItem,
};

fn coins_snapshot(state: RwSignal<AppState>) -> Vec<Coin> {
    state.get().coins.iter().cloned().collect()
}

fn network_label(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "MAINNET",
        Network::Chipnet => "CHIPNET",
    }
}

#[component]
pub fn WalletChrome(
    transport: UiTransport,
    state: RwSignal<AppState>,
    children: Children,
) -> impl IntoView {
    view! {
        <section class=move || {
            format!("wallet-chrome {}", state.get().layout().css_class())
        }>
            <header class="product-topbar">
                <div class="brand-lockup">
                    <span class="brand-mark" aria-hidden="true"></span>
                    <div>
                        <div class="brand">"OPTN"</div>
                        <p class="brand-tag">"Pay, Your Way"</p>
                    </div>
                </div>
                <button
                    class="network-pill"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::Navigate(AppRoute::Settings),
                    )
                >
                    <span class="sync-dot" aria-hidden="true"></span>
                    {move || format!("{} · Local", network_label(state.get().network))}
                </button>
            </header>

            <div class="chrome-body">
                <nav class="tab-rail" aria-label="Wallet">
                    <TabList transport=transport state=state />
                </nav>
                <div class="chrome-main">
                    <NoticeBanner transport=transport state=state />
                    {children()}
                </div>
            </div>

            <nav class="tab-bar" aria-label="Wallet">
                <TabList transport=transport state=state />
            </nav>
        </section>
    }
}

#[component]
fn TabList(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <For
            each=|| product_nav()
            key=|item| match item {
                ProductNavItem::Home => 0u8,
                ProductNavItem::Assets => 1,
                ProductNavItem::Actions => 2,
                ProductNavItem::Explore => 3,
                ProductNavItem::Settings => 4,
            }
            let:item
        >
            <button
                class="tab-item"
                class:active=move || item.is_active(state.get().route)
                type="button"
                on:click=move |_| dispatch_action(
                    transport,
                    state,
                    AppAction::Navigate(item.route()),
                )
            >
                <span class="tab-glyph" aria-hidden="true">
                    {match item {
                        ProductNavItem::Home => "⌂",
                        ProductNavItem::Assets => "▣",
                        ProductNavItem::Actions => "⚡",
                        ProductNavItem::Explore => "◎",
                        ProductNavItem::Settings => "⚙",
                    }}
                </span>
                <span>{item.label()}</span>
            </button>
        </For>
    }
}

#[component]
fn NoticeBanner(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <Show when=move || state.get().notice.is_some()>
            <p class="notice" role="alert">
                <span>{move || state.get().notice.unwrap_or_default()}</span>
                <button
                    class="text-button"
                    type="button"
                    on:click=move |_| dispatch_action(transport, state, AppAction::ClearNotice)
                >
                    "Dismiss"
                </button>
            </p>
        </Show>
    }
}

#[component]
pub fn WalletHome(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <article class="hero-card">
                    <p class="muted">"Total portfolio"</p>
                    <h1 class="balance">
                        {move || format_bch(
                            coins_view_model(&state.get()).spendable_sats
                                + coins_view_model(&state.get()).reserved_sats
                        )}
                    </h1>
                    <div class="hero-meta">
                        <span class="ok">
                            {move || {
                                let count = state.get().coins.len();
                                if count == 0 {
                                    "No sources yet".to_string()
                                } else {
                                    format!("{count} active source")
                                }
                            }}
                        </span>
                        <button
                            class="text-link"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Coins),
                            )
                        >
                            "View breakdown ›"
                        </button>
                    </div>
                </article>

                <section class="panel">
                    <div class="panel-head">
                        <h2>"Portfolio sources"</h2>
                        <button
                            class="text-link"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Coins),
                            )
                        >
                            "Manage"
                        </button>
                    </div>
                    <Show
                        when=move || !state.get().coins.is_empty()
                        fallback=move || view! {
                            <button
                                class="add-source"
                                type="button"
                                on:click=move |_| dispatch_action(
                                    transport,
                                    state,
                                    AppAction::Navigate(AppRoute::Coins),
                                )
                            >
                                <span>"Add portfolio source"</span>
                                <small>"Wallet, watch-only, or Chipnet demo coins"</small>
                            </button>
                        }
                    >
                        <div class="source-row">
                            <div class="source-icon">"▣"</div>
                            <div>
                                <p class="source-title">
                                    "Wallet"
                                    <span class="enabled-pill">"Enabled"</span>
                                </p>
                                <p class="muted">"Standard BCH wallet"</p>
                            </div>
                            <div class="source-value">
                                <strong>
                                    {move || format_bch(coins_view_model(&state.get()).spendable_sats)}
                                </strong>
                                <p class="ok">
                                    {move || {
                                        let reserved = coins_view_model(&state.get()).reserved_sats;
                                        if reserved == 0 {
                                            "Spendable".to_string()
                                        } else {
                                            format!("Reserved {}", format_bch(reserved))
                                        }
                                    }}
                                </p>
                            </div>
                        </div>
                    </Show>
                </section>

                <section class="panel">
                    <div class="panel-head">
                        <h2>"Quick actions"</h2>
                        <button
                            class="text-link"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Coins),
                            )
                        >
                            "Manage assets"
                        </button>
                    </div>
                    <div class="quick-grid">
                        <button
                            class="quick-tile"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Actions),
                            )
                        >
                            <span>"↗"</span>
                            "Send"
                        </button>
                        <button
                            class="quick-tile"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Actions),
                            )
                        >
                            <span>"↙"</span>
                            "Receive"
                        </button>
                        <button
                            class="quick-tile"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::Explore),
                            )
                        >
                            <span>"⇄"</span>
                            "Swap"
                        </button>
                    </div>
                </section>

                <section class="panel">
                    <div class="panel-head">
                        <h2>"Recent activity"</h2>
                    </div>
                    <p class="empty-line">"No activity yet. Pledges and freezes show up under Assets."</p>
                </section>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn CoinsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"Assets"</h1>
                <p class="lede">"Coins you can spend, and coins you have reserved."</p>
                <div class="split-stats">
                    <article class="stat-card">
                        <p class="muted">"Spendable"</p>
                        <strong>{move || format_bch(coins_view_model(&state.get()).spendable_sats)}</strong>
                    </article>
                    <article class="stat-card">
                        <p class="muted">"Reserved"</p>
                        <strong>{move || format_bch(coins_view_model(&state.get()).reserved_sats)}</strong>
                    </article>
                </div>
                <div class="toolbar">
                    <button
                        class="secondary"
                        type="button"
                        on:click=move |_| {
                            let slot = state.get_untracked().coins.len() as u8;
                            if let Ok(coin) = chipnet_demo_coin(4_000, slot) {
                                dispatch_action(transport, state, AppAction::InsertCoin(coin));
                            }
                        }
                    >
                        "Add Chipnet demo coin"
                    </button>
                </div>
                <Show
                    when=move || state.get().layout().is_desktop()
                    fallback=move || view! { <CoinCards transport=transport state=state /> }
                >
                    <CoinTable transport=transport state=state />
                </Show>
            </section>
        </WalletChrome>
    }
}

#[component]
fn CoinTable(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <table class="coin-table">
            <thead>
                <tr>
                    <th>"Outpoint"</th>
                    <th>"Amount"</th>
                    <th>"Status"</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <For
                    each=move || coins_snapshot(state)
                    key=|coin: &Coin| coin.outpoint()
                    let:coin
                >
                    <CoinRow transport=transport state=state coin=coin desktop=true />
                </For>
            </tbody>
        </table>
    }
}

#[component]
fn CoinCards(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <div class="coin-list-mobile">
            <For
                each=move || coins_snapshot(state)
                key=|coin: &Coin| coin.outpoint()
                let:coin
            >
                <CoinRow transport=transport state=state coin=coin desktop=false />
            </For>
        </div>
    }
}

#[component]
fn CoinRow(
    transport: UiTransport,
    state: RwSignal<AppState>,
    coin: Coin,
    desktop: bool,
) -> impl IntoView {
    let outpoint = coin.outpoint();
    let frozen = coin.is_reserved();
    let status = match coin.freeze() {
        None => "Spendable".to_string(),
        Some(FreezeReason::User) => "Frozen".into(),
        Some(FreezeReason::FlipstarterPledge) => "Flipstarter pledge".into(),
        Some(FreezeReason::Authhead) => "Authhead".into(),
    };
    let label = coin.label().unwrap_or("").to_owned();
    let has_label = !label.is_empty();
    let amount = format_bch(coin.value_sats());
    let out_text = outpoint.to_string();
    let freeze_or_unfreeze = move |_| {
        if frozen {
            dispatch_action(transport, state, AppAction::UnfreezeCoin(outpoint));
        } else {
            dispatch_action(transport, state, AppAction::FreezeCoin(outpoint));
        }
    };

    if desktop {
        view! {
            <tr>
                <td class="mono">{out_text}</td>
                <td>{amount}</td>
                <td>{status}</td>
                <td>
                    <button class="secondary" type="button" on:click=freeze_or_unfreeze>
                        {if frozen { "Unfreeze" } else { "Freeze" }}
                    </button>
                </td>
            </tr>
        }
        .into_any()
    } else {
        view! {
            <article class="source-row stacked">
                <div>
                    <p class="source-title">{amount}</p>
                    <p class="muted">{status}</p>
                    <p class="mono">{out_text}</p>
                    <Show when=move || has_label>
                        <p class="muted">{label.clone()}</p>
                    </Show>
                </div>
                <button class="secondary" type="button" on:click=freeze_or_unfreeze>
                    {if frozen { "Unfreeze" } else { "Freeze" }}
                </button>
            </article>
        }
        .into_any()
    }
}

#[component]
pub fn ActionsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let advanced = RwSignal::new(false);
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"Actions"</h1>
                <p class="lede">"Everyday BCH tasks, with power tools when you need them."</p>

                <section class="panel">
                    <h2>"Basic actions"</h2>
                    <div class="basic-grid">
                        <div class="quick-tile static"><span>"↗"</span>"Send"<small>"BCH or CashTokens"</small></div>
                        <div class="quick-tile static"><span>"↙"</span>"Receive"<small>"BCH or CashTokens"</small></div>
                        <div class="quick-tile static"><span>"⇄"</span>"Swap"<small>"Via Cauldron"</small></div>
                        <div class="quick-tile static"><span>"▢"</span>"Scan QR"<small>"Universal scanner"</small></div>
                        <div class="quick-tile static"><span>"▢"</span>"Buy BCH"<small>"Choose provider"</small></div>
                        <div class="quick-tile static"><span>"▢"</span>"Connect"<small>"Review a request"</small></div>
                    </div>
                </section>

                <section class="panel">
                    <button
                        class="advanced-toggle"
                        type="button"
                        on:click=move |_| advanced.update(|open| *open = !*open)
                    >
                        <div>
                            <h2>"Advanced"</h2>
                            <p class="muted">"Transaction tools, Flipstarter, and more"</p>
                        </div>
                        <span>{move || if advanced.get() { "⌃" } else { "⌄" }}</span>
                    </button>
                    <Show when=move || advanced.get()>
                        <div class="advanced-list">
                            <button
                                class="advanced-row"
                                type="button"
                                on:click=move |_| dispatch_action(
                                    transport,
                                    state,
                                    AppAction::Navigate(AppRoute::Flipstarter),
                                )
                            >
                                <div>
                                    <p class="source-title">"Flipstarter"</p>
                                    <p class="muted">"Pledge, freeze, and cancel assurance campaigns"</p>
                                </div>
                                <span>"›"</span>
                            </button>
                            <button
                                class="advanced-row"
                                type="button"
                                on:click=move |_| dispatch_action(
                                    transport,
                                    state,
                                    AppAction::Navigate(AppRoute::Coins),
                                )
                            >
                                <div>
                                    <p class="source-title">"Coin control"</p>
                                    <p class="muted">"Freeze, label, and spend a specific coin"</p>
                                </div>
                                <span>"›"</span>
                            </button>
                            <div class="advanced-row muted-row">
                                <div>
                                    <p class="source-title">"Transaction Builder"</p>
                                    <p class="muted">"Build and review custom transactions"</p>
                                </div>
                            </div>
                        </div>
                    </Show>
                </section>

                <p class="hint-card">
                    "Default flows stay simple. Advanced controls never appear inside normal Send or Receive unless you open them."
                </p>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn ExplorePage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"Explore"</h1>
                <p class="lede">"Connectors, privacy, chat, and add-ons."</p>
                <div class=move || {
                    if state.get().layout().is_desktop() {
                        "explore-grid"
                    } else {
                        "explore-stack"
                    }
                }>
                    <button
                        class="explore-card"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::Navigate(AppRoute::Flipstarter),
                        )
                    >
                        <p class="eyebrow">"Crowdfunding"</p>
                        <h2>"Flipstarter"</h2>
                        <p class="muted">
                            "Public assurance campaigns, including self-hosted sites. Pledge holds a coin with the same freeze as Assets."
                        </p>
                    </button>
                    <button
                        class="explore-card"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::Navigate(AppRoute::FundMe),
                        )
                    >
                        <p class="eyebrow">"CashStarter"</p>
                        <h2>"FundMe"</h2>
                        <p class="muted">
                            "OPTN CashStarter campaigns. A separate product from Flipstarter. Contracts still need work."
                        </p>
                    </button>
                </div>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn SettingsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"Network"</h1>
                <p class="lede">"Select your active Bitcoin Cash network."</p>
                <article class="panel">
                    <p class="muted">"Current network"</p>
                    <p class="source-title">
                        {move || network_label(state.get().network)}
                    </p>
                    <p class="muted">
                        {move || match state.get().network {
                            Network::Mainnet => "Real BCH network",
                            Network::Chipnet => "BCH testing network",
                        }}
                    </p>
                </article>
                <h2>"Choose network"</h2>
                <button
                    class="network-choice"
                    class:active=move || state.get().network == Network::Mainnet
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::SetNetwork(Network::Mainnet),
                    )
                >
                    <div>
                        <p class="source-title">"Mainnet"</p>
                        <p class="muted">"Real BCH network"</p>
                    </div>
                    <Show when=move || state.get().network == Network::Mainnet>
                        <span class="ok">"Active"</span>
                    </Show>
                </button>
                <button
                    class="network-choice"
                    class:active=move || state.get().network == Network::Chipnet
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::SetNetwork(Network::Chipnet),
                    )
                >
                    <div>
                        <p class="source-title">"Chipnet"</p>
                        <p class="muted">"BCH testing network"</p>
                    </div>
                    <Show when=move || state.get().network == Network::Chipnet>
                        <span class="ok">"Active"</span>
                    </Show>
                </button>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn FlipstarterPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let blob = RwSignal::new(String::new());
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <button
                    class="text-link back"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::Navigate(AppRoute::Actions),
                    )
                >
                    "‹ Actions"
                </button>
                <h1>"Flipstarter"</h1>
                <p class="lede">
                    "Paste campaign details from a Flipstarter site. The wallet freezes an exact-amount coin. This is not FundMe."
                </p>
                <div class=move || {
                    if state.get().layout().is_desktop() {
                        "two-pane"
                    } else {
                        "one-pane"
                    }
                }>
                    <form
                        class="panel form"
                        on:submit=move |event| {
                            event.prevent_default();
                            dispatch_action(
                                transport,
                                state,
                                AppAction::PrepareFlipstarterPledge {
                                    blob: blob.get_untracked(),
                                    now_unix: None,
                                },
                            );
                        }
                    >
                        <label class="field">
                            <span>"Campaign details"</span>
                            <textarea
                                rows="8"
                                spellcheck="false"
                                autocomplete="off"
                                placeholder="Paste Flipstarter COPY DETAILS"
                                prop:value=move || blob.get()
                                on:input=move |event| blob.set(event_target_value(&event))
                            ></textarea>
                        </label>
                        <div class="toolbar">
                            <button class="primary" type="submit">"Prepare pledge"</button>
                            <button
                                class="secondary"
                                type="button"
                                on:click=move |_| {
                                    blob.set(sample_chipnet_campaign_blob(4_000));
                                    dispatch_action(
                                        transport,
                                        state,
                                        AppAction::SetNetwork(Network::Chipnet),
                                    );
                                }
                            >
                                "Fill Chipnet sample"
                            </button>
                        </div>
                        <p class="muted">
                            {move || format!(
                                "Pledge sighash 0x{:02X}. Spendable {}.",
                                flipstarter_view_model(&state.get()).sighash,
                                format_bch(flipstarter_view_model(&state.get()).spendable_sats)
                            )}
                        </p>
                    </form>
                    <section class="panel">
                        <h2>"Pledges"</h2>
                        <Show
                            when=move || !state.get().pledges.is_empty()
                            fallback=move || view! { <p class="muted">"No Flipstarter pledges yet."</p> }
                        >
                            <ul class="pledge-list">
                                <For
                                    each=move || state.get().pledges.clone()
                                    key=|pledge| pledge.id
                                    let:pledge
                                >
                                    <li class="source-row stacked">
                                        <div>
                                            <p class="source-title">
                                                {format!(
                                                    "{} sats · {}",
                                                    pledge.amount_sats,
                                                    pledge.alias.clone().unwrap_or_else(|| "anonymous".into())
                                                )}
                                            </p>
                                            <p class="mono">{pledge.outpoint.to_string()}</p>
                                            <p class="muted">
                                                {match pledge.status {
                                                    PledgeStatus::Frozen => "Frozen. Cancel spends this coin to yourself.".to_string(),
                                                    PledgeStatus::Cancelled { spend_to_self: true } => {
                                                        "Cancelled. Spend this coin to yourself.".into()
                                                    }
                                                    PledgeStatus::Cancelled { .. } => "Cancelled.".into(),
                                                }}
                                            </p>
                                        </div>
                                        <Show when=move || matches!(pledge.status, PledgeStatus::Frozen)>
                                            <button
                                                class="secondary"
                                                type="button"
                                                on:click=move |_| dispatch_action(
                                                    transport,
                                                    state,
                                                    AppAction::CancelFlipstarterPledge(pledge.id),
                                                )
                                            >
                                                "Cancel pledge"
                                            </button>
                                        </Show>
                                    </li>
                                </For>
                            </ul>
                        </Show>
                    </section>
                </div>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn FundMePage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <button
                    class="text-link back"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::Navigate(AppRoute::Explore),
                    )
                >
                    "‹ Explore"
                </button>
                <h1>"FundMe"</h1>
                {move || {
                    let vm = fundme_view_model(&state.get());
                    view! {
                        <p class="lede">
                            {format!(
                                "{} is {} — product id {}. It is not Flipstarter.",
                                vm.product.name,
                                vm.product.host,
                                vm.product.id
                            )}
                        </p>
                        <article class="hint-card">{vm.product.status.reason()}</article>
                    }
                }}
            </section>
        </WalletChrome>
    }
}
