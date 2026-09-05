from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one current-source match, found {count}")
    return text.replace(old, new, 1)


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise SystemExit(f"{label}: required result missing: {needle!r}")


# ---------------------------------------------------------------------------
# optn-app: one app-owned fee preference, resolved before provider routing.
# ---------------------------------------------------------------------------
app_path = Path("crates/optn-app/src/lib.rs")
app = app_path.read_text()

app = replace_once(
    app,
    "pub use optn_core::fee::{FeeRate, RELAY_MINIMUM_FEE_RATE};",
    "pub use optn_core::fee::{\n    FeeMode, FeePreferences, FeeRate, DEFAULT_CUSTOM_FEE_RATE, RELAY_MINIMUM_FEE_RATE,\n};",
    "fee exports",
)

app = replace_once(
    app,
    "    /// Per-network server overrides. Absent means the network default.\n    pub servers: ServerOverrides,\n    /// Whether Settings is currently showing the identifying wallet fields.",
    "    /// Per-network server overrides. Absent means the network default.\n    pub servers: ServerOverrides,\n    /// App-wide transaction fee policy. Chain providers may supply advisory\n    /// observations, but changing Electrum/P2P/RPC routes never owns or mutates it.\n    pub fee_preferences: FeePreferences,\n    /// Whether Settings is currently showing the identifying wallet fields.",
    "AppState fee preference",
)

app = replace_once(
    app,
    "            hardware: HardwareSessionState::new(),\n            servers: ServerOverrides::new(),\n            identity_revealed: false,",
    "            hardware: HardwareSessionState::new(),\n            servers: ServerOverrides::new(),\n            fee_preferences: FeePreferences::app_default(),\n            identity_revealed: false,",
    "AppState fee default",
)

if "pub const fn resolved_fee_rate(&self) -> FeeRate" not in app:
    anchor = "impl Default for AppState {\n"
    if app.count(anchor) != 1:
        raise SystemExit("resolved fee method: AppState Default anchor is not unique")
    method = "impl AppState {\n    /// Final app-owned fee rate bound into a SpendPlan before any broadcast route is selected.\n    /// Auto preserves the current relay-minimum behavior until a runtime estimator supplies\n    /// an advisory rate; both modes are clamped to the BCH relay floor.\n    pub const fn resolved_fee_rate(&self) -> FeeRate {\n        self.fee_preferences\n            .resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE)\n    }\n}\n\n"
    app = app.replace(anchor, method + anchor, 1)

app = replace_once(
    app,
    "    /// Drop every override for the selected network.\n    UseNetworkDefaultServers,\n    PrepareSend {",
    "    /// Drop every override for the selected network.\n    UseNetworkDefaultServers,\n    /// Select Automatic or Custom without discarding the remembered custom rate.\n    SetFeeMode(FeeMode),\n    /// Update the remembered exact custom rate. Zero restores the historical\n    /// 1.1 sat/byte editor default rather than becoming a zero-fee request.\n    SetCustomFeeRate(FeeRate),\n    PrepareSend {",
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
    "            AppAction::UseNetworkDefaultServers => {\n                if self.servers.use_network_default(self.network) {\n                    Some(AppEvent::ServersChanged)\n                } else {\n                    None\n                }\n            }\n            AppAction::SetFeeMode(mode) => {\n                if self.fee_preferences.mode == mode {\n                    return None;\n                }\n                self.fee_preferences.mode = mode;\n                Some(AppEvent::FeePreferencesChanged)\n            }\n            AppAction::SetCustomFeeRate(rate) => {\n                let next = if rate.satoshis_per_kb() == 0 {\n                    DEFAULT_CUSTOM_FEE_RATE\n                } else {\n                    rate\n                };\n                if self.fee_preferences.custom_rate == next {\n                    return None;\n                }\n                self.fee_preferences.custom_rate = next;\n                Some(AppEvent::FeePreferencesChanged)\n            }\n            AppAction::SelectHardwareVendor(vendor) => {",
    "fee reducer",
)

app = replace_once(
    app,
    "                match prepare_spend_with(\n                    &self.coins,\n                    self.network,\n                    &destination,\n                    amount_sats,\n                    wallet.spending_capability(),\n                    coin,\n                ) {",
    "                let fee_rate = self.resolved_fee_rate();\n                match prepare_spend_with_fee_and_coin(\n                    &self.coins,\n                    self.network,\n                    &destination,\n                    amount_sats,\n                    wallet.spending_capability(),\n                    fee_rate,\n                    coin,\n                ) {",
    "PrepareSend fee binding",
)

app = replace_once(
    app,
    "    /// Whether this network has any user-set server.\n    pub servers_are_custom: bool,\n    /// The device session, so Settings can show every field it holds.",
    "    /// Whether this network has any user-set server.\n    pub servers_are_custom: bool,\n    /// App-owned fee preference shared by every renderer and chain route.\n    pub fee_preferences: FeePreferences,\n    /// Active relay floor used to explain and clamp the preference.\n    pub relay_minimum_fee_rate: FeeRate,\n    /// The device session, so Settings can show every field it holds.",
    "Settings fee fields",
)

app = replace_once(
    app,
    "        electrum_endpoint: state.servers.effective_electrum(state.network),\n        servers_are_custom: !state.servers.for_network(state.network).is_empty(),\n        hardware_derivation_path: {",
    "        electrum_endpoint: state.servers.effective_electrum(state.network),\n        servers_are_custom: !state.servers.for_network(state.network).is_empty(),\n        fee_preferences: state.fee_preferences,\n        relay_minimum_fee_rate: RELAY_MINIMUM_FEE_RATE,\n        hardware_derivation_path: {",
    "Settings fee values",
)

for needle, label in [
    ("pub fee_preferences: FeePreferences", "AppState fee preference"),
    ("SetFeeMode(FeeMode)", "fee action"),
    ("FeePreferencesChanged", "fee event"),
    ("prepare_spend_with_fee_and_coin(", "fee-aware spend preparation"),
    ("pub const fn resolved_fee_rate", "resolved fee rate"),
]:
    require(app, needle, label)
app_path.write_text(app)


# ---------------------------------------------------------------------------
# optn-transport: preserve the same typed policy across Tauri/WASM boundaries.
# ---------------------------------------------------------------------------
wire_path = Path("crates/optn-transport/src/lib.rs")
wire = wire_path.read_text()

wire = replace_once(
    wire,
    "    AuthScope, AutoLockMinutes, CampaignOutput, Coin, ConnectState, CreateStep, FeatureFlag,\n    FeatureFlags, FeeRate, FlipstarterPledge, FreezeReason, HardwareSessionState,\n    HardwareSetupPreview, HardwareVendor, ImportStep, LedgerLink, MultisigSetupPreview,\n    MultisigStep, Network, OpenedWallet, Outpoint, PledgeStatus, ServerKind, ServerOverrides,\n    SettingsRowId, SpendKind, SpendPlan, ThemeMode, UiSkin, WalletKind, WatchOnlyKind,\n    WatchOnlySetupPreview, RELAY_MINIMUM_FEE_RATE,\n};",
    "    AuthScope, AutoLockMinutes, CampaignOutput, Coin, ConnectState, CreateStep, FeatureFlag,\n    FeatureFlags, FeeMode, FeePreferences, FeeRate, FlipstarterPledge, FreezeReason,\n    HardwareSessionState, HardwareSetupPreview, HardwareVendor, ImportStep, LedgerLink,\n    MultisigSetupPreview, MultisigStep, Network, OpenedWallet, Outpoint, PledgeStatus, ServerKind,\n    ServerOverrides, SettingsRowId, SpendKind, SpendPlan, ThemeMode, UiSkin, WalletKind,\n    WatchOnlyKind, WatchOnlySetupPreview, DEFAULT_CUSTOM_FEE_RATE, RELAY_MINIMUM_FEE_RATE,\n};",
    "wire fee imports",
)

wire = replace_once(
    wire,
    "pub enum WireFeatureFlag {\n    CashFusion,\n    HardwareWallet,\n    WatchOnly,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum WireFreezeReason {",
    "pub enum WireFeatureFlag {\n    CashFusion,\n    HardwareWallet,\n    WatchOnly,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]\n#[serde(rename_all = \"snake_case\")]\npub enum WireFeeMode {\n    #[default]\n    Auto,\n    Custom,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum WireFreezeReason {",
    "wire fee mode",
)

wire = replace_once(
    wire,
    "    UseNetworkDefaultServers,\n    OpenMultisigWallet {",
    "    UseNetworkDefaultServers,\n    SetFeeMode(WireFeeMode),\n    SetCustomFeeRate {\n        satoshis_per_kb: u64,\n    },\n    OpenMultisigWallet {",
    "wire fee actions",
)

wire = replace_once(
    wire,
    "    #[serde(default)]\n    pub spend: Option<WireSpendPlan>,\n    #[serde(default)]\n    pub hardware: WireHardwareSession,",
    "    #[serde(default)]\n    pub spend: Option<WireSpendPlan>,\n    #[serde(default)]\n    pub fee_mode: WireFeeMode,\n    #[serde(default = \"default_custom_fee_rate_sats_per_kb\")]\n    pub custom_fee_rate_sats_per_kb: u64,\n    #[serde(default)]\n    pub hardware: WireHardwareSession,",
    "wire fee state",
)

wire = replace_once(
    wire,
    "    HardwareSessionChanged,\n    ServersChanged,\n    SpendPrepared,",
    "    HardwareSessionChanged,\n    ServersChanged,\n    FeePreferencesChanged,\n    SpendPrepared,",
    "wire fee event",
)

# Insert conversions next to the stable feature conversion anchor.
if "impl From<FeeMode> for WireFeeMode" not in wire:
    anchor = "impl From<FreezeReason> for WireFreezeReason {"
    if wire.count(anchor) != 1:
        raise SystemExit("fee mode conversion anchor is not unique")
    conversions = "impl From<FeeMode> for WireFeeMode {\n    fn from(value: FeeMode) -> Self {\n        match value {\n            FeeMode::Auto => Self::Auto,\n            FeeMode::Custom => Self::Custom,\n        }\n    }\n}\n\nimpl From<WireFeeMode> for FeeMode {\n    fn from(value: WireFeeMode) -> Self {\n        match value {\n            WireFeeMode::Auto => Self::Auto,\n            WireFeeMode::Custom => Self::Custom,\n        }\n    }\n}\n\n"
    wire = wire.replace(anchor, conversions + anchor, 1)

wire = replace_once(
    wire,
    "            AppAction::UseNetworkDefaultServers => WireActionKind::UseNetworkDefaultServers,\n            AppAction::OpenMultisigWallet(preview) => WireActionKind::OpenMultisigWallet {",
    "            AppAction::UseNetworkDefaultServers => WireActionKind::UseNetworkDefaultServers,\n            AppAction::SetFeeMode(mode) => WireActionKind::SetFeeMode(mode.into()),\n            AppAction::SetCustomFeeRate(rate) => WireActionKind::SetCustomFeeRate {\n                satoshis_per_kb: rate.satoshis_per_kb(),\n            },\n            AppAction::OpenMultisigWallet(preview) => WireActionKind::OpenMultisigWallet {",
    "app action to wire fee",
)

wire = replace_once(
    wire,
    "            WireActionKind::UseNetworkDefaultServers => Self::UseNetworkDefaultServers,\n            WireActionKind::OpenMultisigWallet {",
    "            WireActionKind::UseNetworkDefaultServers => Self::UseNetworkDefaultServers,\n            WireActionKind::SetFeeMode(mode) => Self::SetFeeMode(mode.into()),\n            WireActionKind::SetCustomFeeRate { satoshis_per_kb } => {\n                Self::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(satoshis_per_kb))\n            }\n            WireActionKind::OpenMultisigWallet {",
    "wire action to app fee",
)

wire = replace_once(
    wire,
    "            spend: value.spend.as_ref().map(WireSpendPlan::from),\n            hardware: WireHardwareSession::from(&value.hardware),",
    "            spend: value.spend.as_ref().map(WireSpendPlan::from),\n            fee_mode: value.fee_preferences.mode.into(),\n            custom_fee_rate_sats_per_kb: value.fee_preferences.custom_rate.satoshis_per_kb(),\n            hardware: WireHardwareSession::from(&value.hardware),",
    "app state to wire fee",
)

wire = replace_once(
    wire,
    "            // Overrides live host-side; a snapshot does not carry them, so a\n            // decoded state starts from the network defaults.\n            servers: ServerOverrides::new(),\n            create_step: value.create_step.into(),",
    "            // Overrides live host-side; a snapshot does not carry them, so a\n            // decoded state starts from the network defaults.\n            servers: ServerOverrides::new(),\n            fee_preferences: FeePreferences::new(\n                value.fee_mode.into(),\n                if value.custom_fee_rate_sats_per_kb == 0 {\n                    DEFAULT_CUSTOM_FEE_RATE\n                } else {\n                    FeeRate::from_satoshis_per_kb(value.custom_fee_rate_sats_per_kb)\n                },\n            ),\n            create_step: value.create_step.into(),",
    "wire state to app fee",
)

wire = replace_once(
    wire,
    "            AppEvent::HardwareSessionChanged => WireEventKind::HardwareSessionChanged,\n            AppEvent::ServersChanged => WireEventKind::ServersChanged,\n            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,",
    "            AppEvent::HardwareSessionChanged => WireEventKind::HardwareSessionChanged,\n            AppEvent::ServersChanged => WireEventKind::ServersChanged,\n            AppEvent::FeePreferencesChanged => WireEventKind::FeePreferencesChanged,\n            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,",
    "app event to wire fee",
)

wire = replace_once(
    wire,
    "            WireEventKind::HardwareSessionChanged => Self::HardwareSessionChanged,\n            WireEventKind::ServersChanged => Self::ServersChanged,\n            WireEventKind::SpendPrepared => Self::SpendPrepared,",
    "            WireEventKind::HardwareSessionChanged => Self::HardwareSessionChanged,\n            WireEventKind::ServersChanged => Self::ServersChanged,\n            WireEventKind::FeePreferencesChanged => Self::FeePreferencesChanged,\n            WireEventKind::SpendPrepared => Self::SpendPrepared,",
    "wire event to app fee",
)

if "fn default_custom_fee_rate_sats_per_kb()" not in wire:
    anchor = "fn default_true() -> bool {\n    true\n}\n"
    if wire.count(anchor) != 1:
        raise SystemExit("fee serde default anchor is not unique")
    helpers = "\nfn default_custom_fee_rate_sats_per_kb() -> u64 {\n    DEFAULT_CUSTOM_FEE_RATE.satoshis_per_kb()\n}\n"
    wire = wire.replace(anchor, anchor + helpers, 1)

for needle, label in [
    ("pub enum WireFeeMode", "wire fee mode"),
    ("SetFeeMode(WireFeeMode)", "wire fee action"),
    ("custom_fee_rate_sats_per_kb", "wire fee state"),
    ("FeePreferencesChanged", "wire fee event"),
]:
    require(wire, needle, label)
wire_path.write_text(wire)


# ---------------------------------------------------------------------------
# Leptos settings: combined chain-source wording + app-wide fee controls.
# ---------------------------------------------------------------------------
ui_path = Path("crates/optn-ui/src/settings.rs")
ui = ui_path.read_text()

ui = replace_once(
    ui,
    "    app_lock_view_model, settings_view_model, AppAction, AppState, AutoLockMinutes, FeatureFlag,\n    HardwareVendor, LedgerLink, Network, SettingsRowId, ThemeMode, UiSkin, WalletKind,\n};",
    "    app_lock_view_model, settings_view_model, AppAction, AppState, AutoLockMinutes, FeatureFlag,\n    FeeMode, FeeRate, HardwareVendor, LedgerLink, Network, SettingsRowId, ThemeMode, UiSkin,\n    WalletKind,\n};",
    "UI fee imports",
)

ui = replace_once(
    ui,
    "                SettingsRowId::Servers => view! { <NodeSection state=state /> }.into_any(),",
    "                SettingsRowId::Servers => view! {\n                    <NodeSection transport=transport state=state />\n                }.into_any(),",
    "NodeSection transport",
)

if "fn fee_rate_text(rate: FeeRate)" not in ui:
    anchor = "#[component]\nfn NodeSection(state: RwSignal<AppState>) -> impl IntoView {"
    if ui.count(anchor) != 1:
        raise SystemExit("NodeSection anchor is not unique")
    helpers = "fn fee_rate_text(rate: FeeRate) -> String {\n    let milli = rate.satoshis_per_kb();\n    let whole = milli / 1000;\n    let fraction = milli % 1000;\n    if fraction == 0 {\n        whole.to_string()\n    } else {\n        format!(\"{whole}.{fraction:03}\").trim_end_matches('0').to_owned()\n    }\n}\n\nfn parse_fee_rate_text(value: &str) -> Option<FeeRate> {\n    let value = value.trim();\n    if value.is_empty() || value.starts_with('-') {\n        return None;\n    }\n    let mut parts = value.split('.');\n    let whole = parts.next()?.parse::<u64>().ok()?;\n    let fraction = parts.next().unwrap_or(\"\");\n    if parts.next().is_some() || fraction.len() > 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {\n        return None;\n    }\n    let mut fraction_value = if fraction.is_empty() { 0 } else { fraction.parse::<u64>().ok()? };\n    for _ in fraction.len()..3 {\n        fraction_value = fraction_value.checked_mul(10)?;\n    }\n    Some(FeeRate::from_satoshis_per_kb(\n        whole.checked_mul(1000)?.checked_add(fraction_value)?,\n    ))\n}\n\n#[component]\nfn NodeSection(transport: UiTransport, state: RwSignal<AppState>) -> impl IntoView {"
    ui = ui.replace(anchor, helpers, 1)

old_tail = "        <p class=\"muted\">\n            \"This wallet uses the network's default Electrum endpoint.\"\n        </p>\n    }\n}\n"
new_tail = "        <p class=\"muted\">\n            \"Chain access is source-oriented. OPTN selects an eligible capability route per operation; BCH P2P, Electrum/Fulcrum, RPC, ZMQ, and future compatible extensions are delivery routes, not permanent capability owners.\"\n        </p>\n        <p class=\"muted\">\n            {move || {\n                let vm = settings_view_model(&state.get());\n                if vm.servers_are_custom {\n                    format!(\"Configured source routes include Electrum/Fulcrum: {}\", vm.electrum_endpoint)\n                } else {\n                    format!(\"Using the selected network's default source policy ({}).\", vm.network.label())\n                }\n            }}\n        </p>\n        <div class=\"panel-head\">\n            <h2>\"Transaction fee\"</h2>\n            <span class=\"muted\">\"App-wide\"</span>\n        </div>\n        <p class=\"muted\">\n            {move || {\n                let floor = settings_view_model(&state.get()).relay_minimum_fee_rate;\n                format!(\"Automatic follows the wallet recommendation and never goes below {} sat/byte. Custom is clamped to the same relay floor.\", fee_rate_text(floor))\n            }}\n        </p>\n        <div class=\"choice-list\" role=\"radiogroup\" aria-label=\"Transaction fee mode\">\n            <button\n                class=\"network-choice\"\n                class:active=move || settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Auto\n                on:click=move |_| dispatch_action(transport.clone(), state, AppAction::SetFeeMode(FeeMode::Auto))\n            >\n                \"Automatic\"\n            </button>\n            <button\n                class=\"network-choice\"\n                class:active=move || settings_view_model(&state.get()).fee_preferences.mode == FeeMode::Custom\n                on:click=move |_| dispatch_action(transport.clone(), state, AppAction::SetFeeMode(FeeMode::Custom))\n            >\n                \"Custom\"\n            </button>\n        </div>\n        <label class=\"field\">\n            <span>\"Custom fee (sat/byte)\"</span>\n            <input\n                type=\"text\"\n                inputmode=\"decimal\"\n                prop:value=move || fee_rate_text(settings_view_model(&state.get()).fee_preferences.custom_rate)\n                disabled=move || settings_view_model(&state.get()).fee_preferences.mode != FeeMode::Custom\n                on:change=move |ev| {\n                    if let Some(rate) = parse_fee_rate_text(&event_target_value(&ev)) {\n                        dispatch_action(transport.clone(), state, AppAction::SetCustomFeeRate(rate));\n                    }\n                }\n            />\n        </label>\n        <p class=\"muted\">\n            {move || format!(\"Resolved rate: {} sat/byte\", fee_rate_text(state.get().resolved_fee_rate()))}\n        </p>\n    }\n}\n"
ui = replace_once(ui, old_tail, new_tail, "combined source and fee panel")
require(ui, "Chain access is source-oriented", "combined source explanation")
require(ui, "AppAction::SetFeeMode", "fee UI action")
if "default Electrum endpoint" in ui:
    raise SystemExit("stale permanent-Electrum UI wording remains")
ui_path.write_text(ui)


# ---------------------------------------------------------------------------
# Existing legacy server override view: rename presentation as routes, not modes.
# ---------------------------------------------------------------------------
servers_path = Path("crates/optn-app/src/servers.rs")
servers = servers_path.read_text()
servers = servers.replace('Self::Peer => "Node (BIP37)"', 'Self::Peer => "BCH node / P2P"')
servers = servers.replace('Self::Electrum => "Fulcrum (Electrum)"', 'Self::Electrum => "Electrum / Fulcrum"')
servers = servers.replace('"host:port for a BCH P2P node with NODE_BLOOM"', '"host:port for a BCH P2P node; capabilities are probed after connection"')
servers_path.write_text(servers)

print("permanent fee/source UI integration written")
