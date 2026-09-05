from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("crates/optn-app/src/lib.rs")
app = app_path.read_text()

app = replace_once(
    app,
    "pub use optn_core::coins::{Coin, CoinSet, FreezeReason, Outpoint};\npub use optn_core::flipstarter::{",
    "pub use optn_core::coins::{Coin, CoinSet, FreezeReason, Outpoint};\n"
    "pub use optn_core::fee::{\n"
    "    FeeMode, FeePreferences, FeeRate, DEFAULT_CUSTOM_FEE_RATE, RELAY_MINIMUM_FEE_RATE,\n"
    "};\n"
    "pub use optn_core::flipstarter::{",
    "fee re-export",
)

app = replace_once(
    app,
    "pub use optn_core::spend::{\n    prepare_spend, prepare_spend_with, sign_seed_spend, SpendKind, SpendPlan, SpendingCapability,\n    SIGHASH_ALL_FORKID,\n};",
    "pub use optn_core::spend::{\n"
    "    prepare_spend, prepare_spend_with, prepare_spend_with_fee,\n"
    "    prepare_spend_with_fee_and_coin, sign_seed_spend, SpendKind, SpendPlan,\n"
    "    SpendingCapability, SIGHASH_ALL_FORKID,\n"
    "};",
    "spend re-export",
)

app = replace_once(
    app,
    "    /// Per-network server overrides. Absent means the network default.\n    pub servers: ServerOverrides,\n    /// Whether Settings is currently showing the identifying wallet fields.",
    "    /// Per-network server overrides. Absent means the network default.\n"
    "    pub servers: ServerOverrides,\n"
    "    /// App-wide transaction-fee policy. Providers may supply advisory data,\n"
    "    /// but switching Electrum/P2P/RPC routes never owns or mutates it.\n"
    "    pub fee_preferences: FeePreferences,\n"
    "    /// Whether Settings is currently showing the identifying wallet fields.",
    "AppState fee field",
)

app = replace_once(
    app,
    "            hardware: HardwareSessionState::new(),\n            servers: ServerOverrides::new(),\n            identity_revealed: false,",
    "            hardware: HardwareSessionState::new(),\n"
    "            servers: ServerOverrides::new(),\n"
    "            fee_preferences: FeePreferences::app_default(),\n"
    "            identity_revealed: false,",
    "AppState fee default",
)

app = replace_once(
    app,
    "    pub fn fundme(&self) -> FundMeProduct {\n        optn_core::fundme::product()\n    }\n\n    pub fn flow(&self) -> FlowViewModel {",
    "    pub fn fundme(&self) -> FundMeProduct {\n"
    "        optn_core::fundme::product()\n"
    "    }\n\n"
    "    /// Final app-owned rate used when a spend is prepared. Automatic keeps\n"
    "    /// the wallet's existing relay-minimum behavior until an advisory fee\n"
    "    /// estimator is connected; both modes remain clamped to the relay floor.\n"
    "    pub const fn resolved_fee_rate(&self) -> FeeRate {\n"
    "        self.fee_preferences\n"
    "            .resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE)\n"
    "    }\n\n"
    "    pub fn flow(&self) -> FlowViewModel {",
    "resolved fee method",
)

app = replace_once(
    app,
    "    /// Drop every override for the selected network.\n    UseNetworkDefaultServers,\n    PrepareSend {",
    "    /// Drop every override for the selected network.\n"
    "    UseNetworkDefaultServers,\n"
    "    /// Select Automatic or Custom without discarding the remembered custom rate.\n"
    "    SetFeeMode(FeeMode),\n"
    "    /// Update the remembered exact custom rate. Zero restores the historical\n"
    "    /// 1.1 sat/byte editor default rather than becoming a zero-fee request.\n"
    "    SetCustomFeeRate(FeeRate),\n"
    "    PrepareSend {",
    "fee actions",
)

app = replace_once(
    app,
    "    HardwareSessionChanged,\n    ServersChanged,\n    SpendPrepared,",
    "    HardwareSessionChanged,\n    ServersChanged,\n    FeePreferencesChanged,\n    SpendPrepared,",
    "fee event",
)

app = replace_once(
    app,
    "            AppAction::UseNetworkDefaultServers => {\n                if self.servers.use_network_default(self.network) {\n                    Some(AppEvent::ServersChanged)\n                } else {\n                    None\n                }\n            }\n            AppAction::SelectHardwareVendor(vendor) => {",
    "            AppAction::UseNetworkDefaultServers => {\n"
    "                if self.servers.use_network_default(self.network) {\n"
    "                    Some(AppEvent::ServersChanged)\n"
    "                } else {\n"
    "                    None\n"
    "                }\n"
    "            }\n"
    "            AppAction::SetFeeMode(mode) => {\n"
    "                if self.fee_preferences.mode == mode {\n"
    "                    return None;\n"
    "                }\n"
    "                self.fee_preferences.mode = mode;\n"
    "                Some(AppEvent::FeePreferencesChanged)\n"
    "            }\n"
    "            AppAction::SetCustomFeeRate(rate) => {\n"
    "                let next = if rate.satoshis_per_kb() == 0 {\n"
    "                    DEFAULT_CUSTOM_FEE_RATE\n"
    "                } else {\n"
    "                    rate\n"
    "                };\n"
    "                if self.fee_preferences.custom_rate == next {\n"
    "                    return None;\n"
    "                }\n"
    "                self.fee_preferences.custom_rate = next;\n"
    "                Some(AppEvent::FeePreferencesChanged)\n"
    "            }\n"
    "            AppAction::SelectHardwareVendor(vendor) => {",
    "fee reducer arms",
)

app = replace_once(
    app,
    "                match prepare_spend_with(\n                    &self.coins,\n                    self.network,\n                    &destination,\n                    amount_sats,\n                    wallet.spending_capability(),\n                    coin,\n                ) {",
    "                let fee_rate = self.resolved_fee_rate();\n"
    "                match prepare_spend_with_fee_and_coin(\n"
    "                    &self.coins,\n"
    "                    self.network,\n"
    "                    &destination,\n"
    "                    amount_sats,\n"
    "                    wallet.spending_capability(),\n"
    "                    fee_rate,\n"
    "                    coin,\n"
    "                ) {",
    "PrepareSend fee resolution",
)

app = replace_once(
    app,
    "    /// Whether this network has any user-set server.\n    pub servers_are_custom: bool,\n    /// The device session, so Settings can show every field it holds.",
    "    /// Whether this network has any user-set server.\n"
    "    pub servers_are_custom: bool,\n"
    "    /// Application-owned fee preference shown by every renderer.\n"
    "    pub fee_preferences: FeePreferences,\n"
    "    /// Active relay floor used to explain/clamp the preference.\n"
    "    pub relay_minimum_fee_rate: FeeRate,\n"
    "    /// The device session, so Settings can show every field it holds.",
    "SettingsViewModel fee fields",
)

app = replace_once(
    app,
    "        electrum_endpoint: state.servers.effective_electrum(state.network),\n        servers_are_custom: !state.servers.for_network(state.network).is_empty(),\n        hardware_derivation_path: {",
    "        electrum_endpoint: state.servers.effective_electrum(state.network),\n"
    "        servers_are_custom: !state.servers.for_network(state.network).is_empty(),\n"
    "        fee_preferences: state.fee_preferences,\n"
    "        relay_minimum_fee_rate: RELAY_MINIMUM_FEE_RATE,\n"
    "        hardware_derivation_path: {",
    "SettingsViewModel fee values",
)

needle = "    #[test]\n    fn settings_lists_chipnet_faucet_servers_rebuild_and_desktop_fusion() {"
fee_test = '''    #[test]\n    fn fee_preferences_are_app_wide_clamped_and_bound_to_prepared_spends() {\n        let mut state = AppState::for_surface(AppSurface::Desktop);\n        assert_eq!(state.fee_preferences, FeePreferences::app_default());\n        assert_eq!(state.resolved_fee_rate(), RELAY_MINIMUM_FEE_RATE);\n        assert_eq!(\n            settings_view_model(&state).fee_preferences.mode,\n            FeeMode::Auto\n        );\n\n        assert_eq!(\n            state.reduce(AppAction::SetFeeMode(FeeMode::Custom)),\n            Some(AppEvent::FeePreferencesChanged)\n        );\n        let custom = FeeRate::from_satoshis_per_kb(1700);\n        assert_eq!(\n            state.reduce(AppAction::SetCustomFeeRate(custom)),\n            Some(AppEvent::FeePreferencesChanged)\n        );\n        assert_eq!(state.resolved_fee_rate(), custom);\n\n        open_chipnet_seed(&mut state, "fees");\n        state.apply(AppAction::InsertCoin(\n            chipnet_demo_coin(20_000, 31).expect("coin"),\n        ));\n        let destination = optn_core::cashaddr::Address::from_hash(\n            Network::Chipnet.prefix(),\n            optn_core::cashaddr::AddressKind::P2pkh,\n            [0x7a; 20],\n        )\n        .encode();\n        state.apply(AppAction::PrepareSend {\n            destination,\n            amount_sats: 5_000,\n            coin: None,\n        });\n        let plan = state.spend.as_ref().expect("prepared spend");\n        assert_eq!(plan.fee_rate, custom);\n        assert_eq!(plan.fee_for_serialized_bytes(250), 425);\n\n        state.apply(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(500)));\n        assert_eq!(state.resolved_fee_rate(), RELAY_MINIMUM_FEE_RATE);\n        state.apply(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(0)));\n        assert_eq!(state.fee_preferences.custom_rate, DEFAULT_CUSTOM_FEE_RATE);\n    }\n\n'''
app = replace_once(app, needle, fee_test + needle, "fee application test")
app_path.write_text(app)

ui_path = Path("crates/optn-ui/src/settings.rs")
ui = ui_path.read_text()
ui = replace_once(
    ui,
    "    app_lock_view_model, settings_view_model, AppAction, AppState, AutoLockMinutes, FeatureFlag,\n    HardwareVendor, LedgerLink, Network, SettingsRowId, ThemeMode, UiSkin, WalletKind,\n};",
    "    app_lock_view_model, settings_view_model, AppAction, AppState, AutoLockMinutes, FeatureFlag,\n"
    "    FeeMode, FeeRate, HardwareVendor, LedgerLink, Network, SettingsRowId, ThemeMode, UiSkin,\n"
    "    WalletKind,\n"
    "};",
    "UI fee imports",
)
ui = replace_once(
    ui,
    "                SettingsRowId::Servers => view! { <NodeSection state=state /> }.into_any(),",
    "                SettingsRowId::Servers => view! {\n"
    "                    <NodeSection transport=transport state=state />\n"
    "                }.into_any(),",
    "NodeSection transport",
)
ui = replace_once(
    ui,
    "#[component]\nfn NodeSection(state: RwSignal<AppState>) -> impl IntoView {",
    "fn fee_rate_text(rate: FeeRate) -> String {\n"
    "    let milli = rate.satoshis_per_kb();\n"
    "    let whole = milli / 1000;\n"
    "    let fraction = milli % 1000;\n"
    "    if fraction == 0 {\n"
    "        whole.to_string()\n"
    "    } else {\n"
    "        format!(\"{whole}.{fraction:03}\").trim_end_matches('0').to_owned()\n"
    "    }\n"
    "}\n\n"
    "fn parse_fee_rate_text(value: &str) -> Option<FeeRate> {\n"
    "    let value = value.trim();\n"
    "    if value.is_empty() || value.starts_with('-') {\n"
    "        return None;\n"
    "    }\n"
    "    let mut parts = value.split('.');\n"
    "    let whole = parts.next()?.parse::<u64>().ok()?;\n"
    "    let fraction = parts.next().unwrap_or(\"\");\n"
    "    if parts.next().is_some() || fraction.len() > 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {\n"
    "        return None;\n"
    "    }\n"
    "    let mut fraction_value = if fraction.is_empty() { 0 } else { fraction.parse::<u64>().ok()? };\n"
    "    for _ in fraction.len()..3 {\n"
    "        fraction_value = fraction_value.checked_mul(10)?;\n"
    "    }\n"
    "    Some(FeeRate::from_satoshis_per_kb(whole.checked_mul(1000)?.checked_add(fraction_value)?))\n"
    "}\n\n"
    "#[component]\n"
    "fn NodeSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {",
    "fee UI helpers",
)
ui = replace_once(
    ui,
    "        <p class=\"muted\">\n            \"This wallet uses the network's default Electrum endpoint.\"\n        </p>\n    }\n}",
    "        <p class=\"muted\">\n"
    "            {move || {\n"
    "                let vm = settings_view_model(&state.get());\n"
    "                if vm.servers_are_custom {\n"
    "                    format!(\"Active Electrum endpoint: {}\", vm.electrum_endpoint)\n"
    "                } else {\n"
    "                    \"This wallet uses the network's default Electrum endpoint.\".to_owned()\n"
    "                }\n"
    "            }}\n"
    "        </p>\n"
    "        <div class=\"panel-head\">\n"
    "            <h2>\"Transaction fee\"</h2>\n"
    "            <span class=\"muted\">\"App-wide\"</span>\n"
    "        </div>\n"
    "        <p class=\"muted\">\n"
    "            {move || {\n"
    "                let floor = settings_view_model(&state.get()).relay_minimum_fee_rate;\n"
    "                format!(\"Automatic uses the relay minimum ({} sat/byte). Custom is never allowed below that floor.\", fee_rate_text(floor))\n"
    "            }}\n"
    "        </p>\n"
    "        <div class=\"choice-list\" role=\"radiogroup\" aria-label=\"Transaction fee mode\">\n"
    "            <button\n"
    "                class=\"network-choice\"\n"
    "                class:active=move || settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Auto\n"
    "                type=\"button\"\n"
    "                role=\"radio\"\n"
    "                aria-checked=move || if settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Auto { \"true\" } else { \"false\" }\n"
    "                on:click=move |_| dispatch_action(transport, state, AppAction::SetFeeMode(FeeMode::Auto))\n"
    "            >\n"
    "                <div><p class=\"source-title\">\"Automatic\"</p><p class=\"muted\">\"Relay minimum\"</p></div>\n"
    "            </button>\n"
    "            <button\n"
    "                class=\"network-choice\"\n"
    "                class:active=move || settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Custom\n"
    "                type=\"button\"\n"
    "                role=\"radio\"\n"
    "                aria-checked=move || if settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Custom { \"true\" } else { \"false\" }\n"
    "                on:click=move |_| dispatch_action(transport, state, AppAction::SetFeeMode(FeeMode::Custom))\n"
    "            >\n"
    "                <div><p class=\"source-title\">\"Custom\"</p><p class=\"muted\">\"Exact sat/byte rate\"</p></div>\n"
    "            </button>\n"
    "        </div>\n"
    "        <Show when=move || settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Custom>\n"
    "            <label class=\"field\">\n"
    "                <span>\"Custom fee (sat/byte)\"</span>\n"
    "                <input\n"
    "                    type=\"number\"\n"
    "                    min=\"1\"\n"
    "                    step=\"0.1\"\n"
    "                    prop:value=move || fee_rate_text(settings_view_model(&state.get()).fee_preferences.custom_rate)\n"
    "                    on:change=move |ev| {\n"
    "                        if let Some(rate) = parse_fee_rate_text(&event_target_value(&ev)) {\n"
    "                            dispatch_action(transport, state, AppAction::SetCustomFeeRate(rate));\n"
    "                        }\n"
    "                    }\n"
    "                />\n"
    "                <span class=\"muted\">\"Applies to the next transaction.\"</span>\n"
    "            </label>\n"
    "        </Show>\n"
    "    }\n"
    "}",
    "fee controls",
)
ui_path.write_text(ui)

print("fee integration patch applied")
