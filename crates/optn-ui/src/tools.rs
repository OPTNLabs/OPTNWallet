#![cfg(target_arch = "wasm32")]

use crate::{dispatch_action, qr::encode_address_qr, UiTransport};
use leptos::prelude::*;
use optn_app::{
    assets_view_model, chrome_network_label, chrome_network_pill, coins_view_model,
    flipstarter_view_model, format_bch, fundme_view_model, history_view_model, nfts_view_model,
    parse_bch, portfolio_totals, product_nav, sample_chipnet_campaign_blob, AppAction, AppRoute,
    AppState, Coin, FreezeReason, HistoryEntry, HistoryKind, Network, Outpoint, OwnedCategory,
    OwnedNft, PledgeStatus, ProductNavItem, SpendKind, WalletKind,
};
use optn_transport::TransportError;

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

fn coins_snapshot(state: RwSignal<AppState>) -> Vec<Coin> {
    state.get().coins.iter().cloned().collect()
}

fn history_snapshot(state: RwSignal<AppState>) -> Vec<HistoryEntry> {
    history_view_model(&state.get()).entries
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
                    {move || chrome_network_pill(&state.get())}
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
            each=move || product_nav(&state.get())
            key=|item| match item {
                ProductNavItem::Home => 0u8,
                ProductNavItem::Assets => 1,
                ProductNavItem::Actions => 2,
                ProductNavItem::Receive => 3,
                ProductNavItem::Explore => 4,
                ProductNavItem::History => 5,
                ProductNavItem::Settings => 6,
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
                        ProductNavItem::Receive => "↙",
                        ProductNavItem::Explore => "◎",
                        ProductNavItem::History => "☰",
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
fn WalletSyncControl(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let busy = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    view! {
        <section class="panel" aria-label="Wallet synchronization">
            <div class="panel-head">
                <h2>{move || if state.get().wallet_sync.refreshing { "Synchronizing" }
                    else if state.get().wallet_sync.history_fresh && state.get().wallet_sync.utxos_fresh { "Up to date" }
                    else if state.get().wallet_sync.confirmed_sats.is_some() { "Saved balance · refresh needed" }
                    else { "Wallet has not synchronized" }}</h2>
                <button class="chip" type="button"
                    disabled=move || busy.get() || state.get().wallet_sync.refreshing
                    on:click=move |_| {
                        if busy.get_untracked() { return; }
                        busy.set(true); error.set(None);
                        let transport = transport.get_value();
                        leptos::task::spawn_local(async move {
                            if let Err(failure) = transport.refresh_wallet().await {
                                error.try_set(Some(match failure {
                                    optn_transport::TransportError::Other(message)
                                    | optn_transport::TransportError::InvalidData(message) => message,
                                    _ => "Wallet synchronization is unavailable on this interface.".into(),
                                }));
                            }
                            if let Ok(snapshot) = transport.snapshot().await {
                                crate::apply_snapshot(state, snapshot);
                            }
                            busy.try_set(false);
                        });
                    }>"Refresh wallet"</button>
            </div>
            <p class="muted">{move || {
                let sync = state.get().wallet_sync;
                match (sync.source, sync.evidence) {
                    (Some(source), Some(evidence)) => format!("{source} · {evidence}{}",
                        sync.tip_height.map(|height| format!(" · tip {height}")).unwrap_or_default()),
                    _ if sync.refreshing => "Synchronizing this HD account through the selected source.".into(),
                    _ => "Select a chain source in Settings, then refresh this HD account.".into(),
                }
            }}</p>
            <Show when=move || state.get().wallet_sync.confirmed_sats.is_some()>
                <p class="muted">{move || {
                    let sync = state.get().wallet_sync;
                    format!("Reported confirmed: {} · pending change: {:+} sats",
                        format_bch(sync.confirmed_sats.unwrap_or_default()), sync.pending_sats)
                }}</p>
            </Show>
            <p class="muted" role="status">{move || error.get().or(state.get().wallet_sync.error).unwrap_or_default()}</p>
            <button class="text-link" type="button" on:click=move |_|
                dispatch_action(transport, state, AppAction::Navigate(AppRoute::Settings))
            >"Chain source settings ›"</button>
        </section>
    }
}

#[component]
pub fn WalletHome(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page wallet-home">
                <article class="hero-card">
                    <p class="muted">{move || {
                        state
                            .get()
                            .wallet
                            .as_ref()
                            .map(|wallet| wallet.name.clone())
                            .unwrap_or_else(|| "Wallet".into())
                    }}</p>
                    <h1 class="balance">
                        {move || {
                            let current = state.get();
                            // wallet_sync counts the HD addresses the chain sync walks;
                            // RPA coins live at one-time addresses it never visits, so
                            // they are still added rather than already included.
                            current.wallet_sync.total_sats().and_then(|total| total.checked_add(portfolio_totals(&current).stealth_sats))
                                .map(format_bch).unwrap_or_else(|| "Balance unknown".into())
                        }}
                    </h1>
                    // Shown only when there is stealth to account for, so an
                    // ordinary wallet is not told about a pool it has none of.
                    <Show when=move || portfolio_totals(&state.get()).shows_split()>
                        <p class="muted" data-testid="stealth-split">
                            {move || {
                                portfolio_totals(&state.get())
                                    .split_label()
                                    .unwrap_or_default()
                            }}
                        </p>
                    </Show>
                    <p class="mono">
                        {move || {
                            state
                                .get()
                                .wallet
                                .as_ref()
                                .map(|wallet| wallet.receive_address.clone())
                                .unwrap_or_default()
                        }}
                    </p>
                    <div class="hero-meta">
                        <span class="ok">
                            {move || {
                                let count = state.get().coins.len();
                                if count == 0 {
                                    "No observed unspent outputs".to_string()
                                } else {
                                    format!("{count} unspent outputs")
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

                <WalletSyncControl transport=transport state=state />

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
                                <p class="muted">
                                    {move || {
                                        let wallet = state.get().wallet;
                                        match wallet.as_ref().and_then(|w| w.multisig_policy.as_deref()) {
                                            Some(policy) => format!("{policy} shared wallet"),
                                            None => match wallet.as_ref().map(|w| w.kind) {
                                                Some(WalletKind::WatchOnly) => {
                                                    "Watch-only account".into()
                                                }
                                                Some(WalletKind::Hardware) => {
                                                    "Hardware wallet".into()
                                                }
                                                _ => "Standard BCH wallet".into(),
                                            },
                                        }
                                    }}
                                </p>
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
                                AppAction::Navigate(AppRoute::Send),
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
                                AppAction::Navigate(AppRoute::Receive),
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
                                AppAction::Navigate(AppRoute::History),
                            )
                        >
                            <span>"☰"</span>
                            "History"
                        </button>
                    </div>
                </section>

                <section class="panel">
                    <div class="panel-head">
                        <h2>"Recent activity"</h2>
                        <button
                            class="text-link"
                            type="button"
                            on:click=move |_| dispatch_action(
                                transport,
                                state,
                                AppAction::Navigate(AppRoute::History),
                            )
                        >
                            "History ›"
                        </button>
                    </div>
                    <Show
                        when=move || !history_snapshot(state).is_empty()
                        fallback=move || view! { <p class="empty-line">"No activity yet."</p> }
                    >
                        <ul class="history-list">
                            <For
                                each=move || history_snapshot(state)
                                key=|entry| format!("{}:{}", entry.txid, entry.amount_sats)
                                let:entry
                            >
                                <li class="source-row stacked">
                                    <p class="source-title">
                                        {match entry.kind {
                                            HistoryKind::Received => "Received",
                                            HistoryKind::Sent => "Sent",
                                            HistoryKind::Transfer => "Transfer",
                                            HistoryKind::PendingSend => "Prepared send · not broadcast",
                                        }}
                                    </p>
                                    <p class="mono">{format_bch(entry.amount_sats)}</p>
                                </li>
                            </For>
                        </ul>
                    </Show>
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
                <OwnedCategories transport=transport state=state />
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

/// What this wallet holds, before the coins that hold it.
///
/// Derived from the wallet's own synced coins. No global indexer is consulted
/// or required to answer "what do I own", which is the split #71 draws: an
/// indexer can say how much of a category exists, and only this wallet can say
/// how much of it is here.
#[component]
fn OwnedCategories(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let categories = move || assets_view_model(&state.get()).categories;
    view! {
        <Show when=move || !categories().is_empty() fallback=|| ()>
            <div class="stack">
                <div class="panel-head">
                    <h2>"Tokens"</h2>
                    <button
                        class="chip"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::Navigate(AppRoute::Nfts),
                        )
                    >
                        "My NFTs"
                    </button>
                </div>
                <For
                    each=categories
                    key=|category: &OwnedCategory| category.category_hex.clone()
                    let:category
                >
                    <article class="panel">
                        // Raw until BCMR resolution names it. Showing the
                        // category is what keeps an unresolved token visible
                        // instead of making an owned asset disappear.
                        <p class="source-title mono">{short_hex(&category.category_hex)}</p>
                        <p class="muted">
                            {format!(
                                "{} · {} coin(s){}",
                                category.amount,
                                category.coins,
                                if category.nfts > 0 {
                                    format!(" · {} NFT(s)", category.nfts)
                                } else {
                                    String::new()
                                },
                            )}
                        </p>
                        <p class="muted">{format_bch(category.sats)}</p>
                    </article>
                </For>
            </div>
        </Show>
    }
}

/// The wallet's non-fungible tokens.
#[component]
pub fn NftsPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let nfts = move || nfts_view_model(&state.get()).nfts;
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <h1>"My NFTs"</h1>
                <p class="lede">"Items this wallet holds, from its own synchronized coins."</p>
                <Show
                    when=move || !nfts().is_empty()
                    fallback=move || view! {
                        // Said plainly, because an empty screen and a screen
                        // that failed to load look identical otherwise.
                        <p class="muted">"No non-fungible tokens in this wallet."</p>
                    }
                >
                    <div class="stack">
                        <For
                            each=nfts
                            key=|nft: &OwnedNft| {
                                format!(
                                    "{}:{}:{}",
                                    nft.outpoint.txid_hex(),
                                    nft.outpoint.vout(),
                                    nft.commitment_hex,
                                )
                            }
                            let:nft
                        >
                            <article class="panel">
                                <p class="source-title mono">{short_hex(&nft.category_hex)}</p>
                                <p class="muted">
                                    {if nft.commitment_hex.is_empty() {
                                        "No commitment".to_string()
                                    } else {
                                        format!("Commitment {}", short_hex(&nft.commitment_hex))
                                    }}
                                </p>
                                <p class="muted">
                                    {format!(
                                        "{} · {}",
                                        nft.capability.label(),
                                        format_bch(nft.sats),
                                    )}
                                </p>
                            </article>
                        </For>
                    </div>
                </Show>
            </section>
        </WalletChrome>
    }
}

/// Enough of a hash to recognise, without a line of hex nobody reads.
fn short_hex(value: &str) -> String {
    if value.len() <= 16 {
        return value.to_string();
    }
    format!("{}…{}", &value[..8], &value[value.len() - 8..])
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
    let token_protected = coin.token().is_some();
    let output_protected = token_protected || coin.value_sats() == 0;
    let status = match coin.freeze() {
        None if token_protected => "CashTokens (protected)".to_string(),
        None if coin.value_sats() == 0 => "Zero-value output".to_string(),
        None => "Spendable".to_string(),
        Some(FreezeReason::User) => "Frozen".into(),
        Some(FreezeReason::FlipstarterPledge) => "Flipstarter pledge".into(),
        Some(FreezeReason::Authhead) => "Authhead".into(),
        Some(FreezeReason::FusionInFlight) => "Fusing".into(),
    };
    let label = coin.label().unwrap_or("").to_owned();
    let has_label = !label.is_empty();
    let amount = format_bch(coin.value_sats());
    // Local wallet record, never on-chain, so it is a chip rather than
    // anything presented as verifiable.
    let fusion = coin.fusion_label();
    let fused = fusion.clone().unwrap_or_default();
    let is_fused = fusion.is_some();
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
                <td>
                    {status}
                    <Show when=move || is_fused>
                        <span class="fusion-chip" data-testid="fusion-chip">
                            {fused.clone()}
                        </span>
                    </Show>
                </td>
                <td>
                    <button class="secondary" type="button" disabled=output_protected on:click=freeze_or_unfreeze>
                        {if output_protected { "Protected" } else if frozen { "Unfreeze" } else { "Freeze" }}
                    </button>
                </td>
            </tr>
        }
        .into_any()
    } else {
        view! {
            <article class="source-row stacked">
                <div>
                    <p class="source-title">
                        {amount}
                        <Show when=move || is_fused>
                            <span class="fusion-chip" data-testid="fusion-chip">
                                {fused.clone()}
                            </span>
                        </Show>
                    </p>
                    <p class="muted">{status}</p>
                    <p class="mono">{out_text}</p>
                    <Show when=move || has_label>
                        <p class="muted">{label.clone()}</p>
                    </Show>
                </div>
                <button class="secondary" type="button" disabled=output_protected on:click=freeze_or_unfreeze>
                    {if output_protected { "Protected" } else if frozen { "Unfreeze" } else { "Freeze" }}
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
pub fn HistoryPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <button
                    class="text-link back"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::GoBack,
                    )
                >
                    {move || format!("‹ {}", state.get().flow().back_label)}
                </button>
                <h1>"History"</h1>
                <p class="lede">"Transactions across this HD account, including spent outputs. Sent amounts include the change in the wallet balance, including fees."</p>
                <WalletSyncControl transport=transport state=state />
                <Show
                    when=move || !history_snapshot(state).is_empty()
                    fallback=move || view! { <p class="empty-line">{move || if state.get().wallet_sync.confirmed_sats.is_some() { "No transactions in the retained snapshot." } else { "Refresh the wallet to load transaction history." }}</p> }
                >
                    <ul class="history-list">
                        <For
                            each=move || history_snapshot(state)
                            key=|entry| format!("{}-{}-{}-{:?}", entry.txid, entry.amount_sats, entry.reserved, entry.block_height)
                            let:entry
                        >
                            <li class="source-row stacked">
                                <div>
                                    <p class="source-title">
                                        {match entry.kind {
                                            HistoryKind::Received => "Received",
                                            HistoryKind::Sent => "Sent",
                                            HistoryKind::Transfer => "Transfer",
                                            HistoryKind::PendingSend => "Prepared send · not broadcast",
                                        }}
                                        {if entry.reserved { " · reserved" } else { "" }}
                                    </p>
                                    <p class="mono">{format_bch(entry.amount_sats)}</p>
                                    <p class="mono">{entry.address.clone()}</p>
                                    <p class="muted">{entry.txid.clone()}</p>
                                    <p class="muted">{if entry.kind == HistoryKind::PendingSend { String::new() } else {
                                        entry.block_height.map(|height| format!("Reported in block {height}"))
                                            .unwrap_or_else(|| "Mempool".into())
                                    }}</p>
                                </div>
                            </li>
                        </For>
                    </ul>
                </Show>
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
                        AppAction::GoBack,
                    )
                >
                    {move || format!("‹ {}", state.get().flow().back_label)}
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
                        AppAction::GoBack,
                    )
                >
                    {move || format!("‹ {}", state.get().flow().back_label)}
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

#[component]
fn ReceiveQr(state: RwSignal<AppState>) -> impl IntoView {
    view! {
        {move || {
            let address = state
                .get()
                .wallet
                .as_ref()
                .map(|wallet| wallet.receive_address.clone())
                .unwrap_or_default();
            match encode_address_qr(&address) {
                Ok(qr) => {
                    let view_box = format!("0 0 {} {}", qr.size, qr.size);
                    view! {
                        <svg
                            class="receive-qr"
                            viewBox=view_box
                            role="img"
                            aria-label="Receive address QR code"
                        >
                            <rect width=qr.size height=qr.size fill="#ffffff"></rect>
                            <path d=qr.path fill="#002b1d"></path>
                        </svg>
                    }
                        .into_any()
                }
                Err(message) => view! {
                    <p class="receive-qr-unavailable" role="status">{message}</p>
                }
                .into_any(),
            }
        }}
    }
}

#[component]
pub fn ReceivePage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let copy_status = RwSignal::new(None::<String>);
    let status = RwSignal::new(None);
    let error = RwSignal::new(None::<String>);
    let busy = RwSignal::new(false);
    let acknowledge_gap = RwSignal::new(false);
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page receive-page">
                <button
                    class="back-button"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::GoBack,
                    )
                >
                    <span aria-hidden="true">"‹"</span>
                    <span class="sr-only">{move || state.get().flow().back_label}</span>
                </button>
                <h1>"Receive"</h1>
                <p class="lede">"Share this address on the selected network."</p>
                <article class="panel receive-card">
                    <div class="receive-tabs" role="tablist" aria-label="Receive asset">
                        <button class="receive-tab active" type="button" role="tab" aria-selected="true">
                            "BCH"
                        </button>
                        <button class="receive-tab" type="button" role="tab" disabled=true>
                            "Token"
                        </button>
                    </div>
                    <div class="receive-qr-frame">
                        <ReceiveQr state=state />
                    </div>
                    <p class="muted receive-kind">
                        {move || match state.get().wallet.as_ref().map(|wallet| wallet.kind) {
                            Some(WalletKind::WatchOnly) => "Watch-only receive address",
                            Some(WalletKind::Hardware) => "Hardware wallet receive address",
                            Some(WalletKind::Seed) => "Seed wallet receive address",
                            None => "No wallet is open",
                        }}
                    </p>
                    <p class="mono receive-address">
                        {move || {
                            state
                                .get()
                                .wallet
                                .as_ref()
                                .map(|wallet| wallet.receive_address.clone())
                                .unwrap_or_default()
                        }}
                    </p>
                    <div class="receive-actions">
                        <button
                            class="secondary"
                            type="button"
                            on:click=move |_| {
                                let text = state
                                    .get_untracked()
                                    .wallet
                                    .as_ref()
                                    .map(|wallet| wallet.receive_address.clone())
                                    .unwrap_or_default();
                                if text.is_empty() {
                                    copy_status.set(Some("No receive address is available.".into()));
                                    return;
                                }
                                copy_status.set(None);
                                let clipboard = transport.get_value();
                                leptos::task::spawn_local(async move {
                                    let status = match clipboard.write_clipboard(text).await {
                                        Ok(()) => "Address copied.".to_string(),
                                        Err(TransportError::Unsupported) => {
                                            "This host does not offer a clipboard.".to_string()
                                        }
                                        Err(_) => "Could not copy the address.".to_string(),
                                    };
                                    copy_status.set(Some(status));
                                });
                            }
                        >
                            "Copy"
                        </button>
                        <button class="secondary" type="button" disabled=true>
                            "Share"
                        </button>
                        <button class="secondary" type="button"
                            disabled=move || busy.get() || state.get().hd_addresses.is_none()
                            on:click=move |_| {
                                copy_status.set(None);
                                crate::security::submit(transport, state,
                                    optn_transport::WalletSecurityRequest::NextReceive {
                                        epoch: state.get_untracked().lock.unlock_epoch,
                                        acknowledge_gap: acknowledge_gap.get_untracked(),
                                    }, status, error, busy);
                                acknowledge_gap.set(false);
                            }>
                            {move || if busy.get() { "Saving address…" } else { "New address" }}
                        </button>
                    </div>
                    <Show when=move || error.get().is_some()>
                        <p role="alert">{move || error.get().unwrap_or_default()}</p>
                    </Show>
                    <Show when=move || error.get().is_some_and(|message| message.contains("BIP44 recovery gap"))>
                        <label class="field">
                            <input type="checkbox" prop:checked=move || acknowledge_gap.get()
                                on:change=move |event| acknowledge_gap.set(event_target_checked(&event)) />
                            "I understand recovery may require scanning beyond 20 unused addresses."
                        </label>
                    </Show>
                    <Show when=move || copy_status.get().is_some()>
                        <p class="receive-copy-status" role="status">
                            {move || copy_status.get().unwrap_or_default()}
                        </p>
                    </Show>
                    <p class="receive-note">
                        {move || format!("Only send {} funds to this address.", chrome_network_label(state.get().network))}
                    </p>
                </article>
            </section>
        </WalletChrome>
    }
}

#[component]
pub fn SendPage(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {
    let destination = RwSignal::new(String::new());
    let chosen_coin = RwSignal::new(None::<Outpoint>);
    let amount = RwSignal::new(String::new());
    // Shown under the field when the amount will not parse, so a bad entry
    // says so instead of silently preparing a send of zero.
    let amount_error = RwSignal::new(None::<String>);
    view! {
        <WalletChrome transport=transport state=state>
            <section class="page">
                <button
                    class="text-link back"
                    type="button"
                    on:click=move |_| dispatch_action(
                        transport,
                        state,
                        AppAction::GoBack,
                    )
                >
                    {move || format!("‹ {}", state.get().flow().back_label)}
                </button>
                <h1>"Send"</h1>
                <p class="lede">
                    {move || match state.get().wallet.as_ref().map(|wallet| wallet.kind) {
                        Some(WalletKind::WatchOnly) => {
                            "Watch-only prepares an unsigned PSBT (SIGHASH_ALL|FORKID)."
                        }
                        _ => "Spendable coins only. Frozen coins are not selected.",
                    }}
                </p>
                <label class="field">
                    <span>"Destination"</span>
                    <input
                        type="text"
                        spellcheck="false"
                        prop:value=move || destination.get()
                        on:input=move |event| destination.set(event_target_value(&event))
                    />
                </label>
                <label class="field">
                    <span>"Amount (BCH)"</span>
                    <input
                        type="text"
                        inputmode="decimal"
                        placeholder="0.00000000"
                        aria-describedby="send-amount-error"
                        prop:value=move || amount.get()
                        on:input=move |event| {
                            amount.set(event_target_value(&event));
                            amount_error.set(None);
                        }
                    />
                </label>
                <Show when=move || amount_error.get().is_some()>
                    <p id="send-amount-error" role="alert" class="field-error">
                        {move || amount_error.get().unwrap_or_default()}
                    </p>
                </Show>
                <section class="coin-control" data-testid="coin-control">
                    <div class="panel-head">
                        <span class="field-label">"Coin control"</span>
                        <span class="muted">
                            {move || match chosen_coin.get() {
                                Some(_) => "one coin",
                                None => "any coin",
                            }}
                        </span>
                    </div>
                    <p class="muted">
                        "Spend one specific coin instead of letting the wallet choose.                          Frozen coins are never selected."
                    </p>
                    <div class="choice-list" role="radiogroup" aria-label="Coin to spend">
                        <button
                            class="network-choice"
                            class:active=move || chosen_coin.get().is_none()
                            type="button"
                            role="radio"
                            aria-checked=move || {
                                if chosen_coin.get().is_none() { "true" } else { "false" }
                            }
                            data-testid="coin-any"
                            on:click=move |_| chosen_coin.set(None)
                        >
                            <div><p class="source-title">"Any coin"</p></div>
                        </button>
                        {move || {
                            coins_view_model(&state.get())
                                .coins
                                .into_iter()
                                .filter(|coin| !coin.is_reserved())
                                .map(|coin| {
                                    let outpoint = coin.outpoint();
                                    let label = coin.label().unwrap_or("").to_owned();
                                    let amount = format_bch(coin.value_sats());
                                    view! {
                                        <button
                                            class="network-choice"
                                            class:active=move || chosen_coin.get() == Some(outpoint)
                                            type="button"
                                            role="radio"
                                            aria-checked=move || {
                                                if chosen_coin.get() == Some(outpoint) {
                                                    "true"
                                                } else {
                                                    "false"
                                                }
                                            }
                                            data-testid=format!("coin-{}", outpoint)
                                            on:click=move |_| chosen_coin.set(Some(outpoint))
                                        >
                                            <div>
                                                <p class="source-title">{amount.clone()}</p>
                                                <p class="muted mono">{outpoint.to_string()}</p>
                                                <Show when={
                                                    let label = label.clone();
                                                    move || !label.is_empty()
                                                }>
                                                    <p class="muted">{label.clone()}</p>
                                                </Show>
                                            </div>
                                        </button>
                                    }
                                })
                                .collect_view()
                        }}
                    </div>
                </section>

                <button
                    class="primary"
                    type="button"
                    on:click=move |_| {
                        // `parse::<u64>().unwrap_or(0)` used to turn any amount
                        // it could not read into zero, so a decimal entry
                        // prepared a send of nothing with no error anywhere.
                        let parsed = match parse_bch(&amount.get_untracked()) {
                            Ok(sats) => sats,
                            Err(problem) => {
                                amount_error.set(Some(problem.to_string()));
                                return;
                            }
                        };
                        amount_error.set(None);
                        dispatch_action(
                            transport,
                            state,
                            AppAction::PrepareSend {
                                destination: destination.get_untracked(),
                                amount_sats: parsed,
                                coin: chosen_coin.get_untracked(),
                            },
                        );
                    }
                >
                    "Prepare send"
                </button>
                <Show when=move || state.get().spend.is_some()>
                    <button
                        class="primary"
                        type="button"
                        on:click=move |_| dispatch_action(
                            transport,
                            state,
                            AppAction::AuthorizeSpend { now_ms: now_ms() },
                        )
                    >
                        "Send"
                    </button>
                </Show>
                <Show when=move || state.get().spend.is_some()>
                    <article class="panel">
                        <p class="source-title">
                            {move || match state.get().spend.as_ref().map(|plan| plan.kind) {
                                Some(SpendKind::WatchOnlyUnsignedPsbt) => {
                                    "Unsigned PSBT intent"
                                }
                                Some(SpendKind::HardwareUnsignedPsbt) => {
                                    "Unsigned PSBT — confirm on your device"
                                }
                                Some(SpendKind::SeedSpecified) => "Specified spend",
                                None => "",
                            }}
                        </p>
                        <p class="mono">
                            {move || {
                                state
                                    .get()
                                    .spend
                                    .as_ref()
                                    .map(|plan| format!(
                                        "{} sats to {} · sighash 0x{:02X}",
                                        plan.amount_sats,
                                        plan.destination,
                                        plan.sighash
                                    ))
                                    .unwrap_or_default()
                            }}
                        </p>
                    </article>
                </Show>
            </section>
        </WalletChrome>
    }
}
