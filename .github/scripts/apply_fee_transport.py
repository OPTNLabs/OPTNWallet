from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("crates/optn-transport/src/lib.rs")
text = path.read_text()

text = replace_once(
    text,
    "    AuthScope, AutoLockMinutes, CampaignOutput, Coin, ConnectState, CreateStep, FeatureFlag,\n    FeatureFlags, FlipstarterPledge, FreezeReason, HardwareSessionState, HardwareSetupPreview,\n    HardwareVendor, ImportStep, LedgerLink, MultisigSetupPreview, MultisigStep, Network,\n    OpenedWallet, Outpoint, PledgeStatus, ServerKind, ServerOverrides, SettingsRowId, SpendKind,\n    SpendPlan, ThemeMode, UiSkin, WalletKind, WatchOnlyKind, WatchOnlySetupPreview,\n};",
    "    AuthScope, AutoLockMinutes, CampaignOutput, Coin, ConnectState, CreateStep, FeatureFlag,\n"
    "    FeatureFlags, FeeMode, FeePreferences, FeeRate, FlipstarterPledge, FreezeReason,\n"
    "    HardwareSessionState, HardwareSetupPreview, HardwareVendor, ImportStep, LedgerLink,\n"
    "    MultisigSetupPreview, MultisigStep, Network, OpenedWallet, Outpoint, PledgeStatus,\n"
    "    ServerKind, ServerOverrides, SettingsRowId, SpendKind, SpendPlan, ThemeMode, UiSkin,\n"
    "    WalletKind, WatchOnlyKind, WatchOnlySetupPreview, DEFAULT_CUSTOM_FEE_RATE,\n"
    "    RELAY_MINIMUM_FEE_RATE,\n"
    "};",
    "fee transport imports",
)

text = replace_once(
    text,
    "pub enum WireFeatureFlag {\n    CashFusion,\n    HardwareWallet,\n    WatchOnly,\n}\n\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum WireFreezeReason {",
    "pub enum WireFeatureFlag {\n"
    "    CashFusion,\n"
    "    HardwareWallet,\n"
    "    WatchOnly,\n"
    "}\n\n"
    "#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]\n"
    "#[serde(rename_all = \"snake_case\")]\n"
    "pub enum WireFeeMode {\n"
    "    #[default]\n"
    "    Auto,\n"
    "    Custom,\n"
    "}\n\n"
    "#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n"
    "#[serde(rename_all = \"snake_case\")]\n"
    "pub enum WireFreezeReason {",
    "wire fee mode",
)

text = replace_once(
    text,
    "    UseNetworkDefaultServers,\n    OpenMultisigWallet {",
    "    UseNetworkDefaultServers,\n"
    "    SetFeeMode(WireFeeMode),\n"
    "    SetCustomFeeRate {\n"
    "        satoshis_per_kb: u64,\n"
    "    },\n"
    "    OpenMultisigWallet {",
    "wire fee actions",
)

text = replace_once(
    text,
    "    #[serde(default)]\n    pub spend: Option<WireSpendPlan>,\n    #[serde(default)]\n    pub hardware: WireHardwareSession,",
    "    #[serde(default)]\n"
    "    pub spend: Option<WireSpendPlan>,\n"
    "    #[serde(default)]\n"
    "    pub fee_mode: WireFeeMode,\n"
    "    #[serde(default = \"default_custom_fee_rate_sats_per_kb\")]\n"
    "    pub custom_fee_rate_sats_per_kb: u64,\n"
    "    #[serde(default)]\n"
    "    pub hardware: WireHardwareSession,",
    "wire state fee fields",
)

text = replace_once(
    text,
    "pub struct WireSpendPlan {\n    pub txid: String,\n    pub vout: u32,\n    pub amount_sats: u64,\n    pub destination: String,\n    pub sighash: u8,\n    pub kind: WireSpendKind,\n}",
    "pub struct WireSpendPlan {\n"
    "    pub txid: String,\n"
    "    pub vout: u32,\n"
    "    pub amount_sats: u64,\n"
    "    pub destination: String,\n"
    "    pub sighash: u8,\n"
    "    pub kind: WireSpendKind,\n"
    "    #[serde(default = \"default_relay_fee_rate_sats_per_kb\")]\n"
    "    pub fee_rate_sats_per_kb: u64,\n"
    "}",
    "wire spend fee field",
)

text = replace_once(
    text,
    "    HardwareSessionChanged,\n    ServersChanged,\n    SpendPrepared,",
    "    HardwareSessionChanged,\n    ServersChanged,\n    FeePreferencesChanged,\n    SpendPrepared,",
    "wire fee event",
)

text = replace_once(
    text,
    "impl From<WireFeatureFlag> for FeatureFlag {\n    fn from(value: WireFeatureFlag) -> Self {\n        match value {\n            WireFeatureFlag::CashFusion => Self::CashFusion,\n            WireFeatureFlag::HardwareWallet => Self::HardwareWallet,\n            WireFeatureFlag::WatchOnly => Self::WatchOnly,\n        }\n    }\n}\n\nimpl From<FreezeReason> for WireFreezeReason {",
    "impl From<WireFeatureFlag> for FeatureFlag {\n"
    "    fn from(value: WireFeatureFlag) -> Self {\n"
    "        match value {\n"
    "            WireFeatureFlag::CashFusion => Self::CashFusion,\n"
    "            WireFeatureFlag::HardwareWallet => Self::HardwareWallet,\n"
    "            WireFeatureFlag::WatchOnly => Self::WatchOnly,\n"
    "        }\n"
    "    }\n"
    "}\n\n"
    "impl From<FeeMode> for WireFeeMode {\n"
    "    fn from(value: FeeMode) -> Self {\n"
    "        match value {\n"
    "            FeeMode::Auto => Self::Auto,\n"
    "            FeeMode::Custom => Self::Custom,\n"
    "        }\n"
    "    }\n"
    "}\n\n"
    "impl From<WireFeeMode> for FeeMode {\n"
    "    fn from(value: WireFeeMode) -> Self {\n"
    "        match value {\n"
    "            WireFeeMode::Auto => Self::Auto,\n"
    "            WireFeeMode::Custom => Self::Custom,\n"
    "        }\n"
    "    }\n"
    "}\n\n"
    "impl From<FreezeReason> for WireFreezeReason {",
    "wire fee mode conversions",
)

text = replace_once(
    text,
    "            AppAction::UseNetworkDefaultServers => WireActionKind::UseNetworkDefaultServers,\n            AppAction::OpenMultisigWallet(preview) => WireActionKind::OpenMultisigWallet {",
    "            AppAction::UseNetworkDefaultServers => WireActionKind::UseNetworkDefaultServers,\n"
    "            AppAction::SetFeeMode(mode) => WireActionKind::SetFeeMode(mode.into()),\n"
    "            AppAction::SetCustomFeeRate(rate) => WireActionKind::SetCustomFeeRate {\n"
    "                satoshis_per_kb: rate.satoshis_per_kb(),\n"
    "            },\n"
    "            AppAction::OpenMultisigWallet(preview) => WireActionKind::OpenMultisigWallet {",
    "app action to wire fee",
)

text = replace_once(
    text,
    "            WireActionKind::UseNetworkDefaultServers => Self::UseNetworkDefaultServers,\n            WireActionKind::OpenMultisigWallet {",
    "            WireActionKind::UseNetworkDefaultServers => Self::UseNetworkDefaultServers,\n"
    "            WireActionKind::SetFeeMode(mode) => Self::SetFeeMode(mode.into()),\n"
    "            WireActionKind::SetCustomFeeRate { satoshis_per_kb } => {\n"
    "                Self::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(satoshis_per_kb))\n"
    "            }\n"
    "            WireActionKind::OpenMultisigWallet {",
    "wire action to app fee",
)

text = replace_once(
    text,
    "            spend: value.spend.as_ref().map(WireSpendPlan::from),\n            hardware: WireHardwareSession::from(&value.hardware),",
    "            spend: value.spend.as_ref().map(WireSpendPlan::from),\n"
    "            fee_mode: value.fee_preferences.mode.into(),\n"
    "            custom_fee_rate_sats_per_kb: value.fee_preferences.custom_rate.satoshis_per_kb(),\n"
    "            hardware: WireHardwareSession::from(&value.hardware),",
    "app state to wire fee",
)

text = replace_once(
    text,
    "            kind: match value.kind {\n                SpendKind::SeedSpecified => WireSpendKind::SeedSpecified,\n                SpendKind::WatchOnlyUnsignedPsbt => WireSpendKind::WatchOnlyUnsignedPsbt,\n                SpendKind::HardwareUnsignedPsbt => WireSpendKind::HardwareUnsignedPsbt,\n            },\n        }",
    "            kind: match value.kind {\n"
    "                SpendKind::SeedSpecified => WireSpendKind::SeedSpecified,\n"
    "                SpendKind::WatchOnlyUnsignedPsbt => WireSpendKind::WatchOnlyUnsignedPsbt,\n"
    "                SpendKind::HardwareUnsignedPsbt => WireSpendKind::HardwareUnsignedPsbt,\n"
    "            },\n"
    "            fee_rate_sats_per_kb: value.fee_rate.satoshis_per_kb(),\n"
    "        }",
    "spend to wire fee",
)

text = replace_once(
    text,
    "            kind: match value.kind {\n                WireSpendKind::SeedSpecified => SpendKind::SeedSpecified,\n                WireSpendKind::WatchOnlyUnsignedPsbt => SpendKind::WatchOnlyUnsignedPsbt,\n                WireSpendKind::HardwareUnsignedPsbt => SpendKind::HardwareUnsignedPsbt,\n            },\n        })",
    "            kind: match value.kind {\n"
    "                WireSpendKind::SeedSpecified => SpendKind::SeedSpecified,\n"
    "                WireSpendKind::WatchOnlyUnsignedPsbt => SpendKind::WatchOnlyUnsignedPsbt,\n"
    "                WireSpendKind::HardwareUnsignedPsbt => SpendKind::HardwareUnsignedPsbt,\n"
    "            },\n"
    "            fee_rate: FeeRate::from_satoshis_per_kb(value.fee_rate_sats_per_kb)\n"
    "                .max(RELAY_MINIMUM_FEE_RATE),\n"
    "        })",
    "wire to spend fee",
)

text = replace_once(
    text,
    "            // Overrides live host-side; a snapshot does not carry them, so a\n            // decoded state starts from the network defaults.\n            servers: ServerOverrides::new(),\n            create_step: value.create_step.into(),",
    "            // Overrides live host-side; a snapshot does not carry them, so a\n"
    "            // decoded state starts from the network defaults.\n"
    "            servers: ServerOverrides::new(),\n"
    "            fee_preferences: FeePreferences::new(\n"
    "                value.fee_mode.into(),\n"
    "                if value.custom_fee_rate_sats_per_kb == 0 {\n"
    "                    DEFAULT_CUSTOM_FEE_RATE\n"
    "                } else {\n"
    "                    FeeRate::from_satoshis_per_kb(value.custom_fee_rate_sats_per_kb)\n"
    "                },\n"
    "            ),\n"
    "            create_step: value.create_step.into(),",
    "wire state to app fee",
)

text = replace_once(
    text,
    "            AppEvent::HardwareSessionChanged => WireEventKind::HardwareSessionChanged,\n            AppEvent::ServersChanged => WireEventKind::ServersChanged,\n            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,",
    "            AppEvent::HardwareSessionChanged => WireEventKind::HardwareSessionChanged,\n"
    "            AppEvent::ServersChanged => WireEventKind::ServersChanged,\n"
    "            AppEvent::FeePreferencesChanged => WireEventKind::FeePreferencesChanged,\n"
    "            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,",
    "app event to wire fee",
)

text = replace_once(
    text,
    "            WireEventKind::HardwareSessionChanged => Self::HardwareSessionChanged,\n            WireEventKind::ServersChanged => Self::ServersChanged,\n            WireEventKind::SpendPrepared => Self::SpendPrepared,",
    "            WireEventKind::HardwareSessionChanged => Self::HardwareSessionChanged,\n"
    "            WireEventKind::ServersChanged => Self::ServersChanged,\n"
    "            WireEventKind::FeePreferencesChanged => Self::FeePreferencesChanged,\n"
    "            WireEventKind::SpendPrepared => Self::SpendPrepared,",
    "wire event to app fee",
)

text = replace_once(
    text,
    "fn default_true() -> bool {\n    true\n}\n\nfn auth_scope_id(scope: AuthScope) -> &'static str {",
    "fn default_true() -> bool {\n"
    "    true\n"
    "}\n\n"
    "fn default_custom_fee_rate_sats_per_kb() -> u64 {\n"
    "    DEFAULT_CUSTOM_FEE_RATE.satoshis_per_kb()\n"
    "}\n\n"
    "fn default_relay_fee_rate_sats_per_kb() -> u64 {\n"
    "    RELAY_MINIMUM_FEE_RATE.satoshis_per_kb()\n"
    "}\n\n"
    "fn auth_scope_id(scope: AuthScope) -> &'static str {",
    "fee serde defaults",
)

needle = "        let action = AppAction::SetFeatureEnabled {\n            flag: optn_app::FeatureFlag::HardwareWallet,\n            enabled: false,\n        };"
fee_wire_test = '''        let fee_action = AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(1700));\n        let encoded = serde_json::to_string(&WireAction::from(fee_action.clone())).unwrap();\n        let decoded: WireAction = serde_json::from_str(&encoded).unwrap();\n        assert_eq!(AppAction::try_from(decoded).unwrap(), fee_action);\n\n        let fee_event = AppEvent::FeePreferencesChanged;\n        let encoded = serde_json::to_string(&WireEvent::from(fee_event.clone())).unwrap();\n        let decoded: WireEvent = serde_json::from_str(&encoded).unwrap();\n        assert_eq!(AppEvent::try_from(decoded).unwrap(), fee_event);\n\n'''
text = replace_once(text, needle, fee_wire_test + needle, "fee transport roundtrip test")

path.write_text(text)
print("fee transport patch applied")
