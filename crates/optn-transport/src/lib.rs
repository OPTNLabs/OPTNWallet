#![forbid(unsafe_code)]

//! Transport boundary between renderers and the authoritative application.
//!
//! A renderer must not know whether actions/events cross Tauri IPC, stay
//! in-process, or run inside a WASM host. Implementations live outside this
//! crate; only these typed contracts are shared.

use optn_app::{
    parse_account_path, AppAction, AppEvent, AppLockState, AppRoute, AppState, AppSurface,
    AuthScope, AutoLockMinutes, CampaignOutput, Coin, ConnectState, CreateStep, FeatureFlag,
    FeatureFlags, FeeMode, FeePreferences, FeeRate, FlipstarterPledge, FreezeReason,
    HardwareSessionState, HardwareSetupPreview, HardwareVendor, HistoryEntry, HistoryKind,
    ImportStep, LedgerLink, MultisigSetupPreview, MultisigStep, Network, NetworkServers,
    OpenedWallet, Outpoint, PledgeStatus, ScanCoverageView, ServerKind, ServerOverrides,
    SettingsRowId, SpendKind, SpendPlan, ThemeMode, UiSkin, WalletKind, WalletSyncView,
    WatchOnlyKind, WatchOnlySetupPreview, RELAY_MINIMUM_FEE_RATE,
};
pub mod host;
pub mod security;
pub use host::{block_on_ready, run, Renderer};
pub use security::{StoredWallet, WalletSecurityRequest, WalletSecurityStatus};

use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub const WIRE_PROTOCOL_VERSION: u16 = 1;

pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, TransportError>> + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Closed,
    AuthenticationRequired,
    Unsupported,
    InvalidData(String),
    Other(String),
}

/// Renderer-facing application transport.
///
/// One event is requested at a time rather than exposing a Tokio or
/// async-stream type, keeping this crate executor and framework neutral.
pub trait AppTransport {
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()>;
    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState>;
    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>>;

    fn refresh_wallet<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    fn wallet_security<'a>(
        &'a self,
        _request: WalletSecurityRequest,
    ) -> TransportFuture<'a, WalletSecurityStatus> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    /// Rescan this wallet from `height`, inclusive.
    ///
    /// Separate from `dispatch` because a scan is work rather than a state
    /// change: the action records that the holder asked, and this performs it.
    /// Keys are untouched and the shared chain authority is untouched -- only
    /// this wallet's scan floor moves.
    ///
    /// Defaulted to `Unsupported` so a shell with no chain runtime is honest
    /// rather than silently accepting a request nothing will act on.
    fn rescan_from_height<'a>(&'a self, _height: u32) -> TransportFuture<'a, ()> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    /// Read one QR payload from the host's camera.
    ///
    /// Renderers must not reach for a camera API themselves — a Leptos build
    /// would use `getUserMedia`, a Dioxus desktop build would not, and the
    /// screen would then have to know which shell it is in. It asks the
    /// transport, and the shell supplies the scanner.
    ///
    /// One payload per call. An animated-QR export (Keystone's BC-UR) is many
    /// frames, so the caller scans repeatedly and accumulates until its
    /// decoder is satisfied.
    ///
    /// Defaulted to `Unsupported` so a shell without a camera is honest
    /// rather than failing at runtime in some other way. Whether to offer the
    /// control at all is `optn_app::transport_support(surface).camera`.
    fn scan_qr<'a>(&'a self) -> TransportFuture<'a, String> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }

    /// Write a user-visible value through the host clipboard.
    ///
    /// This stays at the transport boundary for the same reason as camera
    /// access: browser clipboard APIs are not reliable native-shell APIs, and
    /// a renderer must not select a platform fallback on its own.
    fn write_clipboard<'a>(&'a self, _text: String) -> TransportFuture<'a, ()> {
        Box::pin(async { Err(TransportError::Unsupported) })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WatchOnlyWallet,
    HardwareWallet,
    WalletHome,
    Coins,
    Nfts,
    Actions,
    Explore,
    Settings,
    History,
    Flipstarter,
    FundMe,
    Receive,
    Send,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireTheme {
    Light,
    Gray,
    Green,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireSkin {
    #[default]
    Default,
    Cyberpunk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireNetwork {
    Mainnet,
    Chipnet,
    Regtest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WireNetworkServers {
    #[serde(default)]
    pub electrum: Option<String>,
    #[serde(default)]
    pub peer: Option<String>,
    #[serde(default)]
    pub explorer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WireServerOverrides {
    #[serde(default)]
    pub mainnet: WireNetworkServers,
    #[serde(default)]
    pub chipnet: WireNetworkServers,
}

impl From<&NetworkServers> for WireNetworkServers {
    fn from(value: &NetworkServers) -> Self {
        Self {
            electrum: value.electrum.clone(),
            peer: value.peer.clone(),
            explorer: value.explorer.clone(),
        }
    }
}

impl From<&ServerOverrides> for WireServerOverrides {
    fn from(value: &ServerOverrides) -> Self {
        Self {
            mainnet: value.for_network(Network::Mainnet).into(),
            chipnet: value.for_network(Network::Chipnet).into(),
        }
    }
}

impl TryFrom<WireServerOverrides> for ServerOverrides {
    type Error = TransportError;

    fn try_from(value: WireServerOverrides) -> Result<Self, Self::Error> {
        let mut overrides = Self::new();
        restore_network_servers(&mut overrides, Network::Mainnet, value.mainnet)?;
        restore_network_servers(&mut overrides, Network::Chipnet, value.chipnet)?;
        Ok(overrides)
    }
}

fn restore_network_servers(
    overrides: &mut ServerOverrides,
    network: Network,
    values: WireNetworkServers,
) -> Result<(), TransportError> {
    for (kind, entry) in [
        (ServerKind::Electrum, values.electrum),
        (ServerKind::Peer, values.peer),
        (ServerKind::Explorer, values.explorer),
    ] {
        if let Some(entry) = entry {
            overrides.set(network, kind, &entry).map_err(|error| {
                TransportError::InvalidData(format!(
                    "invalid {} server override: {error}",
                    kind.id()
                ))
            })?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireFeeMode {
    #[default]
    Auto,
    Custom,
}

impl From<FeeMode> for WireFeeMode {
    fn from(value: FeeMode) -> Self {
        match value {
            FeeMode::Auto => Self::Auto,
            FeeMode::Custom => Self::Custom,
        }
    }
}
impl From<WireFeeMode> for FeeMode {
    fn from(value: WireFeeMode) -> Self {
        match value {
            WireFeeMode::Auto => Self::Auto,
            WireFeeMode::Custom => Self::Custom,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireSurface {
    Desktop,
    Android,
    Ios,
    Web,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFeatureFlag {
    CashFusion,
    HardwareWallet,
    WatchOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFreezeReason {
    User,
    FlipstarterPledge,
    Authhead,
    FusionInFlight,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireCoin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<optn_app::TokenData>,
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    pub address: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub freeze: Option<WireFreezeReason>,
    /// Local CashFusion round count. Never on-chain.
    #[serde(default)]
    pub fuse_depth: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireHistoryKind {
    Received,
    Sent,
    Transfer,
    PendingSend,
}

impl From<HistoryKind> for WireHistoryKind {
    fn from(value: HistoryKind) -> Self {
        match value {
            HistoryKind::Received => Self::Received,
            HistoryKind::Sent => Self::Sent,
            HistoryKind::Transfer => Self::Transfer,
            HistoryKind::PendingSend => Self::PendingSend,
        }
    }
}

impl From<WireHistoryKind> for HistoryKind {
    fn from(value: WireHistoryKind) -> Self {
        match value {
            WireHistoryKind::Received => Self::Received,
            WireHistoryKind::Sent => Self::Sent,
            WireHistoryKind::Transfer => Self::Transfer,
            WireHistoryKind::PendingSend => Self::PendingSend,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireHistoryEntry {
    pub kind: WireHistoryKind,
    pub txid: String,
    pub amount_sats: u64,
    pub address: String,
    pub reserved: bool,
    #[serde(default)]
    pub block_height: Option<u32>,
}

impl From<&HistoryEntry> for WireHistoryEntry {
    fn from(value: &HistoryEntry) -> Self {
        Self {
            kind: value.kind.into(),
            txid: value.txid.clone(),
            amount_sats: value.amount_sats,
            address: value.address.clone(),
            reserved: value.reserved,
            block_height: value.block_height,
        }
    }
}

impl From<WireHistoryEntry> for HistoryEntry {
    fn from(value: WireHistoryEntry) -> Self {
        Self {
            kind: value.kind.into(),
            txid: value.txid,
            amount_sats: value.amount_sats,
            address: value.address,
            reserved: value.reserved,
            block_height: value.block_height,
        }
    }
}

/// What a scan covers, when the wallet is knowingly short of full history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WireScanCoverage {
    pub from_height: u32,
    pub skipped_below: Option<u32>,
    pub chosen_by_holder: bool,
}

impl From<&ScanCoverageView> for WireScanCoverage {
    fn from(value: &ScanCoverageView) -> Self {
        Self {
            from_height: value.from_height,
            skipped_below: value.skipped_below,
            chosen_by_holder: value.chosen_by_holder,
        }
    }
}

impl From<WireScanCoverage> for ScanCoverageView {
    fn from(value: WireScanCoverage) -> Self {
        Self {
            from_height: value.from_height,
            skipped_below: value.skipped_below,
            chosen_by_holder: value.chosen_by_holder,
        }
    }
}

/// Missing sync metadata means stale data and an unknown balance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WireWalletSyncView {
    pub refreshing: bool,
    pub history_fresh: bool,
    pub utxos_fresh: bool,
    pub source: Option<String>,
    pub evidence: Option<String>,
    pub tip_height: Option<u32>,
    pub confirmed_sats: Option<u64>,
    pub pending_sats: i64,
    pub history: Vec<WireHistoryEntry>,
    pub error: Option<String>,
    pub scan_coverage: Option<WireScanCoverage>,
    pub rescan_requested: Option<u32>,
}

impl From<&WalletSyncView> for WireWalletSyncView {
    fn from(value: &WalletSyncView) -> Self {
        Self {
            refreshing: value.refreshing,
            history_fresh: value.history_fresh,
            utxos_fresh: value.utxos_fresh,
            source: value.source.clone(),
            evidence: value.evidence.clone(),
            tip_height: value.tip_height,
            confirmed_sats: value.confirmed_sats,
            pending_sats: value.pending_sats,
            history: value.history.iter().map(WireHistoryEntry::from).collect(),
            error: value.error.clone(),
            scan_coverage: value.scan_coverage.as_ref().map(WireScanCoverage::from),
            rescan_requested: value.rescan_requested,
        }
    }
}

impl From<WireWalletSyncView> for WalletSyncView {
    fn from(value: WireWalletSyncView) -> Self {
        Self {
            refreshing: value.refreshing,
            history_fresh: value.history_fresh,
            utxos_fresh: value.utxos_fresh,
            source: value.source,
            evidence: value.evidence,
            tip_height: value.tip_height,
            confirmed_sats: value.confirmed_sats,
            pending_sats: value.pending_sats,
            history: value.history.into_iter().map(HistoryEntry::from).collect(),
            error: value.error,
            scan_coverage: value.scan_coverage.map(ScanCoverageView::from),
            rescan_requested: value.rescan_requested,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireCampaignOutput {
    pub value_sats: u64,
    pub address: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WirePledgeStatus {
    Frozen,
    CancelledSpendToSelf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WirePledge {
    pub id: u32,
    pub txid: String,
    pub vout: u32,
    pub amount_sats: u64,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub campaign_expires: Option<u64>,
    #[serde(default)]
    pub outputs: Vec<WireCampaignOutput>,
    pub status: WirePledgeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireActionKind {
    Navigate(WireRoute),
    ToggleTheme,
    SetTheme(WireTheme),
    SetSkin(WireSkin),
    SetFeeMode(WireFeeMode),
    SetCustomFeeRate {
        satoshis_per_kb: u64,
    },
    SetNetwork(WireNetwork),
    OpenHelp,
    CloseHelp,
    SetSurface(WireSurface),
    SetFeatureEnabled {
        flag: WireFeatureFlag,
        enabled: bool,
    },
    InsertCoin(WireCoin),
    FreezeCoin {
        txid: String,
        vout: u32,
    },
    UnfreezeCoin {
        txid: String,
        vout: u32,
    },
    SetCoinLabel {
        txid: String,
        vout: u32,
        label: Option<String>,
    },
    PrepareFlipstarterPledge {
        blob: String,
        now_unix: Option<u64>,
    },
    CancelFlipstarterPledge(u32),
    ClearNotice,
    OpenCreatedWallet {
        name: String,
        receive_address: String,
        #[serde(default)]
        account_path: String,
    },
    OpenImportedWallet {
        name: String,
        receive_address: String,
        #[serde(default)]
        account_path: String,
    },
    OpenWatchOnlyWallet {
        wallet_name: String,
        #[serde(default)]
        account_xpub: String,
        master_fingerprint: Option<String>,
        account_path: String,
        receive_address: String,
        receive_token_address: String,
        change_address: String,
    },
    SelectHardwareVendor {
        #[serde(default)]
        vendor: Option<String>,
    },
    SetLedgerLink {
        bluetooth: bool,
    },
    SetHardwareDerivationPath {
        #[serde(default)]
        account_path: Option<String>,
    },
    HardwareConnected {
        label: String,
        account_xpub: String,
    },
    DisconnectHardware,
    HideWalletIdentity,
    RequestRescanFrom {
        height: u32,
    },
    SetStealthSats {
        sats: u64,
    },
    SetServer {
        kind: String,
        entry: String,
    },
    UseNetworkDefaultServers,
    ReplaceNetworkServers {
        network: WireNetwork,
        servers: WireNetworkServers,
    },
    OpenMultisigWallet {
        wallet_name: String,
        policy: String,
        required: u8,
        total: u8,
        receive_address: String,
        receive_token_address: String,
        change_address: String,
        #[serde(default)]
        cosigner_names: Vec<String>,
    },
    OpenHardwareWallet {
        vendor: String,
        wallet_name: String,
        #[serde(default)]
        account_xpub: String,
        master_fingerprint: Option<String>,
        account_path: String,
        receive_address: String,
        receive_token_address: String,
        change_address: String,
    },
    PrepareSend {
        destination: String,
        amount_sats: u64,
        #[serde(default)]
        coin_txid: Option<String>,
        #[serde(default)]
        coin_vout: Option<u32>,
    },
    RebuildWallet,
    GoBack,
    AdvanceOnboarding,
    OpenSettingsRow(String),
    SetWatchOnlyKind(String),
    SetAutoLockMinutes(u32),
    LockWallet,
    RecordActivity {
        now_ms: u64,
    },
    IdleCheck {
        now_ms: u64,
    },
    AuthorizeSpend {
        now_ms: u64,
    },
    RequestReveal {
        now_ms: u64,
    },
    AuthorizeBackground {
        now_ms: u64,
    },
    AuthorizeChat {
        now_ms: u64,
    },
    ConfirmAuth {
        now_ms: u64,
    },
    CancelAuth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireAction {
    pub version: u16,
    pub action: WireActionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireState {
    pub version: u16,
    #[serde(default)]
    pub snapshot_revision: u64,
    pub route: WireRoute,
    pub theme: WireTheme,
    #[serde(default)]
    pub skin: WireSkin,
    pub network: WireNetwork,
    #[serde(default)]
    pub servers: WireServerOverrides,
    #[serde(default)]
    pub fee_mode: WireFeeMode,
    #[serde(default = "default_custom_fee_rate_sat_per_kb")]
    pub custom_fee_satoshis_per_kb: u64,
    pub help_open: bool,
    pub surface: WireSurface,
    pub cash_fusion: bool,
    pub hardware_wallet: bool,
    #[serde(default = "default_true")]
    pub watch_only: bool,
    #[serde(default)]
    pub coins: Vec<WireCoin>,
    #[serde(default)]
    pub wallet_sync: WireWalletSyncView,
    #[serde(default)]
    pub pledges: Vec<WirePledge>,
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub wallet: Option<WireOpenedWallet>,
    #[serde(default)]
    pub hd_addresses: Option<optn_app::HdAddressAllocation>,
    #[serde(default)]
    pub spend: Option<WireSpendPlan>,
    #[serde(default)]
    pub hardware: WireHardwareSession,
    /// RPA stealth sats, kept apart from the coin list.
    #[serde(default)]
    pub stealth_sats: u64,
    #[serde(default)]
    pub create_step: WireCreateStep,
    #[serde(default)]
    pub import_step: WireImportStep,
    #[serde(default)]
    pub settings_focus: Option<String>,
    #[serde(default)]
    pub return_to: Option<WireRoute>,
    #[serde(default)]
    pub watch_only_kind: WireWatchOnlyKind,
    #[serde(default)]
    pub multisig_step: WireMultisigStep,
    #[serde(default)]
    pub auto_lock_minutes: u32,
    #[serde(default)]
    pub unlock_epoch: u64,
    #[serde(default)]
    pub last_spend_auth_ms: u64,
    #[serde(default)]
    pub last_spend_auth_epoch: u64,
    #[serde(default)]
    pub last_activity_ms: u64,
    #[serde(default)]
    pub auth_prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireWatchOnlyKind {
    #[default]
    Single,
    Shared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireMultisigStep {
    #[default]
    Policy,
    Cosigners,
    Confirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireCreateStep {
    #[default]
    Reveal,
    Confirm,
    Path,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireImportStep {
    #[default]
    Words,
    Path,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireWalletKind {
    Seed,
    WatchOnly,
    Hardware,
}

/// The device session, mirrored for renderers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WireHardwareSession {
    /// Vendor id, or absent when no device is chosen.
    #[serde(default)]
    pub vendor: Option<String>,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub device_label: Option<String>,
    #[serde(default)]
    pub account_xpub: Option<String>,
    /// The account the user chose for the device, if they chose one.
    ///
    /// Absent rather than a sentinel path: an older frame that never carried
    /// this field decodes as "not chosen", which is the same thing it meant.
    #[serde(default)]
    pub derivation_path: Option<String>,
    /// Ledger only. `false` is USB.
    #[serde(default)]
    pub ledger_bluetooth: bool,
}

impl From<&HardwareSessionState> for WireHardwareSession {
    fn from(value: &HardwareSessionState) -> Self {
        Self {
            vendor: value.vendor.map(|v| v.id().to_string()),
            connected: value.connected,
            device_label: value.device_label.clone(),
            account_xpub: value.account_xpub.clone(),
            derivation_path: value.derivation_path.map(|account| account.path()),
            ledger_bluetooth: matches!(value.ledger_link, LedgerLink::Bluetooth),
        }
    }
}

impl TryFrom<WireHardwareSession> for HardwareSessionState {
    type Error = TransportError;

    fn try_from(value: WireHardwareSession) -> Result<Self, Self::Error> {
        Ok(Self {
            vendor: match value.vendor {
                None => None,
                Some(id) => Some(HardwareVendor::from_id(&id).ok_or_else(|| {
                    TransportError::InvalidData(format!("unknown hardware vendor '{id}'"))
                })?),
            },
            connected: value.connected,
            device_label: value.device_label,
            account_xpub: value.account_xpub,
            derivation_path: value
                .derivation_path
                .map(|path| {
                    parse_account_path(&path).map_err(|error| {
                        TransportError::InvalidData(format!(
                            "hardware derivation path '{path}': {error}"
                        ))
                    })
                })
                .transpose()?,
            ledger_link: if value.ledger_bluetooth {
                LedgerLink::Bluetooth
            } else {
                LedgerLink::Usb
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOpenedWallet {
    pub kind: WireWalletKind,
    pub name: String,
    pub receive_address: String,
    #[serde(default)]
    pub master_fingerprint: Option<String>,
    /// Defaulted so a snapshot written before accounts were choosable still
    /// decodes; an empty path reads as "not recorded", not as account zero.
    #[serde(default)]
    pub account_path: String,
    #[serde(default)]
    pub multisig_policy: Option<String>,
    #[serde(default)]
    pub account_xpub: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireSpendKind {
    SeedSpecified,
    WatchOnlyUnsignedPsbt,
    HardwareUnsignedPsbt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireSpendPlan {
    pub txid: String,
    pub vout: u32,
    pub amount_sats: u64,
    pub destination: String,
    pub sighash: u8,
    pub kind: WireSpendKind,
    /// Resolved app fee rate in satoshis per 1000 serialized bytes.
    #[serde(default = "default_relay_fee_rate_sat_per_kb")]
    pub fee_rate_sat_per_kb: u64,
}

fn default_relay_fee_rate_sat_per_kb() -> u64 {
    RELAY_MINIMUM_FEE_RATE.satoshis_per_kb()
}

fn default_custom_fee_rate_sat_per_kb() -> u64 {
    optn_app::DEFAULT_CUSTOM_FEE_RATE.satoshis_per_kb()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireEventKind {
    RouteChanged(WireRoute),
    ThemeChanged(WireTheme),
    SkinChanged(WireSkin),
    FeePreferencesChanged {
        mode: WireFeeMode,
        custom_fee_satoshis_per_kb: u64,
    },
    NetworkChanged(WireNetwork),
    HelpVisibilityChanged(bool),
    SurfaceChanged(WireSurface),
    FeatureFlagChanged {
        flag: WireFeatureFlag,
        enabled: bool,
    },
    CoinsChanged,
    FlipstarterPledgesChanged,
    NoticeChanged,
    WalletOpened,
    HardwareSessionChanged,
    ServersChanged,
    SpendPrepared,
    WalletRebuilt,
    FlowChanged,
    AppLockChanged,
    AuthRequired,
    SpendAuthorized,
    WalletLocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireEvent {
    pub version: u16,
    pub event: WireEventKind,
}

impl From<AppRoute> for WireRoute {
    fn from(value: AppRoute) -> Self {
        match value {
            AppRoute::Landing => Self::Landing,
            AppRoute::CreateWallet => Self::CreateWallet,
            AppRoute::ImportWallet => Self::ImportWallet,
            AppRoute::WatchOnlyWallet => Self::WatchOnlyWallet,
            AppRoute::HardwareWallet => Self::HardwareWallet,
            AppRoute::WalletHome => Self::WalletHome,
            AppRoute::Coins => Self::Coins,
            AppRoute::Nfts => Self::Nfts,
            AppRoute::Actions => Self::Actions,
            AppRoute::Explore => Self::Explore,
            AppRoute::Settings => Self::Settings,
            AppRoute::History => Self::History,
            AppRoute::Flipstarter => Self::Flipstarter,
            AppRoute::FundMe => Self::FundMe,
            AppRoute::Receive => Self::Receive,
            AppRoute::Send => Self::Send,
        }
    }
}

impl From<WireRoute> for AppRoute {
    fn from(value: WireRoute) -> Self {
        match value {
            WireRoute::Landing => Self::Landing,
            WireRoute::CreateWallet => Self::CreateWallet,
            WireRoute::ImportWallet => Self::ImportWallet,
            WireRoute::WatchOnlyWallet => Self::WatchOnlyWallet,
            WireRoute::HardwareWallet => Self::HardwareWallet,
            WireRoute::WalletHome => Self::WalletHome,
            WireRoute::Coins => Self::Coins,
            WireRoute::Nfts => Self::Nfts,
            WireRoute::Actions => Self::Actions,
            WireRoute::Explore => Self::Explore,
            WireRoute::Settings => Self::Settings,
            WireRoute::History => Self::History,
            WireRoute::Flipstarter => Self::Flipstarter,
            WireRoute::FundMe => Self::FundMe,
            WireRoute::Receive => Self::Receive,
            WireRoute::Send => Self::Send,
        }
    }
}

impl From<ThemeMode> for WireTheme {
    fn from(value: ThemeMode) -> Self {
        match value {
            ThemeMode::Light => Self::Light,
            ThemeMode::Gray => Self::Gray,
            ThemeMode::Green => Self::Green,
            ThemeMode::Dark => Self::Dark,
        }
    }
}

impl From<WireTheme> for ThemeMode {
    fn from(value: WireTheme) -> Self {
        match value {
            WireTheme::Light => Self::Light,
            WireTheme::Gray => Self::Gray,
            WireTheme::Green => Self::Green,
            WireTheme::Dark => Self::Dark,
        }
    }
}

impl From<UiSkin> for WireSkin {
    fn from(value: UiSkin) -> Self {
        match value {
            UiSkin::Default => Self::Default,
            UiSkin::Cyberpunk => Self::Cyberpunk,
        }
    }
}

impl From<WireSkin> for UiSkin {
    fn from(value: WireSkin) -> Self {
        match value {
            WireSkin::Default => Self::Default,
            WireSkin::Cyberpunk => Self::Cyberpunk,
        }
    }
}

impl From<Network> for WireNetwork {
    fn from(value: Network) -> Self {
        match value {
            Network::Mainnet => Self::Mainnet,
            Network::Chipnet => Self::Chipnet,
            Network::Regtest => Self::Regtest,
        }
    }
}

impl From<WireNetwork> for Network {
    fn from(value: WireNetwork) -> Self {
        match value {
            WireNetwork::Mainnet => Self::Mainnet,
            WireNetwork::Chipnet => Self::Chipnet,
            WireNetwork::Regtest => Self::Regtest,
        }
    }
}

impl From<AppSurface> for WireSurface {
    fn from(value: AppSurface) -> Self {
        match value {
            AppSurface::Desktop => Self::Desktop,
            AppSurface::Android => Self::Android,
            AppSurface::Ios => Self::Ios,
            AppSurface::Web => Self::Web,
            AppSurface::Extension => Self::Extension,
        }
    }
}

impl From<WireSurface> for AppSurface {
    fn from(value: WireSurface) -> Self {
        match value {
            WireSurface::Desktop => Self::Desktop,
            WireSurface::Android => Self::Android,
            WireSurface::Ios => Self::Ios,
            WireSurface::Web => Self::Web,
            WireSurface::Extension => Self::Extension,
        }
    }
}

impl From<FeatureFlag> for WireFeatureFlag {
    fn from(value: FeatureFlag) -> Self {
        match value {
            FeatureFlag::CashFusion => Self::CashFusion,
            FeatureFlag::HardwareWallet => Self::HardwareWallet,
            FeatureFlag::WatchOnly => Self::WatchOnly,
        }
    }
}

impl From<WireFeatureFlag> for FeatureFlag {
    fn from(value: WireFeatureFlag) -> Self {
        match value {
            WireFeatureFlag::CashFusion => Self::CashFusion,
            WireFeatureFlag::HardwareWallet => Self::HardwareWallet,
            WireFeatureFlag::WatchOnly => Self::WatchOnly,
        }
    }
}

impl From<FreezeReason> for WireFreezeReason {
    fn from(value: FreezeReason) -> Self {
        match value {
            FreezeReason::User => Self::User,
            FreezeReason::FlipstarterPledge => Self::FlipstarterPledge,
            FreezeReason::Authhead => Self::Authhead,
            FreezeReason::FusionInFlight => Self::FusionInFlight,
        }
    }
}

impl From<WireFreezeReason> for FreezeReason {
    fn from(value: WireFreezeReason) -> Self {
        match value {
            WireFreezeReason::User => Self::User,
            WireFreezeReason::FlipstarterPledge => Self::FlipstarterPledge,
            WireFreezeReason::Authhead => Self::Authhead,
            WireFreezeReason::FusionInFlight => Self::FusionInFlight,
        }
    }
}

impl From<&Coin> for WireCoin {
    fn from(value: &Coin) -> Self {
        Self {
            token: value.token().cloned(),
            txid: value.outpoint().txid_hex(),
            vout: value.outpoint().vout(),
            value_sats: value.value_sats(),
            address: value.address().to_owned(),
            label: value.label().map(str::to_owned),
            freeze: value.freeze().map(WireFreezeReason::from),
            fuse_depth: value.fuse_depth(),
        }
    }
}

impl TryFrom<WireCoin> for Coin {
    type Error = TransportError;

    fn try_from(value: WireCoin) -> Result<Self, Self::Error> {
        let outpoint = Outpoint::parse(&value.txid, value.vout)
            .map_err(|error| TransportError::InvalidData(error.to_string()))?;
        let mut coin =
            Coin::from_observation(outpoint, value.value_sats, value.address, value.token)
                .map_err(|error| TransportError::InvalidData(error.to_string()))?;
        coin.set_label(value.label);
        coin.restore_freeze(value.freeze.map(FreezeReason::from));
        let coin = coin.with_fuse_depth(value.fuse_depth);
        Ok(coin)
    }
}

impl From<&FlipstarterPledge> for WirePledge {
    fn from(value: &FlipstarterPledge) -> Self {
        Self {
            id: value.id,
            txid: value.outpoint.txid_hex(),
            vout: value.outpoint.vout(),
            amount_sats: value.amount_sats,
            alias: value.alias.clone(),
            comment: value.comment.clone(),
            campaign_expires: value.campaign_expires,
            outputs: value
                .outputs
                .iter()
                .map(|output| WireCampaignOutput {
                    value_sats: output.value_sats,
                    address: output.address.clone(),
                })
                .collect(),
            status: match value.status {
                PledgeStatus::Frozen => WirePledgeStatus::Frozen,
                PledgeStatus::Cancelled { .. } => WirePledgeStatus::CancelledSpendToSelf,
            },
        }
    }
}

impl TryFrom<WirePledge> for FlipstarterPledge {
    type Error = TransportError;

    fn try_from(value: WirePledge) -> Result<Self, Self::Error> {
        Ok(Self {
            id: value.id,
            outpoint: Outpoint::parse(&value.txid, value.vout)
                .map_err(|error| TransportError::InvalidData(error.to_string()))?,
            amount_sats: value.amount_sats,
            alias: value.alias,
            comment: value.comment,
            campaign_expires: value.campaign_expires,
            outputs: value
                .outputs
                .into_iter()
                .map(|output| CampaignOutput {
                    value_sats: output.value_sats,
                    address: output.address,
                })
                .collect(),
            status: match value.status {
                WirePledgeStatus::Frozen => PledgeStatus::Frozen,
                WirePledgeStatus::CancelledSpendToSelf => PledgeStatus::Cancelled {
                    spend_to_self: true,
                },
            },
        })
    }
}

fn parse_outpoint(txid: &str, vout: u32) -> Result<Outpoint, TransportError> {
    Outpoint::parse(txid, vout).map_err(|error| TransportError::InvalidData(error.to_string()))
}

impl From<AppAction> for WireAction {
    fn from(value: AppAction) -> Self {
        let action = match value {
            AppAction::Navigate(route) => WireActionKind::Navigate(route.into()),
            AppAction::ToggleTheme => WireActionKind::ToggleTheme,
            AppAction::SetTheme(theme) => WireActionKind::SetTheme(theme.into()),
            AppAction::SetSkin(skin) => WireActionKind::SetSkin(skin.into()),
            AppAction::SetFeeMode(mode) => WireActionKind::SetFeeMode(mode.into()),
            AppAction::SetCustomFeeRate(rate) => WireActionKind::SetCustomFeeRate {
                satoshis_per_kb: rate.satoshis_per_kb(),
            },
            AppAction::SetNetwork(network) => WireActionKind::SetNetwork(network.into()),
            AppAction::OpenHelp => WireActionKind::OpenHelp,
            AppAction::CloseHelp => WireActionKind::CloseHelp,
            AppAction::SetSurface(surface) => WireActionKind::SetSurface(surface.into()),
            AppAction::SetFeatureEnabled { flag, enabled } => WireActionKind::SetFeatureEnabled {
                flag: flag.into(),
                enabled,
            },
            AppAction::InsertCoin(coin) => WireActionKind::InsertCoin(WireCoin::from(&coin)),
            AppAction::FreezeCoin(outpoint) => WireActionKind::FreezeCoin {
                txid: outpoint.txid_hex(),
                vout: outpoint.vout(),
            },
            AppAction::UnfreezeCoin(outpoint) => WireActionKind::UnfreezeCoin {
                txid: outpoint.txid_hex(),
                vout: outpoint.vout(),
            },
            AppAction::SetCoinLabel { outpoint, label } => WireActionKind::SetCoinLabel {
                txid: outpoint.txid_hex(),
                vout: outpoint.vout(),
                label,
            },
            AppAction::PrepareFlipstarterPledge { blob, now_unix } => {
                WireActionKind::PrepareFlipstarterPledge { blob, now_unix }
            }
            AppAction::CancelFlipstarterPledge(id) => WireActionKind::CancelFlipstarterPledge(id),
            AppAction::ClearNotice => WireActionKind::ClearNotice,
            AppAction::OpenCreatedWallet {
                name,
                receive_address,
                account_path,
            } => WireActionKind::OpenCreatedWallet {
                name,
                receive_address,
                account_path,
            },
            AppAction::OpenImportedWallet {
                name,
                receive_address,
                account_path,
            } => WireActionKind::OpenImportedWallet {
                name,
                receive_address,
                account_path,
            },
            AppAction::OpenWatchOnlyWallet(preview) => WireActionKind::OpenWatchOnlyWallet {
                wallet_name: preview.wallet_name,
                account_xpub: preview.account_xpub,
                master_fingerprint: preview.master_fingerprint,
                account_path: preview.account_path,
                receive_address: preview.receive_address,
                receive_token_address: preview.receive_token_address,
                change_address: preview.change_address,
            },
            AppAction::SelectHardwareVendor(vendor) => WireActionKind::SelectHardwareVendor {
                vendor: vendor.map(|v| v.id().to_string()),
            },
            AppAction::SetLedgerLink(link) => WireActionKind::SetLedgerLink {
                bluetooth: matches!(link, LedgerLink::Bluetooth),
            },
            AppAction::SetHardwareDerivationPath(account) => {
                WireActionKind::SetHardwareDerivationPath {
                    account_path: account.map(|account| account.path()),
                }
            }
            AppAction::HardwareConnected {
                label,
                account_xpub,
            } => WireActionKind::HardwareConnected {
                label,
                account_xpub,
            },
            AppAction::DisconnectHardware => WireActionKind::DisconnectHardware,
            AppAction::HideWalletIdentity => WireActionKind::HideWalletIdentity,
            AppAction::RequestRescanFrom { height } => WireActionKind::RequestRescanFrom { height },
            AppAction::SetStealthSats(sats) => WireActionKind::SetStealthSats { sats },
            AppAction::SetServer { kind, entry } => WireActionKind::SetServer {
                kind: kind.id().to_string(),
                entry,
            },
            AppAction::UseNetworkDefaultServers => WireActionKind::UseNetworkDefaultServers,
            AppAction::ReplaceNetworkServers { network, servers } => {
                WireActionKind::ReplaceNetworkServers {
                    network: network.into(),
                    servers: (&servers).into(),
                }
            }
            AppAction::OpenMultisigWallet(preview) => WireActionKind::OpenMultisigWallet {
                wallet_name: preview.wallet_name,
                policy: preview.policy,
                required: preview.required,
                total: preview.total,
                receive_address: preview.receive_address,
                receive_token_address: preview.receive_token_address,
                change_address: preview.change_address,
                cosigner_names: preview.cosigner_names,
            },
            AppAction::OpenHardwareWallet(preview) => WireActionKind::OpenHardwareWallet {
                vendor: preview.vendor.id().to_string(),
                wallet_name: preview.wallet_name,
                account_xpub: preview.account_xpub,
                master_fingerprint: preview.master_fingerprint,
                account_path: preview.account_path,
                receive_address: preview.receive_address,
                receive_token_address: preview.receive_token_address,
                change_address: preview.change_address,
            },
            AppAction::PrepareSend {
                destination,
                amount_sats,
                coin,
            } => WireActionKind::PrepareSend {
                destination,
                amount_sats,
                coin_txid: coin.map(|c| c.txid_hex()),
                coin_vout: coin.map(|c| c.vout()),
            },
            AppAction::RebuildWallet => WireActionKind::RebuildWallet,
            AppAction::GoBack => WireActionKind::GoBack,
            AppAction::AdvanceOnboarding => WireActionKind::AdvanceOnboarding,
            AppAction::OpenSettingsRow(row) => {
                WireActionKind::OpenSettingsRow(settings_row_id(row).into())
            }
            AppAction::SetWatchOnlyKind(kind) => WireActionKind::SetWatchOnlyKind(
                match kind {
                    WatchOnlyKind::Single => "single",
                    WatchOnlyKind::Shared => "shared",
                }
                .into(),
            ),
            AppAction::SetAutoLockMinutes(minutes) => WireActionKind::SetAutoLockMinutes(minutes),
            AppAction::LockWallet => WireActionKind::LockWallet,
            AppAction::RecordActivity { now_ms } => WireActionKind::RecordActivity { now_ms },
            AppAction::IdleCheck { now_ms } => WireActionKind::IdleCheck { now_ms },
            AppAction::AuthorizeSpend { now_ms } => WireActionKind::AuthorizeSpend { now_ms },
            AppAction::RequestReveal { now_ms } => WireActionKind::RequestReveal { now_ms },
            AppAction::AuthorizeBackground { now_ms } => {
                WireActionKind::AuthorizeBackground { now_ms }
            }
            AppAction::AuthorizeChat { now_ms } => WireActionKind::AuthorizeChat { now_ms },
            AppAction::ConfirmAuth { now_ms } => WireActionKind::ConfirmAuth { now_ms },
            AppAction::CancelAuth => WireActionKind::CancelAuth,
        };
        Self {
            version: WIRE_PROTOCOL_VERSION,
            action,
        }
    }
}

impl TryFrom<WireAction> for AppAction {
    type Error = TransportError;

    fn try_from(value: WireAction) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(match value.action {
            WireActionKind::Navigate(route) => Self::Navigate(route.into()),
            WireActionKind::ToggleTheme => Self::ToggleTheme,
            WireActionKind::SetTheme(theme) => Self::SetTheme(theme.into()),
            WireActionKind::SetSkin(skin) => Self::SetSkin(skin.into()),
            WireActionKind::SetFeeMode(mode) => Self::SetFeeMode(mode.into()),
            WireActionKind::SetCustomFeeRate { satoshis_per_kb } => {
                Self::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(satoshis_per_kb))
            }
            WireActionKind::SetNetwork(network) => Self::SetNetwork(network.into()),
            WireActionKind::OpenHelp => Self::OpenHelp,
            WireActionKind::CloseHelp => Self::CloseHelp,
            WireActionKind::SetSurface(surface) => Self::SetSurface(surface.into()),
            WireActionKind::SetFeatureEnabled { flag, enabled } => Self::SetFeatureEnabled {
                flag: flag.into(),
                enabled,
            },
            WireActionKind::InsertCoin(coin) => Self::InsertCoin(Coin::try_from(coin)?),
            WireActionKind::FreezeCoin { txid, vout } => {
                Self::FreezeCoin(parse_outpoint(&txid, vout)?)
            }
            WireActionKind::UnfreezeCoin { txid, vout } => {
                Self::UnfreezeCoin(parse_outpoint(&txid, vout)?)
            }
            WireActionKind::SetCoinLabel { txid, vout, label } => Self::SetCoinLabel {
                outpoint: parse_outpoint(&txid, vout)?,
                label,
            },
            WireActionKind::PrepareFlipstarterPledge { blob, now_unix } => {
                Self::PrepareFlipstarterPledge { blob, now_unix }
            }
            WireActionKind::CancelFlipstarterPledge(id) => Self::CancelFlipstarterPledge(id),
            WireActionKind::ClearNotice => Self::ClearNotice,
            WireActionKind::OpenCreatedWallet {
                name,
                receive_address,
                account_path,
            } => Self::OpenCreatedWallet {
                name,
                receive_address,
                account_path,
            },
            WireActionKind::OpenImportedWallet {
                name,
                receive_address,
                account_path,
            } => Self::OpenImportedWallet {
                name,
                receive_address,
                account_path,
            },
            WireActionKind::OpenWatchOnlyWallet {
                wallet_name,
                account_xpub,
                master_fingerprint,
                account_path,
                receive_address,
                receive_token_address,
                change_address,
            } => Self::OpenWatchOnlyWallet(WatchOnlySetupPreview {
                wallet_name,
                account_xpub,
                master_fingerprint,
                account_path,
                receive_address,
                receive_token_address,
                change_address,
            }),
            WireActionKind::SelectHardwareVendor { vendor } => Self::SelectHardwareVendor(
                // An unknown id is refused rather than decoded as some other
                // device; None genuinely means "forget the device".
                match vendor {
                    None => None,
                    Some(id) => Some(HardwareVendor::from_id(&id).ok_or_else(|| {
                        TransportError::InvalidData(format!("unknown hardware vendor '{id}'"))
                    })?),
                },
            ),
            WireActionKind::SetLedgerLink { bluetooth } => Self::SetLedgerLink(if bluetooth {
                LedgerLink::Bluetooth
            } else {
                LedgerLink::Usb
            }),
            WireActionKind::SetHardwareDerivationPath { account_path } => {
                Self::SetHardwareDerivationPath(
                    account_path
                        .map(|path| {
                            parse_account_path(&path).map_err(|error| {
                                TransportError::InvalidData(format!(
                                    "hardware derivation path '{path}': {error}"
                                ))
                            })
                        })
                        .transpose()?,
                )
            }
            WireActionKind::HardwareConnected {
                label,
                account_xpub,
            } => Self::HardwareConnected {
                label,
                account_xpub,
            },
            WireActionKind::DisconnectHardware => Self::DisconnectHardware,
            WireActionKind::HideWalletIdentity => Self::HideWalletIdentity,
            WireActionKind::RequestRescanFrom { height } => Self::RequestRescanFrom { height },
            WireActionKind::SetStealthSats { sats } => Self::SetStealthSats(sats),
            WireActionKind::SetServer { kind, entry } => Self::SetServer {
                // An unknown kind is refused rather than defaulted: writing a
                // node host into the Electrum slot would be silently wrong.
                kind: ServerKind::ALL
                    .iter()
                    .copied()
                    .find(|candidate| candidate.id() == kind)
                    .ok_or_else(|| {
                        TransportError::InvalidData(format!("unknown server kind '{kind}'"))
                    })?,
                entry,
            },
            WireActionKind::UseNetworkDefaultServers => Self::UseNetworkDefaultServers,
            WireActionKind::ReplaceNetworkServers { network, servers } => {
                let network = network.into();
                let mut validated = ServerOverrides::new();
                restore_network_servers(&mut validated, network, servers)?;
                Self::ReplaceNetworkServers {
                    network,
                    servers: validated.for_network(network).clone(),
                }
            }
            WireActionKind::OpenMultisigWallet {
                wallet_name,
                policy,
                required,
                total,
                receive_address,
                receive_token_address,
                change_address,
                cosigner_names,
            } => Self::OpenMultisigWallet(MultisigSetupPreview {
                wallet_name,
                policy,
                required,
                total,
                receive_address,
                receive_token_address,
                change_address,
                cosigner_names,
            }),
            WireActionKind::OpenHardwareWallet {
                vendor,
                wallet_name,
                account_xpub,
                master_fingerprint,
                account_path,
                receive_address,
                receive_token_address,
                change_address,
            } => Self::OpenHardwareWallet(HardwareSetupPreview {
                account_xpub,
                // An unknown vendor is refused rather than defaulted: opening
                // a spendable wallet against a device this build cannot drive
                // would strand the funds.
                vendor: HardwareVendor::from_id(&vendor).ok_or_else(|| {
                    TransportError::InvalidData(format!("unknown hardware vendor '{vendor}'"))
                })?,
                wallet_name,
                master_fingerprint,
                account_path,
                receive_address,
                receive_token_address,
                change_address,
            }),
            WireActionKind::PrepareSend {
                destination,
                amount_sats,
                coin_txid,
                coin_vout,
            } => Self::PrepareSend {
                destination,
                amount_sats,
                // Half a coin reference is a bug, not a coin: refuse rather
                // than silently falling back to automatic selection, which
                // would spend a different coin than the user picked.
                coin: match (coin_txid, coin_vout) {
                    (None, None) => None,
                    (Some(txid), Some(vout)) => Some(parse_outpoint(&txid, vout)?),
                    _ => {
                        return Err(TransportError::InvalidData(
                            "a chosen coin needs both a txid and a vout".into(),
                        ))
                    }
                },
            },
            WireActionKind::RebuildWallet => Self::RebuildWallet,
            WireActionKind::GoBack => Self::GoBack,
            WireActionKind::AdvanceOnboarding => Self::AdvanceOnboarding,
            WireActionKind::OpenSettingsRow(row) => {
                Self::OpenSettingsRow(parse_settings_row(&row)?)
            }
            WireActionKind::SetAutoLockMinutes(minutes) => Self::SetAutoLockMinutes(minutes),
            WireActionKind::LockWallet => Self::LockWallet,
            WireActionKind::RecordActivity { now_ms } => Self::RecordActivity { now_ms },
            WireActionKind::IdleCheck { now_ms } => Self::IdleCheck { now_ms },
            WireActionKind::AuthorizeSpend { now_ms } => Self::AuthorizeSpend { now_ms },
            WireActionKind::RequestReveal { now_ms } => Self::RequestReveal { now_ms },
            WireActionKind::AuthorizeBackground { now_ms } => Self::AuthorizeBackground { now_ms },
            WireActionKind::AuthorizeChat { now_ms } => Self::AuthorizeChat { now_ms },
            WireActionKind::ConfirmAuth { .. } => {
                return Err(TransportError::InvalidData(
                    "authentication approval is owned by the wallet runtime".into(),
                ));
            }
            WireActionKind::CancelAuth => Self::CancelAuth,
            WireActionKind::SetWatchOnlyKind(kind) => Self::SetWatchOnlyKind(match kind.as_str() {
                "single" => WatchOnlyKind::Single,
                "shared" => WatchOnlyKind::Shared,
                other => {
                    return Err(TransportError::InvalidData(format!(
                        "unknown watch-only kind '{other}'"
                    )))
                }
            }),
        })
    }
}

impl From<&AppState> for WireState {
    fn from(value: &AppState) -> Self {
        Self {
            version: WIRE_PROTOCOL_VERSION,
            snapshot_revision: value.snapshot_revision,
            route: value.route.into(),
            theme: value.theme.into(),
            skin: value.skin.into(),
            network: value.network.into(),
            servers: WireServerOverrides::from(&value.servers),
            fee_mode: value.fee_preferences.mode.into(),
            custom_fee_satoshis_per_kb: value.fee_preferences.custom_rate.satoshis_per_kb(),
            help_open: value.help_open,
            surface: value.surface.into(),
            cash_fusion: value
                .features
                .enabled(value.surface, FeatureFlag::CashFusion),
            hardware_wallet: value
                .features
                .enabled(value.surface, FeatureFlag::HardwareWallet),
            watch_only: value
                .features
                .enabled(value.surface, FeatureFlag::WatchOnly),
            coins: value.coins.iter().map(WireCoin::from).collect(),
            wallet_sync: WireWalletSyncView::from(&value.wallet_sync),
            pledges: value.pledges.iter().map(WirePledge::from).collect(),
            notice: value.notice.clone(),
            wallet: value.wallet.as_ref().map(WireOpenedWallet::from),
            hd_addresses: value.hd_addresses.clone(),
            spend: value.spend.as_ref().map(WireSpendPlan::from),
            hardware: WireHardwareSession::from(&value.hardware),
            stealth_sats: value.stealth_sats,
            create_step: value.create_step.into(),
            import_step: value.import_step.into(),
            settings_focus: value.settings_focus.map(settings_row_id).map(str::to_owned),
            return_to: value.return_to.map(WireRoute::from),
            watch_only_kind: value.watch_only_kind.into(),
            multisig_step: value.multisig_step.into(),
            auto_lock_minutes: value.lock.auto_lock.as_minutes(),
            unlock_epoch: value.lock.unlock_epoch,
            last_spend_auth_ms: value.lock.last_spend_auth_ms,
            last_spend_auth_epoch: value.lock.last_spend_auth_epoch,
            last_activity_ms: value.lock.last_activity_ms,
            auth_prompt: value.lock.prompt.map(auth_scope_id).map(str::to_owned),
        }
    }
}

impl From<&OpenedWallet> for WireOpenedWallet {
    fn from(value: &OpenedWallet) -> Self {
        Self {
            kind: match value.kind {
                WalletKind::Seed => WireWalletKind::Seed,
                WalletKind::WatchOnly => WireWalletKind::WatchOnly,
                WalletKind::Hardware => WireWalletKind::Hardware,
            },
            name: value.name.clone(),
            receive_address: value.receive_address.clone(),
            master_fingerprint: value.master_fingerprint.clone(),
            account_path: value.account_path.clone(),
            multisig_policy: value.multisig_policy.clone(),
            account_xpub: value.account_xpub.clone(),
        }
    }
}

impl From<WireOpenedWallet> for OpenedWallet {
    fn from(value: WireOpenedWallet) -> Self {
        Self {
            kind: match value.kind {
                WireWalletKind::Seed => WalletKind::Seed,
                WireWalletKind::WatchOnly => WalletKind::WatchOnly,
                WireWalletKind::Hardware => WalletKind::Hardware,
            },
            name: value.name,
            receive_address: value.receive_address,
            master_fingerprint: value.master_fingerprint,
            account_path: value.account_path,
            multisig_policy: value.multisig_policy,
            account_xpub: value.account_xpub,
        }
    }
}

impl From<&SpendPlan> for WireSpendPlan {
    fn from(value: &SpendPlan) -> Self {
        Self {
            txid: value.selected.txid_hex(),
            vout: value.selected.vout(),
            amount_sats: value.amount_sats,
            destination: value.destination.clone(),
            sighash: value.sighash,
            kind: match value.kind {
                SpendKind::SeedSpecified => WireSpendKind::SeedSpecified,
                SpendKind::WatchOnlyUnsignedPsbt => WireSpendKind::WatchOnlyUnsignedPsbt,
                SpendKind::HardwareUnsignedPsbt => WireSpendKind::HardwareUnsignedPsbt,
            },
            fee_rate_sat_per_kb: value.fee_rate.satoshis_per_kb(),
        }
    }
}

impl TryFrom<WireSpendPlan> for SpendPlan {
    type Error = TransportError;

    fn try_from(value: WireSpendPlan) -> Result<Self, Self::Error> {
        Ok(Self {
            selected: parse_outpoint(&value.txid, value.vout)?,
            amount_sats: value.amount_sats,
            destination: value.destination,
            sighash: value.sighash,
            kind: match value.kind {
                WireSpendKind::SeedSpecified => SpendKind::SeedSpecified,
                WireSpendKind::WatchOnlyUnsignedPsbt => SpendKind::WatchOnlyUnsignedPsbt,
                WireSpendKind::HardwareUnsignedPsbt => SpendKind::HardwareUnsignedPsbt,
            },
            fee_rate: FeeRate::from_satoshis_per_kb(value.fee_rate_sat_per_kb),
        })
    }
}

impl TryFrom<WireState> for AppState {
    type Error = TransportError;

    fn try_from(value: WireState) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        let servers = ServerOverrides::try_from(value.servers)?;
        Ok(Self {
            snapshot_revision: value.snapshot_revision,
            route: value.route.into(),
            theme: value.theme.into(),
            skin: value.skin.into(),
            network: value.network.into(),
            fee_preferences: FeePreferences::new(
                value.fee_mode.into(),
                FeeRate::from_satoshis_per_kb(value.custom_fee_satoshis_per_kb),
            ),
            help_open: value.help_open,
            surface: value.surface.into(),
            features: {
                let surface = AppSurface::from(value.surface);
                let defaults = FeatureFlags::default();
                FeatureFlags {
                    cash_fusion: if value.cash_fusion
                        == defaults.enabled(surface, FeatureFlag::CashFusion)
                    {
                        None
                    } else {
                        Some(value.cash_fusion)
                    },
                    hardware_wallet: if value.hardware_wallet
                        == defaults.enabled(surface, FeatureFlag::HardwareWallet)
                    {
                        None
                    } else {
                        Some(value.hardware_wallet)
                    },
                    watch_only: if value.watch_only
                        == defaults.enabled(surface, FeatureFlag::WatchOnly)
                    {
                        None
                    } else {
                        Some(value.watch_only)
                    },
                }
            },
            coins: {
                let mut coins = optn_app::CoinSet::new();
                for wire in value.coins {
                    coins
                        .insert(Coin::try_from(wire)?)
                        .map_err(|error| TransportError::InvalidData(error.to_string()))?;
                }
                coins
            },
            pledges: value
                .pledges
                .into_iter()
                .map(FlipstarterPledge::try_from)
                .collect::<Result<Vec<_>, _>>()?,
            wallet_sync: value.wallet_sync.into(),
            notice: value.notice,
            wallet: value.wallet.map(OpenedWallet::from),
            hd_addresses: value.hd_addresses,
            spend: value.spend.map(SpendPlan::try_from).transpose()?,
            hardware: HardwareSessionState::try_from(value.hardware)?,
            // A decoded snapshot never arrives already revealed: the eye
            // toggle is authorised per session, not carried on the wire.
            identity_revealed: false,
            stealth_sats: value.stealth_sats,
            // Sessions and their pending requests are host-side and live: a
            // decoded snapshot must never arrive carrying a signature request,
            // or a stale frame could put an approval in front of the user.
            connect: ConnectState::new(),
            servers,
            create_step: value.create_step.into(),
            import_step: value.import_step.into(),
            settings_focus: value
                .settings_focus
                .as_deref()
                .map(parse_settings_row)
                .transpose()?,
            return_to: value.return_to.map(AppRoute::from),
            watch_only_kind: value.watch_only_kind.into(),
            multisig_step: value.multisig_step.into(),
            lock: AppLockState {
                auto_lock: AutoLockMinutes::from_minutes(value.auto_lock_minutes),
                unlock_epoch: value.unlock_epoch,
                last_spend_auth_ms: value.last_spend_auth_ms,
                last_spend_auth_epoch: value.last_spend_auth_epoch,
                last_activity_ms: value.last_activity_ms,
                prompt: value
                    .auth_prompt
                    .as_deref()
                    .map(parse_auth_scope)
                    .transpose()?,
            },
        })
    }
}

impl From<AppEvent> for WireEvent {
    fn from(value: AppEvent) -> Self {
        let event = match value {
            AppEvent::RouteChanged(route) => WireEventKind::RouteChanged(route.into()),
            AppEvent::ThemeChanged(theme) => WireEventKind::ThemeChanged(theme.into()),
            AppEvent::SkinChanged(skin) => WireEventKind::SkinChanged(skin.into()),
            AppEvent::FeePreferencesChanged(prefs) => WireEventKind::FeePreferencesChanged {
                mode: prefs.mode.into(),
                custom_fee_satoshis_per_kb: prefs.custom_rate.satoshis_per_kb(),
            },
            AppEvent::NetworkChanged(network) => WireEventKind::NetworkChanged(network.into()),
            AppEvent::HelpVisibilityChanged(open) => WireEventKind::HelpVisibilityChanged(open),
            AppEvent::SurfaceChanged(surface) => WireEventKind::SurfaceChanged(surface.into()),
            AppEvent::FeatureFlagChanged { flag, enabled } => WireEventKind::FeatureFlagChanged {
                flag: flag.into(),
                enabled,
            },
            AppEvent::CoinsChanged => WireEventKind::CoinsChanged,
            AppEvent::FlipstarterPledgesChanged => WireEventKind::FlipstarterPledgesChanged,
            AppEvent::NoticeChanged => WireEventKind::NoticeChanged,
            AppEvent::WalletOpened => WireEventKind::WalletOpened,
            AppEvent::HardwareSessionChanged => WireEventKind::HardwareSessionChanged,
            AppEvent::ServersChanged => WireEventKind::ServersChanged,
            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,
            AppEvent::WalletRebuilt => WireEventKind::WalletRebuilt,
            AppEvent::FlowChanged => WireEventKind::FlowChanged,
            AppEvent::AppLockChanged => WireEventKind::AppLockChanged,
            AppEvent::AuthRequired => WireEventKind::AuthRequired,
            AppEvent::SpendAuthorized => WireEventKind::SpendAuthorized,
            AppEvent::WalletLocked => WireEventKind::WalletLocked,
        };
        Self {
            version: WIRE_PROTOCOL_VERSION,
            event,
        }
    }
}

impl TryFrom<WireEvent> for AppEvent {
    type Error = TransportError;

    fn try_from(value: WireEvent) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(match value.event {
            WireEventKind::RouteChanged(route) => Self::RouteChanged(route.into()),
            WireEventKind::ThemeChanged(theme) => Self::ThemeChanged(theme.into()),
            WireEventKind::SkinChanged(skin) => Self::SkinChanged(skin.into()),
            WireEventKind::FeePreferencesChanged {
                mode,
                custom_fee_satoshis_per_kb,
            } => Self::FeePreferencesChanged(FeePreferences::new(
                mode.into(),
                FeeRate::from_satoshis_per_kb(custom_fee_satoshis_per_kb),
            )),
            WireEventKind::NetworkChanged(network) => Self::NetworkChanged(network.into()),
            WireEventKind::HelpVisibilityChanged(open) => Self::HelpVisibilityChanged(open),
            WireEventKind::SurfaceChanged(surface) => Self::SurfaceChanged(surface.into()),
            WireEventKind::FeatureFlagChanged { flag, enabled } => Self::FeatureFlagChanged {
                flag: flag.into(),
                enabled,
            },
            WireEventKind::CoinsChanged => Self::CoinsChanged,
            WireEventKind::FlipstarterPledgesChanged => Self::FlipstarterPledgesChanged,
            WireEventKind::NoticeChanged => Self::NoticeChanged,
            WireEventKind::WalletOpened => Self::WalletOpened,
            WireEventKind::HardwareSessionChanged => Self::HardwareSessionChanged,
            WireEventKind::ServersChanged => Self::ServersChanged,
            WireEventKind::SpendPrepared => Self::SpendPrepared,
            WireEventKind::WalletRebuilt => Self::WalletRebuilt,
            WireEventKind::FlowChanged => Self::FlowChanged,
            WireEventKind::AppLockChanged => Self::AppLockChanged,
            WireEventKind::AuthRequired => Self::AuthRequired,
            WireEventKind::SpendAuthorized => Self::SpendAuthorized,
            WireEventKind::WalletLocked => Self::WalletLocked,
        })
    }
}

fn default_true() -> bool {
    true
}

fn auth_scope_id(scope: AuthScope) -> &'static str {
    match scope {
        AuthScope::Spend => "spend",
        AuthScope::Reveal => "reveal",
        AuthScope::Background => "background",
        AuthScope::Chat => "chat",
    }
}

fn parse_auth_scope(scope: &str) -> Result<AuthScope, TransportError> {
    match scope {
        "spend" => Ok(AuthScope::Spend),
        "reveal" => Ok(AuthScope::Reveal),
        "background" => Ok(AuthScope::Background),
        "chat" => Ok(AuthScope::Chat),
        other => Err(TransportError::InvalidData(format!(
            "unknown auth scope '{other}'"
        ))),
    }
}

fn settings_row_id(row: SettingsRowId) -> &'static str {
    match row {
        SettingsRowId::Network => "network",
        SettingsRowId::Faucet => "faucet",
        SettingsRowId::WalletInfo => "wallet-info",
        SettingsRowId::Derivation => "derivation",
        SettingsRowId::Recovery => "recovery",
        SettingsRowId::AppLock => "app-lock",
        SettingsRowId::RebuildWallet => "rebuild-wallet",
        SettingsRowId::RescanFromHeight => "rescan-from-height",
        SettingsRowId::Servers => "servers",
        SettingsRowId::Device => "device",
        SettingsRowId::CashFusion => "cash-fusion",
    }
}

fn parse_settings_row(row: &str) -> Result<SettingsRowId, TransportError> {
    match row {
        "network" => Ok(SettingsRowId::Network),
        "faucet" => Ok(SettingsRowId::Faucet),
        "wallet-info" => Ok(SettingsRowId::WalletInfo),
        "derivation" => Ok(SettingsRowId::Derivation),
        "recovery" => Ok(SettingsRowId::Recovery),
        "app-lock" => Ok(SettingsRowId::AppLock),
        "rebuild-wallet" => Ok(SettingsRowId::RebuildWallet),
        "rescan-from-height" => Ok(SettingsRowId::RescanFromHeight),
        "servers" => Ok(SettingsRowId::Servers),
        "device" => Ok(SettingsRowId::Device),
        "cash-fusion" => Ok(SettingsRowId::CashFusion),
        other => Err(TransportError::InvalidData(format!(
            "unknown settings row '{other}'"
        ))),
    }
}

impl From<WatchOnlyKind> for WireWatchOnlyKind {
    fn from(value: WatchOnlyKind) -> Self {
        match value {
            WatchOnlyKind::Single => Self::Single,
            WatchOnlyKind::Shared => Self::Shared,
        }
    }
}

impl From<WireWatchOnlyKind> for WatchOnlyKind {
    fn from(value: WireWatchOnlyKind) -> Self {
        match value {
            WireWatchOnlyKind::Single => Self::Single,
            WireWatchOnlyKind::Shared => Self::Shared,
        }
    }
}

impl From<MultisigStep> for WireMultisigStep {
    fn from(value: MultisigStep) -> Self {
        match value {
            MultisigStep::Policy => Self::Policy,
            MultisigStep::Cosigners => Self::Cosigners,
            MultisigStep::Confirm => Self::Confirm,
        }
    }
}

impl From<WireMultisigStep> for MultisigStep {
    fn from(value: WireMultisigStep) -> Self {
        match value {
            WireMultisigStep::Policy => Self::Policy,
            WireMultisigStep::Cosigners => Self::Cosigners,
            WireMultisigStep::Confirm => Self::Confirm,
        }
    }
}

impl From<CreateStep> for WireCreateStep {
    fn from(value: CreateStep) -> Self {
        match value {
            CreateStep::Reveal => Self::Reveal,
            CreateStep::Confirm => Self::Confirm,
            CreateStep::Path => Self::Path,
            CreateStep::Name => Self::Name,
        }
    }
}

impl From<WireCreateStep> for CreateStep {
    fn from(value: WireCreateStep) -> Self {
        match value {
            WireCreateStep::Reveal => Self::Reveal,
            WireCreateStep::Confirm => Self::Confirm,
            WireCreateStep::Path => Self::Path,
            WireCreateStep::Name => Self::Name,
        }
    }
}

impl From<ImportStep> for WireImportStep {
    fn from(value: ImportStep) -> Self {
        match value {
            ImportStep::Words => Self::Words,
            ImportStep::Path => Self::Path,
            ImportStep::Name => Self::Name,
        }
    }
}

impl From<WireImportStep> for ImportStep {
    fn from(value: WireImportStep) -> Self {
        match value {
            WireImportStep::Words => Self::Words,
            WireImportStep::Path => Self::Path,
            WireImportStep::Name => Self::Name,
        }
    }
}

fn verify_wire_version(version: u16) -> Result<(), TransportError> {
    if version == WIRE_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(TransportError::InvalidData(format!(
            "unsupported transport protocol version {version}; expected {WIRE_PROTOCOL_VERSION}"
        )))
    }
}

/// In-process transport for WASM/web/extension renderers.
#[derive(Clone)]
pub struct LocalTransport {
    state: Arc<Mutex<AppState>>,
    events: Arc<Mutex<VecDeque<AppEvent>>>,
}

impl LocalTransport {
    pub fn new(initial_state: AppState) -> Self {
        Self {
            state: Arc::new(Mutex::new(initial_state)),
            events: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

impl AppTransport for LocalTransport {
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            if matches!(action, AppAction::ConfirmAuth { .. }) {
                return Err(TransportError::Unsupported);
            }
            let event = self
                .state
                .lock()
                .map_err(|_| TransportError::Other("local state lock poisoned".into()))?
                .reduce_intent(action);

            if let Some(event) = event {
                self.events
                    .lock()
                    .map_err(|_| TransportError::Other("local event lock poisoned".into()))?
                    .push_back(event);
            }
            Ok(())
        })
    }

    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
        Box::pin(async move {
            self.state
                .lock()
                .map(|state| state.clone())
                .map_err(|_| TransportError::Other("local state lock poisoned".into()))
        })
    }

    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
        Box::pin(async move {
            self.events
                .lock()
                .map(|mut events| events.pop_front())
                .map_err(|_| TransportError::Other("local event lock poisoned".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_transport_object_safe(_: &dyn AppTransport) {}

    struct NeverTransport;

    impl AppTransport for NeverTransport {
        fn dispatch<'a>(&'a self, _action: AppAction) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }

        fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
            Box::pin(async { Ok(AppState::default()) })
        }

        fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<AppEvent>> {
            Box::pin(async { Ok(None) })
        }
    }

    #[test]
    fn local_transport_reduces_actions_without_shell_or_runtime() {
        let transport = LocalTransport::new(AppState::default());
        let result = futures_lite::future::block_on(async {
            transport.dispatch(AppAction::ToggleTheme).await.unwrap();
            let event = transport.next_event().await.unwrap();
            let snapshot = transport.snapshot().await.unwrap();
            (event, snapshot)
        });
        assert_eq!(
            result.0,
            Some(AppEvent::ThemeChanged(optn_app::ThemeMode::Dark))
        );
        assert_eq!(result.1.theme, optn_app::ThemeMode::Dark);
    }

    #[test]
    fn local_and_wire_intents_cannot_assert_password_verification_or_coins() {
        for scope in [optn_app::AuthScope::Spend, optn_app::AuthScope::Reveal] {
            let mut initial = AppState::default();
            initial.lock.prompt = Some(scope);
            let before = initial.lock.clone();
            let transport = LocalTransport::new(initial);
            futures_lite::future::block_on(async {
                let wire = WireAction::from(AppAction::ConfirmAuth { now_ms: 999_999 });
                assert!(AppAction::try_from(wire).is_err());
                assert!(transport
                    .dispatch(AppAction::ConfirmAuth { now_ms: 999_999 })
                    .await
                    .is_err());
                let state = transport.snapshot().await.unwrap();
                assert_eq!(state.lock, before);
                assert!(!state.identity_revealed);
                assert!(transport.next_event().await.unwrap().is_none());

                transport
                    .dispatch(AppAction::SetStealthSats(999_999))
                    .await
                    .unwrap();
                assert_eq!(transport.snapshot().await.unwrap().stealth_sats, 0);
                transport
                    .dispatch(AppAction::InsertCoin(
                        optn_app::chipnet_demo_coin(10_000, 1).unwrap(),
                    ))
                    .await
                    .unwrap();
                assert!(transport.snapshot().await.unwrap().coins.is_empty());
            });
        }
    }

    #[test]
    fn wire_round_trip_preserves_typed_action_state_and_event() {
        let action = AppAction::SetNetwork(Network::Chipnet);
        let encoded = serde_json::to_string(&WireAction::from(action.clone())).unwrap();
        let decoded: WireAction = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppAction::try_from(decoded).unwrap(), action);

        let action = AppAction::ReplaceNetworkServers {
            network: Network::Chipnet,
            servers: NetworkServers {
                peer: Some("chip.example:8333".into()),
                ..NetworkServers::new()
            },
        };
        let decoded = AppAction::try_from(WireAction::from(action.clone())).unwrap();
        assert_eq!(decoded, action);

        let mut state = AppState::default();
        state.apply(AppAction::ToggleTheme);
        let encoded = serde_json::to_string(&WireState::from(&state)).unwrap();
        let decoded: WireState = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppState::try_from(decoded).unwrap(), state);

        let event = AppEvent::RouteChanged(AppRoute::WatchOnlyWallet);
        let encoded = serde_json::to_string(&WireEvent::from(event.clone())).unwrap();
        let decoded: WireEvent = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppEvent::try_from(decoded).unwrap(), event);

        let action = AppAction::SetFeatureEnabled {
            flag: optn_app::FeatureFlag::HardwareWallet,
            enabled: false,
        };
        let decoded = AppAction::try_from(WireAction::from(action.clone())).unwrap();
        assert_eq!(decoded, action);

        // A chosen account must survive the wire. Dropping it silently would
        // reopen the wallet on the default branch on the far side.
        let opened = AppAction::OpenCreatedWallet {
            name: "second account".into(),
            receive_address: "bitcoincash:qexample".into(),
            account_path: "m/44'/145'/1'".into(),
        };
        let encoded = serde_json::to_string(&WireAction::from(opened.clone())).unwrap();
        assert!(encoded.contains("m/44'/145'/1'"), "{encoded}");
        let decoded: WireAction = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppAction::try_from(decoded).unwrap(), opened);

        let rebuild = AppAction::RebuildWallet;
        let decoded = AppAction::try_from(WireAction::from(rebuild.clone())).unwrap();
        assert_eq!(decoded, rebuild);

        let background = AppAction::AuthorizeBackground { now_ms: 9 };
        let decoded = AppAction::try_from(WireAction::from(background.clone())).unwrap();
        assert_eq!(decoded, background);
        let chat = AppAction::AuthorizeChat { now_ms: 9 };
        let decoded = AppAction::try_from(WireAction::from(chat.clone())).unwrap();
        assert_eq!(decoded, chat);
        let rebuilt = AppEvent::WalletRebuilt;
        let decoded = AppEvent::try_from(WireEvent::from(rebuilt.clone())).unwrap();
        assert_eq!(decoded, rebuilt);
        assert_eq!(
            AppRoute::from(WireRoute::from(AppRoute::History)),
            AppRoute::History
        );
    }

    #[test]
    fn wallet_sync_wire_round_trip_preserves_history_and_legacy_unknowns() {
        let mut state = AppState {
            network: Network::Chipnet,
            snapshot_revision: 42,
            wallet_sync: WalletSyncView {
                refreshing: true,
                history_fresh: false,
                utxos_fresh: false,
                source: Some("chip.example:50002".into()),
                evidence: Some("provider-reported".into()),
                tip_height: Some(250_000),
                confirmed_sats: Some(50_000),
                pending_sats: -2_500,
                // Spent receipts and outgoing history must survive without live coins.
                history: [
                    HistoryKind::Received,
                    HistoryKind::Sent,
                    HistoryKind::Transfer,
                    HistoryKind::PendingSend,
                ]
                .into_iter()
                .enumerate()
                .map(|(index, kind)| HistoryEntry {
                    kind,
                    txid: format!("{index:064x}"),
                    amount_sats: 2_500 + index as u64,
                    address: "bchtest:qhistory".into(),
                    reserved: kind == HistoryKind::PendingSend,
                    block_height: (kind != HistoryKind::PendingSend).then_some(249_999),
                })
                .collect(),
                error: Some("refresh failed; retaining prior history".into()),
                scan_coverage: Some(ScanCoverageView {
                    from_height: 200_000,
                    skipped_below: Some(150_000),
                    chosen_by_holder: true,
                }),
                rescan_requested: Some(200_000),
            },
            ..AppState::default()
        };
        assert!(state.coins.is_empty());
        for (history_fresh, utxos_fresh) in [(false, false), (true, false), (false, true)] {
            state.wallet_sync.history_fresh = history_fresh;
            state.wallet_sync.utxos_fresh = utxos_fresh;
            let encoded = serde_json::to_string(&WireState::from(&state)).unwrap();
            let decoded: WireState = serde_json::from_str(&encoded).unwrap();
            assert_eq!(AppState::try_from(decoded).unwrap(), state);
        }

        let mut legacy = serde_json::to_value(WireState::from(&state)).unwrap();
        let fields = legacy.as_object_mut().unwrap();
        fields.remove("snapshot_revision");
        fields.remove("wallet_sync");
        for sync in [None, Some(serde_json::json!({}))] {
            if let Some(sync) = sync {
                legacy["wallet_sync"] = sync;
            }
            let decoded: WireState = serde_json::from_value(legacy.clone()).unwrap();
            let restored = AppState::try_from(decoded).unwrap();
            assert_eq!(restored.snapshot_revision, 0);
            assert_eq!(restored.wallet_sync, WalletSyncView::empty());
            assert_eq!(restored.wallet_sync.total_sats(), None);
        }

        let mut invalid = serde_json::to_value(WireState::from(&state)).unwrap();
        invalid["wallet_sync"]["history"][0]["kind"] = "unknown".into();
        assert!(serde_json::from_value::<WireState>(invalid).is_err());
        assert_eq!(
            futures_lite::future::block_on(NeverTransport.refresh_wallet()),
            Err(TransportError::Unsupported)
        );
    }

    #[test]
    fn wire_round_trip_preserves_network_scoped_server_overrides() {
        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        state
            .servers
            .set(
                Network::Mainnet,
                ServerKind::Explorer,
                "https://main.example/",
            )
            .unwrap();
        state
            .servers
            .set(Network::Chipnet, ServerKind::Peer, "chip.example:8333")
            .unwrap();

        let encoded = serde_json::to_string(&WireState::from(&state)).unwrap();
        let decoded: WireState = serde_json::from_str(&encoded).unwrap();

        assert_eq!(
            decoded.servers.mainnet.electrum.as_deref(),
            Some("main.example:50002")
        );
        assert_eq!(
            decoded.servers.mainnet.explorer.as_deref(),
            Some("https://main.example")
        );
        assert_eq!(
            decoded.servers.chipnet.peer.as_deref(),
            Some("chip.example:8333")
        );
        assert!(decoded.servers.chipnet.electrum.is_none());

        let restored = AppState::try_from(decoded).unwrap();
        assert_eq!(restored.servers, state.servers);
    }

    #[test]
    fn legacy_wire_snapshot_decodes_with_empty_server_overrides() {
        let mut snapshot = serde_json::to_value(WireState::from(&AppState::default())).unwrap();
        snapshot
            .as_object_mut()
            .expect("wire snapshot object")
            .remove("servers");

        let decoded: WireState = serde_json::from_value(snapshot).unwrap();
        assert_eq!(decoded.servers, WireServerOverrides::default());

        let restored = AppState::try_from(decoded).unwrap();
        assert_eq!(restored.servers, ServerOverrides::new());
    }

    #[test]
    fn wire_snapshot_preserves_the_watch_only_switch_on_every_surface() {
        // Watch Only is offered everywhere -- it needs no transport, so a shell
        // with no camera and no USB can still watch a cold wallet -- and each
        // platform switches it off with a flag. What serialization could break
        // is either half: a surface silently losing the offer, or a surface
        // that switched it off silently regaining it.
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let state = AppState::for_surface(surface);
            let restored = AppState::try_from(WireState::from(&state)).expect("wire state");
            assert_eq!(restored.surface, surface);
            assert!(
                optn_app::onboarding_actions(&restored)
                    .contains(&optn_app::OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} Watch Only stays on the landing after a wire round-trip"
            );

            let mut off = AppState::for_surface(surface);
            off.apply(optn_app::AppAction::SetFeatureEnabled {
                flag: optn_app::FeatureFlag::WatchOnly,
                enabled: false,
            });
            let restored = AppState::try_from(WireState::from(&off)).expect("wire state");
            assert!(
                !optn_app::onboarding_actions(&restored)
                    .contains(&optn_app::OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} must not regain Watch Only through serialization"
            );
        }
    }

    #[test]
    fn wire_protocol_rejects_unknown_version() {
        let mut wire = WireAction::from(AppAction::OpenHelp);
        wire.version = WIRE_PROTOCOL_VERSION + 1;
        assert!(matches!(
            AppAction::try_from(wire),
            Err(TransportError::InvalidData(_))
        ));
    }

    #[test]
    fn transport_can_be_used_as_a_framework_neutral_trait_object() {
        let transport = NeverTransport;
        assert_transport_object_safe(&transport);
    }

    #[test]
    fn wire_coin_preserves_token_custody_and_accepts_legacy_plain_coins() {
        let plain = optn_app::chipnet_demo_coin(6000, 5).unwrap();
        let token = optn_app::TokenData::fungible([9; 32], 42);
        let protected = plain.clone().with_token(token.clone());
        let json = serde_json::to_string(&WireCoin::from(&protected)).unwrap();
        let restored = Coin::try_from(serde_json::from_str::<WireCoin>(&json).unwrap()).unwrap();
        assert_eq!(restored.token(), Some(&token));
        assert!(!restored.is_spendable());
        assert!(!restored.is_fusable(3));
        let legacy = serde_json::to_string(&WireCoin::from(&plain)).unwrap();
        assert!(!legacy.contains("token"));
        let restored = Coin::try_from(serde_json::from_str::<WireCoin>(&legacy).unwrap()).unwrap();
        assert!(restored.is_spendable());
    }

    #[test]
    fn wire_round_trip_preserves_frozen_coins_and_flipstarter_route() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = optn_app::seed_wallet_preview(
            Network::Chipnet,
            "wire",
            optn_app::BIP39_TEST_VECTOR_MNEMONIC,
        )
        .expect("preview");
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::Navigate(AppRoute::Flipstarter));
        let coin = optn_app::chipnet_demo_coin(6_000, 5).expect("coin");
        let outpoint = coin.outpoint();
        state.apply(AppAction::InsertCoin(coin));
        state.apply(AppAction::FreezeCoin(outpoint));

        let encoded = serde_json::to_string(&WireState::from(&state)).unwrap();
        let decoded: WireState = serde_json::from_str(&encoded).unwrap();
        let restored = AppState::try_from(decoded).unwrap();
        assert_eq!(restored.route, AppRoute::Flipstarter);
        assert_eq!(restored.coins.reserved_sats(), 6_000);
        assert_eq!(
            restored
                .coins
                .get(outpoint)
                .and_then(optn_app::Coin::freeze),
            Some(optn_app::FreezeReason::User)
        );

        let action = AppAction::PrepareFlipstarterPledge {
            blob: "YQ==".into(),
            now_unix: None,
        };
        let decoded = AppAction::try_from(WireAction::from(action.clone())).unwrap();
        assert_eq!(decoded, action);
    }

    /// A rescan instruction has to survive the renderer boundary intact.
    ///
    /// A height that arrives as a different number, or not at all, means the
    /// wallet reads a stretch of chain nobody asked for.
    #[test]
    fn wire_round_trip_preserves_a_rescan_instruction() {
        let action = AppAction::RequestRescanFrom { height: 812_345 };
        let decoded = AppAction::try_from(WireAction::from(action.clone())).unwrap();
        assert_eq!(decoded, action);
    }

    /// So does what the wallet says its scan covers.
    #[test]
    fn wire_round_trip_preserves_scan_coverage() {
        let view = WalletSyncView {
            scan_coverage: Some(ScanCoverageView {
                from_height: 700_000,
                skipped_below: Some(650_000),
                chosen_by_holder: true,
            }),
            rescan_requested: Some(700_000),
            ..WalletSyncView::empty()
        };
        let decoded = WalletSyncView::from(WireWalletSyncView::from(&view));
        assert_eq!(decoded.scan_coverage, view.scan_coverage);
        assert_eq!(decoded.rescan_requested, Some(700_000));
    }

    /// A renderer built before rescans existed still decodes.
    #[test]
    fn a_sync_view_without_coverage_fields_still_decodes() {
        let legacy = r#"{"refreshing":false,"history_fresh":true,"confirmed_sats":10}"#;
        let wire: WireWalletSyncView = serde_json::from_str(legacy).expect("legacy view decodes");
        let view = WalletSyncView::from(wire);
        assert_eq!(view.confirmed_sats, Some(10));
        assert_eq!(view.scan_coverage, None);
        assert_eq!(view.rescan_requested, None);
    }
}
