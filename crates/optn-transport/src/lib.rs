#![forbid(unsafe_code)]

//! Transport boundary between renderers and the authoritative application.
//!
//! A renderer must not know whether actions/events cross Tauri IPC, stay
//! in-process, or run inside a WASM host. Implementations live outside this
//! crate; only these typed contracts are shared.

use optn_app::{
    AppAction, AppEvent, AppRoute, AppState, AppSurface, CampaignOutput, Coin, FeatureFlag,
    FeatureFlags, FlipstarterPledge, FreezeReason, Network, OpenedWallet, Outpoint, PledgeStatus,
    SpendKind, SpendPlan, ThemeMode, UiSkin, WalletKind, WatchOnlySetupPreview,
};
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WatchOnlyWallet,
    WalletHome,
    Coins,
    Actions,
    Explore,
    Settings,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireCoin {
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    pub address: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub freeze: Option<WireFreezeReason>,
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
    },
    OpenImportedWallet {
        name: String,
        receive_address: String,
    },
    OpenWatchOnlyWallet {
        wallet_name: String,
        master_fingerprint: Option<String>,
        account_path: String,
        receive_address: String,
        receive_token_address: String,
        change_address: String,
    },
    PrepareSend {
        destination: String,
        amount_sats: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireAction {
    pub version: u16,
    pub action: WireActionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireState {
    pub version: u16,
    pub route: WireRoute,
    pub theme: WireTheme,
    #[serde(default)]
    pub skin: WireSkin,
    pub network: WireNetwork,
    pub help_open: bool,
    pub surface: WireSurface,
    pub cash_fusion: bool,
    pub hardware_wallet: bool,
    #[serde(default = "default_true")]
    pub watch_only: bool,
    #[serde(default)]
    pub coins: Vec<WireCoin>,
    #[serde(default)]
    pub pledges: Vec<WirePledge>,
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub wallet: Option<WireOpenedWallet>,
    #[serde(default)]
    pub spend: Option<WireSpendPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireWalletKind {
    Seed,
    WatchOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireOpenedWallet {
    pub kind: WireWalletKind,
    pub name: String,
    pub receive_address: String,
    #[serde(default)]
    pub master_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireSpendKind {
    SeedSpecified,
    WatchOnlyUnsignedPsbt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireSpendPlan {
    pub txid: String,
    pub vout: u32,
    pub amount_sats: u64,
    pub destination: String,
    pub sighash: u8,
    pub kind: WireSpendKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum WireEventKind {
    RouteChanged(WireRoute),
    ThemeChanged(WireTheme),
    SkinChanged(WireSkin),
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
    SpendPrepared,
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
            AppRoute::WalletHome => Self::WalletHome,
            AppRoute::Coins => Self::Coins,
            AppRoute::Actions => Self::Actions,
            AppRoute::Explore => Self::Explore,
            AppRoute::Settings => Self::Settings,
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
            WireRoute::WalletHome => Self::WalletHome,
            WireRoute::Coins => Self::Coins,
            WireRoute::Actions => Self::Actions,
            WireRoute::Explore => Self::Explore,
            WireRoute::Settings => Self::Settings,
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
        }
    }
}

impl From<WireNetwork> for Network {
    fn from(value: WireNetwork) -> Self {
        match value {
            WireNetwork::Mainnet => Self::Mainnet,
            WireNetwork::Chipnet => Self::Chipnet,
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
        }
    }
}

impl From<WireFreezeReason> for FreezeReason {
    fn from(value: WireFreezeReason) -> Self {
        match value {
            WireFreezeReason::User => Self::User,
            WireFreezeReason::FlipstarterPledge => Self::FlipstarterPledge,
            WireFreezeReason::Authhead => Self::Authhead,
        }
    }
}

impl From<&Coin> for WireCoin {
    fn from(value: &Coin) -> Self {
        Self {
            txid: value.outpoint().txid_hex(),
            vout: value.outpoint().vout(),
            value_sats: value.value_sats(),
            address: value.address().to_owned(),
            label: value.label().map(str::to_owned),
            freeze: value.freeze().map(WireFreezeReason::from),
        }
    }
}

impl TryFrom<WireCoin> for Coin {
    type Error = TransportError;

    fn try_from(value: WireCoin) -> Result<Self, Self::Error> {
        let outpoint = Outpoint::parse(&value.txid, value.vout)
            .map_err(|error| TransportError::InvalidData(error.to_string()))?;
        let mut coin = Coin::new(outpoint, value.value_sats, value.address)
            .map_err(|error| TransportError::InvalidData(error.to_string()))?;
        coin.set_label(value.label);
        coin.restore_freeze(value.freeze.map(FreezeReason::from));
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
            } => WireActionKind::OpenCreatedWallet {
                name,
                receive_address,
            },
            AppAction::OpenImportedWallet {
                name,
                receive_address,
            } => WireActionKind::OpenImportedWallet {
                name,
                receive_address,
            },
            AppAction::OpenWatchOnlyWallet(preview) => WireActionKind::OpenWatchOnlyWallet {
                wallet_name: preview.wallet_name,
                master_fingerprint: preview.master_fingerprint,
                account_path: preview.account_path,
                receive_address: preview.receive_address,
                receive_token_address: preview.receive_token_address,
                change_address: preview.change_address,
            },
            AppAction::PrepareSend {
                destination,
                amount_sats,
            } => WireActionKind::PrepareSend {
                destination,
                amount_sats,
            },
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
            } => Self::OpenCreatedWallet {
                name,
                receive_address,
            },
            WireActionKind::OpenImportedWallet {
                name,
                receive_address,
            } => Self::OpenImportedWallet {
                name,
                receive_address,
            },
            WireActionKind::OpenWatchOnlyWallet {
                wallet_name,
                master_fingerprint,
                account_path,
                receive_address,
                receive_token_address,
                change_address,
            } => Self::OpenWatchOnlyWallet(WatchOnlySetupPreview {
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
            } => Self::PrepareSend {
                destination,
                amount_sats,
            },
        })
    }
}

impl From<&AppState> for WireState {
    fn from(value: &AppState) -> Self {
        Self {
            version: WIRE_PROTOCOL_VERSION,
            route: value.route.into(),
            theme: value.theme.into(),
            skin: value.skin.into(),
            network: value.network.into(),
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
            pledges: value.pledges.iter().map(WirePledge::from).collect(),
            notice: value.notice.clone(),
            wallet: value.wallet.as_ref().map(WireOpenedWallet::from),
            spend: value.spend.as_ref().map(WireSpendPlan::from),
        }
    }
}

impl From<&OpenedWallet> for WireOpenedWallet {
    fn from(value: &OpenedWallet) -> Self {
        Self {
            kind: match value.kind {
                WalletKind::Seed => WireWalletKind::Seed,
                WalletKind::WatchOnly => WireWalletKind::WatchOnly,
            },
            name: value.name.clone(),
            receive_address: value.receive_address.clone(),
            master_fingerprint: value.master_fingerprint.clone(),
        }
    }
}

impl From<WireOpenedWallet> for OpenedWallet {
    fn from(value: WireOpenedWallet) -> Self {
        Self {
            kind: match value.kind {
                WireWalletKind::Seed => WalletKind::Seed,
                WireWalletKind::WatchOnly => WalletKind::WatchOnly,
            },
            name: value.name,
            receive_address: value.receive_address,
            master_fingerprint: value.master_fingerprint,
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
            },
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
            },
        })
    }
}

impl TryFrom<WireState> for AppState {
    type Error = TransportError;

    fn try_from(value: WireState) -> Result<Self, Self::Error> {
        verify_wire_version(value.version)?;
        Ok(Self {
            route: value.route.into(),
            theme: value.theme.into(),
            skin: value.skin.into(),
            network: value.network.into(),
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
            notice: value.notice,
            wallet: value.wallet.map(OpenedWallet::from),
            spend: value.spend.map(SpendPlan::try_from).transpose()?,
        })
    }
}

impl From<AppEvent> for WireEvent {
    fn from(value: AppEvent) -> Self {
        let event = match value {
            AppEvent::RouteChanged(route) => WireEventKind::RouteChanged(route.into()),
            AppEvent::ThemeChanged(theme) => WireEventKind::ThemeChanged(theme.into()),
            AppEvent::SkinChanged(skin) => WireEventKind::SkinChanged(skin.into()),
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
            AppEvent::SpendPrepared => WireEventKind::SpendPrepared,
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
            WireEventKind::SpendPrepared => Self::SpendPrepared,
        })
    }
}

fn default_true() -> bool {
    true
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
            let event = self
                .state
                .lock()
                .map_err(|_| TransportError::Other("local state lock poisoned".into()))?
                .reduce(action);

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
    fn wire_round_trip_preserves_typed_action_state_and_event() {
        let action = AppAction::SetNetwork(Network::Chipnet);
        let encoded = serde_json::to_string(&WireAction::from(action.clone())).unwrap();
        let decoded: WireAction = serde_json::from_str(&encoded).unwrap();
        assert_eq!(AppAction::try_from(decoded).unwrap(), action);

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
    }

    #[test]
    fn android_wire_snapshot_keeps_watch_only_on_the_landing() {
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
                "{surface:?} Watch Only stays on the landing when the flag is true"
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
}
