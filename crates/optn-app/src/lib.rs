#![forbid(unsafe_code)]

//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch typed actions. Runtime/shell
//! adapters may subscribe to typed events. No UI or native-shell framework
//! belongs in this crate.

pub mod connect;
mod flow;
pub mod identity;
pub mod menu;
pub use connect::{
    most_urgent, ApprovalBlock, ConnectProtocol, ConnectRequest, ConnectState, RequestKind,
};
pub use menu::{
    menu_bar, MenuBarSection, MenuCommand, MenuEntry, MenuPlatform, MenuSection, NativeRole,
    NATIVE_EDIT_KEYS,
};
pub mod networks;
pub mod portfolio;
pub use identity::{wallet_identity, RevealedIdentity, WalletIdentity, WalletTypeLabel};
pub use networks::{
    network_settings_view_model, NetworkOption, NetworkSettingsViewModel, PlannedNetwork,
};
pub use portfolio::{stealth_sats_from_record, PortfolioTotals};
pub mod servers;
pub use servers::{NetworkServers, ServerKind, ServerOverrides};
mod lock;

pub use flow::{
    create_confirm_indices, flow_view_model, CreateStep, FlowViewModel, ImportStep, MultisigStep,
    WatchOnlyKind,
};
pub use lock::{
    app_lock_view_model, AppLockState, AppLockViewModel, AuthDecision, AuthScope, AutoLockMinutes,
    SPEND_AUTH_TTL_MS,
};

pub use optn_core::coins::{Coin, CoinSet, FreezeReason, Outpoint};
pub use optn_core::fee::{
    FeeMode, FeePreferences, FeeRate, DEFAULT_CUSTOM_FEE_RATE, RELAY_MINIMUM_FEE_RATE,
};
pub use optn_core::flipstarter::{
    chipnet_demo_coin, encode_campaign_blob, sample_chipnet_campaign_blob, Campaign,
    CampaignOutput, FlipstarterPledge, PledgeStatus,
};
pub use optn_core::fundme::{FundMeProduct, FundMeStatus};
pub use optn_core::hd::{
    account_choices, entropy_len_for_word_count, mnemonic_from_entropy, parse_account_path,
    seed_receive_address, seed_receive_address_at, AccountPath, BIP39_DEFAULT_WORD_COUNT,
    BIP39_TEST_VECTOR_MNEMONIC, BIP39_WORD_COUNTS,
};
pub use optn_core::network::Network;
pub use optn_core::spend::{
    prepare_spend, prepare_spend_with, prepare_spend_with_fee, prepare_spend_with_fee_and_coin,
    sign_seed_spend, SpendKind, SpendPlan, SpendingCapability, SIGHASH_ALL_FORKID,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Gray,
    Green,
    Dark,
}

impl ThemeMode {
    pub const fn next(self) -> Self {
        match self {
            Self::Light => Self::Gray,
            Self::Gray => Self::Green,
            Self::Green => Self::Dark,
            Self::Dark => Self::Light,
        }
    }

    pub const fn is_dark_surface(self) -> bool {
        !matches!(self, Self::Light)
    }

    pub const fn css_class(self) -> &'static str {
        match self {
            Self::Light => "theme-light",
            Self::Gray => "theme-gray",
            Self::Green => "theme-green",
            Self::Dark => "theme-dark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UiSkin {
    #[default]
    Default,
    Cyberpunk,
}

impl UiSkin {
    pub const fn css_class(self) -> &'static str {
        match self {
            Self::Default => "skin-default",
            Self::Cyberpunk => "skin-cyberpunk",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppSurface {
    Desktop,
    Android,
    Ios,
    Web,
    Extension,
}

impl AppSurface {
    pub const fn can_spend(self) -> bool {
        !matches!(self, Self::Extension)
    }

    pub const fn is_viewer_only(self) -> bool {
        !self.can_spend()
    }

    #[allow(clippy::match_like_matches_macro)]
    pub const fn offers_watch_only(self) -> bool {
        match self {
            Self::Desktop => true,
            Self::Android => true,
            Self::Ios => true,
            Self::Web => true,
            Self::Extension => true,
        }
    }

    #[allow(clippy::match_like_matches_macro)]
    pub const fn offers_hardware_wallet(self) -> bool {
        match self {
            Self::Desktop => true,
            Self::Web => true,
            Self::Extension => true,
            Self::Android => false,
            Self::Ios => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureFlag {
    CashFusion,
    HardwareWallet,
    WatchOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureFlags {
    pub cash_fusion: Option<bool>,
    pub hardware_wallet: Option<bool>,
    pub watch_only: Option<bool>,
}

impl FeatureFlags {
    pub const fn surface_allows(surface: AppSurface, flag: FeatureFlag) -> bool {
        match flag {
            FeatureFlag::CashFusion => matches!(surface, AppSurface::Desktop),
            FeatureFlag::HardwareWallet => surface.offers_hardware_wallet(),
            FeatureFlag::WatchOnly => surface.offers_watch_only(),
        }
    }

    pub fn enabled(self, surface: AppSurface, flag: FeatureFlag) -> bool {
        let surface_default = Self::surface_allows(surface, flag);
        match flag {
            FeatureFlag::HardwareWallet => self.hardware_wallet.unwrap_or(surface_default),
            FeatureFlag::CashFusion => surface_default && self.cash_fusion.unwrap_or(true),
            FeatureFlag::WatchOnly => surface_default && self.watch_only.unwrap_or(true),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppRoute {
    Landing,
    CreateWallet,
    ImportWallet,
    WatchOnlyWallet,
    HardwareWallet,
    WalletHome,
    Coins,
    Actions,
    Explore,
    Settings,
    History,
    Flipstarter,
    FundMe,
    Receive,
    Send,
}

impl AppRoute {
    pub const fn fragment(self) -> &'static str {
        match self {
            Self::Landing => "#/",
            Self::CreateWallet => "#/createwallet",
            Self::ImportWallet => "#/importwallet",
            Self::WatchOnlyWallet => "#/watch-only",
            Self::HardwareWallet => "#/hardware",
            Self::WalletHome => "#/wallet",
            Self::Coins => "#/assets",
            Self::Actions => "#/actions",
            Self::Explore => "#/explore",
            Self::Settings => "#/settings",
            Self::History => "#/history",
            Self::Flipstarter => "#/flipstarter",
            Self::FundMe => "#/fundme",
            Self::Receive => "#/receive",
            Self::Send => "#/send",
        }
    }

    pub const fn is_wallet_chrome(self) -> bool {
        matches!(
            self,
            Self::WalletHome
                | Self::Coins
                | Self::Actions
                | Self::Explore
                | Self::Settings
                | Self::History
                | Self::Flipstarter
                | Self::FundMe
                | Self::Receive
                | Self::Send
        )
    }

    pub const fn is_section_root(self) -> bool {
        matches!(
            self,
            Self::Landing | Self::WalletHome | Self::Coins | Self::Actions | Self::Explore | Self::Settings
        )
    }

    pub const fn default_parent(self) -> Option<Self> {
        match self {
            Self::Landing | Self::WalletHome | Self::Coins | Self::Actions | Self::Explore => None,
            Self::Settings => Some(Self::WalletHome),
            Self::CreateWallet | Self::ImportWallet | Self::WatchOnlyWallet | Self::HardwareWallet => Some(Self::Landing),
            Self::Receive | Self::Send | Self::History => Some(Self::WalletHome),
            Self::Flipstarter => Some(Self::Actions),
            Self::FundMe => Some(Self::Explore),
        }
    }

    pub const fn section_title(self) -> &'static str {
        match self {
            Self::Landing => "Wallets",
            Self::CreateWallet => "Create wallet",
            Self::ImportWallet => "Import wallet",
            Self::WatchOnlyWallet => "Watch-only",
            Self::HardwareWallet => "Hardware",
            Self::WalletHome => "Home",
            Self::Coins => "Assets",
            Self::Actions => "Actions",
            Self::Explore => "Explore",
            Self::Settings => "Settings",
            Self::History => "History",
            Self::Flipstarter => "Flipstarter",
            Self::FundMe => "FundMe",
            Self::Receive => "Receive",
            Self::Send => "Send",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutKind {
    Desktop,
    Compact,
}

impl LayoutKind {
    pub const fn from_surface(surface: AppSurface) -> Self {
        match surface {
            AppSurface::Desktop => Self::Desktop,
            AppSurface::Android | AppSurface::Ios | AppSurface::Web | AppSurface::Extension => Self::Compact,
        }
    }

    pub const fn css_class(self) -> &'static str {
        match self {
            Self::Desktop => "shell-desktop",
            Self::Compact => "shell-mobile",
        }
    }

    pub const fn is_desktop(self) -> bool {
        matches!(self, Self::Desktop)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppState {
    pub route: AppRoute,
    pub theme: ThemeMode,
    pub skin: UiSkin,
    pub network: Network,
    pub help_open: bool,
    pub surface: AppSurface,
    pub features: FeatureFlags,
    pub coins: CoinSet,
    pub pledges: Vec<FlipstarterPledge>,
    pub notice: Option<String>,
    pub wallet: Option<OpenedWallet>,
    pub spend: Option<SpendPlan>,
    pub hardware: HardwareSessionState,
    pub servers: ServerOverrides,
    /// App-wide transaction fee policy. This survives route/provider changes;
    /// chain transports may provide advisory inputs but never own this value.
    pub fee_preferences: FeePreferences,
    pub identity_revealed: bool,
    pub stealth_sats: u64,
    pub connect: ConnectState,
    pub create_step: CreateStep,
    pub import_step: ImportStep,
    pub settings_focus: Option<SettingsRowId>,
    pub watch_only_kind: WatchOnlyKind,
    pub multisig_step: MultisigStep,
    pub return_to: Option<AppRoute>,
    pub lock: AppLockState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletKind {
    Seed,
    WatchOnly,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedWallet {
    pub kind: WalletKind,
    pub name: String,
    pub receive_address: String,
    pub master_fingerprint: Option<String>,
    pub account_path: String,
    pub multisig_policy: Option<String>,
    pub account_xpub: Option<String>,
}

impl OpenedWallet {
    pub const fn spending_capability(&self) -> SpendingCapability {
        match self.kind {
            WalletKind::Seed => SpendingCapability::Seed,
            WalletKind::WatchOnly => SpendingCapability::WatchOnly,
            WalletKind::Hardware => SpendingCapability::Hardware,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::for_surface(AppSurface::Desktop)
    }
}

impl AppState {
    pub const fn for_surface(surface: AppSurface) -> Self {
        Self {
            route: AppRoute::Landing,
            theme: ThemeMode::Green,
            skin: UiSkin::Default,
            network: Network::Mainnet,
            help_open: false,
            surface,
            features: FeatureFlags { cash_fusion: None, hardware_wallet: None, watch_only: None },
            coins: CoinSet::new(),
            pledges: Vec::new(),
            notice: None,
            wallet: None,
            spend: None,
            hardware: HardwareSessionState::new(),
            servers: ServerOverrides::new(),
            fee_preferences: FeePreferences::app_default(),
            identity_revealed: false,
            stealth_sats: 0,
            connect: ConnectState::new(),
            create_step: CreateStep::Reveal,
            import_step: ImportStep::Words,
            settings_focus: None,
            watch_only_kind: WatchOnlyKind::Single,
            multisig_step: MultisigStep::Policy,
            return_to: None,
            lock: AppLockState::new(),
        }
    }

    pub const fn layout(&self) -> LayoutKind { LayoutKind::from_surface(self.surface) }
    pub fn fundme(&self) -> FundMeProduct { optn_core::fundme::product() }
    pub fn flow(&self) -> FlowViewModel {
        flow_view_model(self.route, self.create_step, self.import_step, self.settings_focus, self.return_to, self.watch_only_kind, self.multisig_step)
    }

    /// Current rate used by the application when preparing a transaction.
    /// Automatic intentionally preserves the wallet's existing relay-minimum
    /// behavior until a future fee-estimate capability supplies an advisory
    /// rate. The relay floor is applied in either mode.
    pub const fn resolved_fee_rate(&self) -> FeeRate {
        self.fee_preferences.resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAction {
    Navigate(AppRoute), ToggleTheme, SetTheme(ThemeMode), SetSkin(UiSkin), SetNetwork(Network), OpenHelp, CloseHelp, SetSurface(AppSurface),
    SetFeatureEnabled { flag: FeatureFlag, enabled: bool },
    InsertCoin(Coin), FreezeCoin(Outpoint), UnfreezeCoin(Outpoint), SetCoinLabel { outpoint: Outpoint, label: Option<String> },
    PrepareFlipstarterPledge { blob: String, now_unix: Option<u64> }, CancelFlipstarterPledge(u32), ClearNotice,
    OpenCreatedWallet { name: String, receive_address: String, account_path: String },
    OpenImportedWallet { name: String, receive_address: String, account_path: String },
    OpenWatchOnlyWallet(WatchOnlySetupPreview), OpenHardwareWallet(HardwareSetupPreview), OpenMultisigWallet(MultisigSetupPreview),
    SelectHardwareVendor(Option<HardwareVendor>), SetLedgerLink(LedgerLink), SetHardwareDerivationPath(Option<AccountPath>),
    HardwareConnected { label: String, account_xpub: String }, DisconnectHardware, HideWalletIdentity, SetStealthSats(u64),
    SetServer { kind: ServerKind, entry: String }, UseNetworkDefaultServers,
    /// Select Automatic or Custom without changing the remembered custom rate.
    SetFeeMode(FeeMode),
    /// Update the remembered exact custom rate. A zero/invalid renderer value
    /// falls back to the historical 1.1 sat/B editor default.
    SetCustomFeeRate(FeeRate),
    PrepareSend { destination: String, amount_sats: u64, #[allow(clippy::option_option)] coin: Option<Outpoint> },
    RebuildWallet, GoBack, AdvanceOnboarding, OpenSettingsRow(SettingsRowId), SetWatchOnlyKind(WatchOnlyKind), SetAutoLockMinutes(u32), LockWallet,
    RecordActivity { now_ms: u64 }, IdleCheck { now_ms: u64 }, AuthorizeSpend { now_ms: u64 }, RequestReveal { now_ms: u64 },
    AuthorizeBackground { now_ms: u64 }, AuthorizeChat { now_ms: u64 }, ConfirmAuth { now_ms: u64 }, CancelAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    RouteChanged(AppRoute), ThemeChanged(ThemeMode), SkinChanged(UiSkin), NetworkChanged(Network), HelpVisibilityChanged(bool), SurfaceChanged(AppSurface),
    FeatureFlagChanged { flag: FeatureFlag, enabled: bool }, CoinsChanged, FlipstarterPledgesChanged, NoticeChanged, WalletOpened,
    HardwareSessionChanged, ServersChanged, FeePreferencesChanged, SpendPrepared, WalletRebuilt, FlowChanged, AppLockChanged, AuthRequired,
    SpendAuthorized, WalletLocked,
}

impl AppState {
    pub fn reduce(&mut self, action: AppAction) -> Option<AppEvent> {
        match action {
            AppAction::Navigate(route) => {
                if route.is_wallet_chrome() && self.wallet.is_none() { return self.reject("Create, import, or open a watch-only wallet first.".into()); }
                if route == AppRoute::WatchOnlyWallet && !self.features.enabled(self.surface, FeatureFlag::WatchOnly) { return self.reject("Watch-only is turned off.".into()); }
                if route == AppRoute::HardwareWallet && !self.features.enabled(self.surface, FeatureFlag::HardwareWallet) { return self.reject("Hardware wallets are not available here.".into()); }
                let mut flow_changed = false;
                if route.is_section_root() { if self.return_to.is_some() { self.return_to = None; flow_changed = true; } }
                else if self.route.is_section_root() && self.return_to != Some(self.route) { self.return_to = Some(self.route); flow_changed = true; }
                if route == AppRoute::CreateWallet && self.create_step != CreateStep::Reveal { self.create_step = CreateStep::Reveal; flow_changed = true; }
                if route == AppRoute::ImportWallet && self.import_step != ImportStep::Words { self.import_step = ImportStep::Words; flow_changed = true; }
                if route == AppRoute::Settings && self.settings_focus.is_some() { self.settings_focus = None; flow_changed = true; }
                if route == AppRoute::WatchOnlyWallet && (self.watch_only_kind != WatchOnlyKind::Single || self.multisig_step != MultisigStep::Policy) { self.watch_only_kind = WatchOnlyKind::Single; self.multisig_step = MultisigStep::Policy; flow_changed = true; }
                if self.route == route { return flow_changed.then_some(AppEvent::FlowChanged); }
                if route == AppRoute::CreateWallet { self.create_step = CreateStep::Reveal; }
                if route == AppRoute::ImportWallet { self.import_step = ImportStep::Words; }
                if route == AppRoute::WatchOnlyWallet { self.watch_only_kind = WatchOnlyKind::Single; self.multisig_step = MultisigStep::Policy; }
                self.route = route; Some(AppEvent::RouteChanged(route))
            }
            AppAction::ToggleTheme => { self.theme = self.theme.next(); Some(AppEvent::ThemeChanged(self.theme)) }
            AppAction::SetTheme(theme) if self.theme != theme => { self.theme = theme; Some(AppEvent::ThemeChanged(theme)) }
            AppAction::SetSkin(skin) if self.skin != skin => { self.skin = skin; Some(AppEvent::SkinChanged(skin)) }
            AppAction::SetNetwork(network) if self.network != network => {
                self.network = network; self.coins.clear(); self.pledges.clear(); self.spend = None; self.stealth_sats = 0; self.connect.cancel_all(); Some(AppEvent::NetworkChanged(network))
            }
            AppAction::OpenHelp if !self.help_open => { self.help_open = true; Some(AppEvent::HelpVisibilityChanged(true)) }
            AppAction::CloseHelp if self.help_open => { self.help_open = false; Some(AppEvent::HelpVisibilityChanged(false)) }
            AppAction::SetSurface(surface) if self.surface != surface => { self.surface = surface; self.features = FeatureFlags::default(); Some(AppEvent::SurfaceChanged(surface)) }
            AppAction::SetFeatureEnabled { flag, enabled } => {
                let next = self.features.enabled(self.surface, flag);
                let wanted = match flag { FeatureFlag::HardwareWallet => enabled, FeatureFlag::CashFusion | FeatureFlag::WatchOnly => enabled && FeatureFlags::surface_allows(self.surface, flag) };
                if next == wanted { return None; }
                match flag { FeatureFlag::CashFusion => self.features.cash_fusion = Some(wanted), FeatureFlag::HardwareWallet => self.features.hardware_wallet = Some(wanted), FeatureFlag::WatchOnly => self.features.watch_only = Some(wanted) }
                Some(AppEvent::FeatureFlagChanged { flag, enabled: wanted })
            }
            AppAction::InsertCoin(coin) => match self.coins.insert(coin) { Ok(()) => { self.notice = None; Some(AppEvent::CoinsChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::FreezeCoin(outpoint) => match self.coins.freeze(outpoint, FreezeReason::User) { Ok(()) => { self.notice = None; Some(AppEvent::CoinsChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::UnfreezeCoin(outpoint) => match self.coins.unfreeze(outpoint) { Ok(reason) => { if reason == FreezeReason::FlipstarterPledge { if let Some(pledge) = self.pledges.iter_mut().find(|pledge| pledge.outpoint == outpoint) { pledge.status = PledgeStatus::Cancelled { spend_to_self: true }; } } self.notice = None; Some(AppEvent::CoinsChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::SetCoinLabel { outpoint, label } => match self.coins.set_label(outpoint, label) { Ok(()) => { self.notice = None; Some(AppEvent::CoinsChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::PrepareFlipstarterPledge { blob, now_unix } => match optn_core::flipstarter::prepare_pledge(&mut self.coins, &mut self.pledges, self.network, &blob, now_unix) { Ok(_) => { self.notice = None; Some(AppEvent::FlipstarterPledgesChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::CancelFlipstarterPledge(pledge_id) => match optn_core::flipstarter::cancel_pledge(&mut self.coins, &mut self.pledges, pledge_id) { Ok(_) => { self.notice = None; Some(AppEvent::FlipstarterPledgesChanged) }, Err(error) => self.reject(error.to_string()) },
            AppAction::ClearNotice => if self.notice.is_none() { None } else { self.notice = None; Some(AppEvent::NoticeChanged) },
            AppAction::OpenCreatedWallet { name, receive_address, account_path } | AppAction::OpenImportedWallet { name, receive_address, account_path } => self.open_seed_wallet(name, receive_address, account_path),
            AppAction::OpenWatchOnlyWallet(preview) => { if !self.features.enabled(self.surface, FeatureFlag::WatchOnly) { return self.reject("Watch-only is turned off.".into()); } self.wallet = Some(OpenedWallet { kind: WalletKind::WatchOnly, name: preview.wallet_name, receive_address: preview.receive_address, master_fingerprint: preview.master_fingerprint, account_path: preview.account_path, multisig_policy: None, account_xpub: Some(preview.account_xpub) }); self.spend = None; self.notice = None; self.return_to = None; self.route = AppRoute::WalletHome; self.lock.mark_unlocked(); Some(AppEvent::WalletOpened) }
            AppAction::SetStealthSats(sats) => { if self.stealth_sats == sats { return None; } self.stealth_sats = sats; Some(AppEvent::CoinsChanged) }
            AppAction::HideWalletIdentity => { if !self.identity_revealed { return None; } self.identity_revealed = false; Some(AppEvent::AppLockChanged) }
            AppAction::SetServer { kind, entry } => match self.servers.set(self.network, kind, &entry) { Ok(_) => Some(AppEvent::ServersChanged), Err(message) => self.reject(message) },
            AppAction::UseNetworkDefaultServers => if self.servers.use_network_default(self.network) { Some(AppEvent::ServersChanged) } else { None },
            AppAction::SetFeeMode(mode) => {
                if self.fee_preferences.mode == mode { return None; }
                self.fee_preferences.mode = mode;
                Some(AppEvent::FeePreferencesChanged)
            }
            AppAction::SetCustomFeeRate(rate) => {
                let next = if rate.satoshis_per_kb() == 0 { DEFAULT_CUSTOM_FEE_RATE } else { rate };
                if self.fee_preferences.custom_rate == next { return None; }
                self.fee_preferences.custom_rate = next;
                Some(AppEvent::FeePreferencesChanged)
            }
            AppAction::SelectHardwareVendor(vendor) => { if self.hardware.vendor == vendor { return None; } self.hardware.disconnect(); self.hardware.vendor = vendor; if vendor != Some(HardwareVendor::Ledger) { self.hardware.ledger_link = LedgerLink::Usb; } Some(AppEvent::HardwareSessionChanged) }
            AppAction::SetLedgerLink(link) => { if !self.hardware.offers_link_choice() || self.hardware.ledger_link == link { return None; } self.hardware.ledger_link = link; Some(AppEvent::HardwareSessionChanged) }
            AppAction::SetHardwareDerivationPath(account) => { if self.hardware.vendor.is_none() { return self.reject("Choose a device first.".into()); } if self.hardware.derivation_path == account { return None; } self.hardware.derivation_path = account; self.hardware.account_xpub = None; Some(AppEvent::HardwareSessionChanged) }
            AppAction::HardwareConnected { label, account_xpub } => { if self.hardware.vendor.is_none() { return self.reject("Choose a device first.".into()); } self.hardware.connected = true; self.hardware.device_label = Some(label); self.hardware.account_xpub = Some(account_xpub); Some(AppEvent::HardwareSessionChanged) }
            AppAction::DisconnectHardware => { if !self.hardware.connected && self.hardware.device_label.is_none() { return None; } self.hardware.disconnect(); Some(AppEvent::HardwareSessionChanged) }
            AppAction::OpenMultisigWallet(preview) => { if !self.features.enabled(self.surface, FeatureFlag::WatchOnly) { return self.reject("Watch-only is turned off.".into()); } self.wallet = Some(OpenedWallet { kind: WalletKind::WatchOnly, name: preview.wallet_name, receive_address: preview.receive_address, master_fingerprint: None, account_path: AccountPath::default_for(self.network).to_string(), multisig_policy: Some(preview.policy), account_xpub: None }); self.spend = None; self.notice = None; self.return_to = None; self.route = AppRoute::WalletHome; self.lock.mark_unlocked(); Some(AppEvent::WalletOpened) }
            AppAction::OpenHardwareWallet(preview) => { if !self.features.enabled(self.surface, FeatureFlag::HardwareWallet) { return self.reject("Hardware wallets are not available here.".into()); } self.wallet = Some(OpenedWallet { kind: WalletKind::Hardware, name: preview.wallet_name, receive_address: preview.receive_address, master_fingerprint: preview.master_fingerprint, account_path: preview.account_path, multisig_policy: None, account_xpub: Some(preview.account_xpub) }); self.spend = None; self.notice = None; self.return_to = None; self.route = AppRoute::WalletHome; self.lock.mark_unlocked(); Some(AppEvent::WalletOpened) }
            AppAction::PrepareSend { destination, amount_sats, coin } => {
                let Some(wallet) = self.wallet.as_ref() else { return self.reject("open a wallet first".into()); };
                if self.surface.is_viewer_only() && wallet.spending_capability() == SpendingCapability::Seed { return self.reject("this build can view a wallet but not spend from it".into()); }
                let fee_rate = self.resolved_fee_rate();
                match prepare_spend_with_fee_and_coin(&self.coins, self.network, &destination, amount_sats, wallet.spending_capability(), fee_rate, coin) {
                    Ok(plan) => { self.spend = Some(plan); self.notice = None; if self.route.is_section_root() { self.return_to = Some(self.route); } self.route = AppRoute::Send; Some(AppEvent::SpendPrepared) },
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::RebuildWallet => { if self.wallet.is_none() { return self.reject("open a wallet first".into()); } self.coins.clear(); self.pledges.clear(); self.spend = None; self.notice = None; Some(AppEvent::WalletRebuilt) }
            AppAction::GoBack => self.go_back(), AppAction::AdvanceOnboarding => self.advance_onboarding(),
            AppAction::OpenSettingsRow(row) => { if self.route != AppRoute::Settings { return self.reject("open Settings first".into()); } if !settings_view_model(self).rows.contains(&row) { return self.reject("that setting is not available".into()); } if self.settings_focus == Some(row) { return None; } self.settings_focus = Some(row); Some(AppEvent::FlowChanged) }
            AppAction::SetWatchOnlyKind(kind) => { if self.route != AppRoute::WatchOnlyWallet { return self.reject("open Watch Only first".into()); } if self.watch_only_kind == kind { return None; } self.watch_only_kind = kind; self.multisig_step = MultisigStep::Policy; Some(AppEvent::FlowChanged) }
            AppAction::SetAutoLockMinutes(minutes) => { let next = AutoLockMinutes::from_minutes(minutes); if self.lock.auto_lock == next { return None; } self.lock.auto_lock = next; Some(AppEvent::AppLockChanged) }
            AppAction::LockWallet => self.lock_wallet(), AppAction::RecordActivity { now_ms } => { self.lock.record_activity(now_ms); None },
            AppAction::IdleCheck { now_ms } => { self.lock.observe(now_ms); if self.wallet.is_some() && self.lock.idle_should_lock(now_ms) { self.lock_wallet() } else { None } }
            AppAction::AuthorizeSpend { now_ms } => self.authorize(AuthScope::Spend, now_ms), AppAction::RequestReveal { now_ms } => self.authorize(AuthScope::Reveal, now_ms),
            AppAction::AuthorizeBackground { now_ms } => self.authorize(AuthScope::Background, now_ms), AppAction::AuthorizeChat { now_ms } => self.authorize(AuthScope::Chat, now_ms),
            AppAction::ConfirmAuth { now_ms } => { let scope = self.lock.prompt?; match scope { AuthScope::Spend => { self.lock.mark_spend_auth(now_ms); Some(AppEvent::SpendAuthorized) }, AuthScope::Reveal => { self.lock.prompt = None; self.identity_revealed = true; Some(AppEvent::AppLockChanged) }, AuthScope::Background | AuthScope::Chat => { self.lock.prompt = None; Some(AppEvent::AppLockChanged) } } }
            AppAction::CancelAuth => { self.lock.prompt?; self.lock.prompt = None; Some(AppEvent::AppLockChanged) }
            AppAction::SetNetwork(_) | AppAction::SetTheme(_) | AppAction::SetSkin(_) | AppAction::OpenHelp | AppAction::CloseHelp | AppAction::SetSurface(_) => None,
        }
    }

    fn open_seed_wallet(&mut self, name: String, receive_address: String, account_path: String) -> Option<AppEvent> {
        let name = name.trim(); if name.is_empty() { return self.reject("Give the wallet a name.".into()); } if receive_address.trim().is_empty() { return self.reject("Receive address is missing.".into()); }
        let Ok(account) = parse_account_path(&account_path) else { return self.reject(format!("'{account_path}' is not a BIP44 account path.")); };
        self.wallet = Some(OpenedWallet { kind: WalletKind::Seed, name: name.to_owned(), receive_address, master_fingerprint: None, account_path: account.to_string(), multisig_policy: None, account_xpub: None });
        self.spend = None; self.notice = None; self.return_to = None; self.route = AppRoute::WalletHome; self.lock.mark_unlocked(); Some(AppEvent::WalletOpened)
    }

    fn lock_wallet(&mut self) -> Option<AppEvent> {
        if self.wallet.is_none() && self.lock.prompt.is_none() { return None; }
        self.lock.lock(); self.identity_revealed = false; self.wallet = None; self.spend = None; self.coins.clear(); self.pledges.clear(); self.stealth_sats = 0; self.connect.cancel_all(); self.hardware.account_xpub = None; self.notice = None; self.settings_focus = None; self.return_to = None; self.route = AppRoute::Landing; Some(AppEvent::WalletLocked)
    }

    fn authorize(&mut self, scope: AuthScope, now_ms: u64) -> Option<AppEvent> {
        if self.wallet.is_none() { return self.reject("open a wallet first".into()); }
        if scope == AuthScope::Spend && self.surface.is_viewer_only() { return self.reject("this build can view a wallet but not spend from it".into()); }
        self.lock.observe(now_ms); let kind = self.wallet.as_ref().map(|wallet| wallet.kind);
        match self.lock.decide(scope, now_ms, kind) { AuthDecision::Allow => { if scope == AuthScope::Spend { self.lock.mark_spend_auth(now_ms); Some(AppEvent::SpendAuthorized) } else { None } }, AuthDecision::Prompt => { if self.lock.prompt == Some(scope) { return None; } self.lock.prompt = Some(scope); Some(AppEvent::AuthRequired) } }
    }

    fn pop_overlay(&mut self) -> Option<AppEvent> {
        let dest = match self.return_to.take().or_else(|| self.route.default_parent()) { Some(dest) => dest, None if self.wallet.is_some() => AppRoute::WalletHome, None => AppRoute::Landing };
        if self.route == dest { return None; } self.route = dest; Some(AppEvent::RouteChanged(dest))
    }

    fn go_back(&mut self) -> Option<AppEvent> {
        if self.lock.prompt.is_some() { self.lock.prompt = None; return Some(AppEvent::AppLockChanged); }
        match self.route {
            AppRoute::CreateWallet => match self.create_step.back() { Some(step) => { self.create_step = step; Some(AppEvent::FlowChanged) }, None => self.pop_overlay() },
            AppRoute::ImportWallet => match self.import_step.back() { Some(step) => { self.import_step = step; Some(AppEvent::FlowChanged) }, None => self.pop_overlay() },
            AppRoute::Settings if self.settings_focus.is_some() => { self.settings_focus = None; Some(AppEvent::FlowChanged) },
            AppRoute::Landing | AppRoute::WalletHome | AppRoute::Coins | AppRoute::Actions | AppRoute::Explore => None,
            AppRoute::WatchOnlyWallet if self.watch_only_kind == WatchOnlyKind::Shared => match self.multisig_step.back() { Some(step) => { self.multisig_step = step; Some(AppEvent::FlowChanged) }, None => { self.watch_only_kind = WatchOnlyKind::Single; Some(AppEvent::FlowChanged) } },
            AppRoute::WatchOnlyWallet | AppRoute::HardwareWallet | AppRoute::Receive | AppRoute::Send | AppRoute::History | AppRoute::Flipstarter | AppRoute::FundMe | AppRoute::Settings => self.pop_overlay(),
        }
    }

    fn advance_onboarding(&mut self) -> Option<AppEvent> {
        match self.route { AppRoute::CreateWallet => match self.create_step.next() { Some(step) => { self.create_step = step; Some(AppEvent::FlowChanged) }, None => self.reject("name the wallet, then open it.".into()) }, AppRoute::ImportWallet => match self.import_step.next() { Some(step) => { self.import_step = step; Some(AppEvent::FlowChanged) }, None => self.reject("name the wallet, then open it.".into()) }, AppRoute::WatchOnlyWallet if self.watch_only_kind == WatchOnlyKind::Shared => match self.multisig_step.next() { Some(step) => { self.multisig_step = step; Some(AppEvent::FlowChanged) }, None => self.reject("open the shared wallet from the confirmation.".into()) }, _ => self.reject("nothing to continue.".into()) }
    }

    fn reject(&mut self, message: String) -> Option<AppEvent> { if self.notice.as_deref() == Some(message.as_str()) { return Some(AppEvent::NoticeChanged); } self.notice = Some(message); Some(AppEvent::NoticeChanged) }
    pub fn apply(&mut self, action: AppAction) { let _ = self.reduce(action); }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingViewModel { pub network_prefix: &'static str, pub create_wallet_href: &'static str, pub import_wallet_href: &'static str, pub watch_only_wallet_href: &'static str, pub dark: bool, pub help_open: bool, pub show_cash_fusion: bool, pub show_hardware_wallet: bool, pub show_watch_only: bool }
pub fn onboarding_view_model(state: &AppState) -> OnboardingViewModel { OnboardingViewModel { network_prefix: state.network.prefix(), create_wallet_href: AppRoute::CreateWallet.fragment(), import_wallet_href: AppRoute::ImportWallet.fragment(), watch_only_wallet_href: AppRoute::WatchOnlyWallet.fragment(), dark: state.theme.is_dark_surface(), help_open: state.help_open, show_cash_fusion: state.features.enabled(state.surface, FeatureFlag::CashFusion), show_hardware_wallet: state.features.enabled(state.surface, FeatureFlag::HardwareWallet), show_watch_only: state.features.enabled(state.surface, FeatureFlag::WatchOnly) } }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardingAction { CreateWallet, ImportWallet, CreateWatchOnlyWallet, ConnectHardwareWallet }
impl OnboardingAction { pub const fn href(self) -> Option<&'static str> { match self { Self::CreateWallet => Some(AppRoute::CreateWallet.fragment()), Self::ImportWallet => Some(AppRoute::ImportWallet.fragment()), Self::CreateWatchOnlyWallet | Self::ConnectHardwareWallet => Some(AppRoute::WatchOnlyWallet.fragment()) } } pub const fn route(self) -> Option<AppRoute> { match self { Self::CreateWallet => Some(AppRoute::CreateWallet), Self::ImportWallet => Some(AppRoute::ImportWallet), Self::CreateWatchOnlyWallet | Self::ConnectHardwareWallet => Some(AppRoute::WatchOnlyWallet) } } }
pub fn onboarding_actions(state: &AppState) -> Vec<OnboardingAction> { let vm = onboarding_view_model(state); let mut actions = vec![OnboardingAction::CreateWallet, OnboardingAction::ImportWallet]; if vm.show_watch_only { actions.push(OnboardingAction::CreateWatchOnlyWallet); } if vm.show_hardware_wallet { actions.push(OnboardingAction::ConnectHardwareWallet); } actions }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductNavItem { Home, Assets, Actions, Receive, Explore, History, Settings }
impl ProductNavItem { pub const fn route(self) -> AppRoute { match self { Self::Home => AppRoute::WalletHome, Self::Assets => AppRoute::Coins, Self::Actions => AppRoute::Actions, Self::Receive => AppRoute::Receive, Self::Explore => AppRoute::Explore, Self::History => AppRoute::History, Self::Settings => AppRoute::Settings } } pub const fn label(self) -> &'static str { match self { Self::Home => "Home", Self::Assets => "Assets", Self::Actions => "Actions", Self::Receive => "Receive", Self::Explore => "Explore", Self::History => "History", Self::Settings => "Settings" } } pub fn is_active(self, route: AppRoute) -> bool { match self { Self::Home => route == AppRoute::WalletHome, Self::Assets => route == AppRoute::Coins, Self::Actions => matches!(route, AppRoute::Actions | AppRoute::Flipstarter), Self::Receive => route == AppRoute::Receive, Self::Explore => matches!(route, AppRoute::Explore | AppRoute::FundMe), Self::History => route == AppRoute::History, Self::Settings => route == AppRoute::Settings } } }
pub fn product_nav(state: &AppState) -> Vec<ProductNavItem> { match state.surface { AppSurface::Extension => vec![ProductNavItem::Home, ProductNavItem::Assets, ProductNavItem::Receive, ProductNavItem::History], _ => vec![ProductNavItem::Home, ProductNavItem::Assets, ProductNavItem::Actions, ProductNavItem::Explore, ProductNavItem::Settings] } }

pub fn qr_fragment_options(surface: AppSurface) -> &'static [usize] { match surface { AppSurface::Desktop | AppSurface::Web => SeedCashQr::FRAGMENT_OPTIONS, _ => MOBILE_FRAGMENT_OPTIONS } }
pub fn qr_fragment_label(surface: AppSurface, fragment: usize) -> Option<&'static str> { match surface { AppSurface::Desktop | AppSurface::Web => SeedCashQr::fragment_label(fragment), _ => mobile_fragment_label(fragment) } }
pub fn default_qr_fragment(surface: AppSurface) -> usize { qr_fragment_options(surface).first().copied().unwrap_or(SeedCashQr::CHUNK_SIZE) }
pub const CHIPNET_FAUCET_URL: &str = "https://tbch.googol.cash/";
pub fn format_bch(sats: u64) -> String { format!("{}.{:08} BCH", sats / 100_000_000, sats % 100_000_000) }

#[derive(Debug, Clone, PartialEq, Eq)] pub struct CoinsViewModel { pub layout: LayoutKind, pub spendable_sats: u64, pub reserved_sats: u64, pub coins: Vec<Coin> }
pub fn portfolio_totals(state: &AppState) -> PortfolioTotals { PortfolioTotals { spendable_sats: state.coins.spendable_sats(), reserved_sats: state.coins.reserved_sats(), stealth_sats: state.stealth_sats } }
pub fn coins_view_model(state: &AppState) -> CoinsViewModel { CoinsViewModel { layout: state.layout(), spendable_sats: state.coins.spendable_sats(), reserved_sats: state.coins.reserved_sats(), coins: state.coins.iter().cloned().collect() } }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct FlipstarterViewModel { pub layout: LayoutKind, pub network: Network, pub pledges: Vec<FlipstarterPledge>, pub spendable_sats: u64, pub sighash: u8 }
pub fn flipstarter_view_model(state: &AppState) -> FlipstarterViewModel { FlipstarterViewModel { layout: state.layout(), network: state.network, pledges: state.pledges.clone(), spendable_sats: state.coins.spendable_sats(), sighash: optn_core::flipstarter::PLEDGE_SIGHASH } }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct FundMeViewModel { pub layout: LayoutKind, pub product: FundMeProduct, pub available: bool }
pub fn fundme_view_model(state: &AppState) -> FundMeViewModel { let product = state.fundme(); FundMeViewModel { layout: state.layout(), product, available: !matches!(product.status, FundMeStatus::Unavailable) } }

#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum HistoryKind { Received, PendingSend }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct HistoryEntry { pub kind: HistoryKind, pub txid: String, pub amount_sats: u64, pub address: String, pub reserved: bool }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct HistoryViewModel { pub layout: LayoutKind, pub entries: Vec<HistoryEntry> }
pub fn history_view_model(state: &AppState) -> HistoryViewModel { let mut entries: Vec<_> = state.coins.iter().map(|coin| HistoryEntry { kind: HistoryKind::Received, txid: coin.outpoint().txid_hex(), amount_sats: coin.value_sats(), address: coin.address().to_owned(), reserved: coin.is_reserved() }).collect(); if let Some(plan) = state.spend.as_ref() { entries.push(HistoryEntry { kind: HistoryKind::PendingSend, txid: plan.selected.txid_hex(), amount_sats: plan.amount_sats, address: plan.destination.clone(), reserved: false }); } HistoryViewModel { layout: state.layout(), entries } }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsRowId { Network, Faucet, WalletInfo, Derivation, Recovery, AppLock, RebuildWallet, Servers, Device, CashFusion }
impl SettingsRowId { pub const fn title(self) -> &'static str { match self { Self::Network => "Network", Self::Faucet => "Chipnet Faucet", Self::WalletInfo => "Wallet info", Self::Derivation => "Derivation Path", Self::Recovery => "Recovery Phrase", Self::AppLock => "App lock", Self::RebuildWallet => "Rebuild Wallet", Self::Servers => "Servers", Self::Device => "Hardware device", Self::CashFusion => "CashFusion" } } pub const fn description(self) -> &'static str { match self { Self::Network => "Switch between Mainnet and Chipnet", Self::Faucet => "Get test BCH on Chipnet", Self::WalletInfo => "Name, type, network, and receive address", Self::Derivation => "Active BIP44 account path", Self::Recovery => "Back up your wallet", Self::AppLock => "Auto-lock · Password on send", Self::RebuildWallet => "Wipe chain data and resync from network (keeps seed)", Self::Servers => "Electrum · Block explorer · Transaction fees", Self::Device => "Connected signer, its label, and how it is reached", Self::CashFusion => "Privacy mixing on desktop" } } }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsViewModel {
    pub layout: LayoutKind, pub network: Network, pub faucet_url: Option<&'static str>, pub wallet_name: Option<String>, pub wallet_kind: Option<WalletKind>, pub receive_address: Option<String>, pub derivation_path: String,
    pub electrum_host: &'static str, pub electrum_endpoint: String, pub servers_are_custom: bool,
    pub fee_preferences: FeePreferences, pub relay_minimum_fee_rate: FeeRate,
    pub hardware: HardwareSessionState, pub hardware_derivation_path: String, pub hardware_path_warning: Option<String>, pub show_cash_fusion: bool, pub rows: Vec<SettingsRowId>,
}

pub fn settings_view_model(state: &AppState) -> SettingsViewModel {
    let faucet_url = matches!(state.network, Network::Chipnet).then_some(CHIPNET_FAUCET_URL);
    let mut rows = vec![SettingsRowId::Network]; if faucet_url.is_some() { rows.push(SettingsRowId::Faucet); }
    rows.extend([SettingsRowId::WalletInfo, SettingsRowId::Derivation, SettingsRowId::Recovery, SettingsRowId::AppLock, SettingsRowId::RebuildWallet, SettingsRowId::Servers]);
    if state.features.enabled(state.surface, FeatureFlag::HardwareWallet) { rows.push(SettingsRowId::Device); }
    let show_cash_fusion = state.features.enabled(state.surface, FeatureFlag::CashFusion); if show_cash_fusion { rows.push(SettingsRowId::CashFusion); }
    SettingsViewModel {
        layout: state.layout(), network: state.network, faucet_url, wallet_name: state.wallet.as_ref().map(|w| w.name.clone()), wallet_kind: state.wallet.as_ref().map(|w| w.kind), receive_address: state.wallet.as_ref().map(|w| w.receive_address.clone()),
        derivation_path: state.wallet.as_ref().map(|w| w.account_path.clone()).unwrap_or_else(|| AccountPath::default_for(state.network).to_string()),
        electrum_host: state.network.default_host(), electrum_endpoint: state.servers.effective_electrum(state.network), servers_are_custom: !state.servers.for_network(state.network).is_empty(),
        fee_preferences: state.fee_preferences, relay_minimum_fee_rate: RELAY_MINIMUM_FEE_RATE,
        hardware_derivation_path: { let wallet_account = state.wallet.as_ref().and_then(|w| parse_account_path(&w.account_path).ok()).unwrap_or_else(|| AccountPath::default_for(state.network)); state.hardware.effective_path(wallet_account).path() },
        hardware_path_warning: state.hardware.path_warning(state.network).map(|account| format!("{} is not an account this wallet scans on {}. It is kept as chosen.", account.path(), state.network)),
        hardware: state.hardware.clone(), show_cash_fusion, rows,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)] pub struct WatchOnlySetupPreview { pub wallet_name: String, pub account_xpub: String, pub master_fingerprint: Option<String>, pub account_path: String, pub receive_address: String, pub receive_token_address: String, pub change_address: String }
pub fn watch_only_setup_preview(network: Network, wallet_name: &str, account_xpub: &str, master_fingerprint: &str) -> Result<WatchOnlySetupPreview, String> { let wallet_name = wallet_name.trim(); if wallet_name.is_empty() { return Err("Give the wallet a name.".into()); } if wallet_name.chars().count() > 80 { return Err("Wallet name is too long.".into()); } let fingerprint = optn_core::watch_only::normalize_master_fingerprint(master_fingerprint).map_err(|e| e.to_string())?; let preview = optn_core::watch_only::account_preview(network, account_xpub).map_err(|e| e.to_string())?; Ok(WatchOnlySetupPreview { wallet_name: wallet_name.to_owned(), account_xpub: account_xpub.trim().to_owned(), master_fingerprint: fingerprint, account_path: preview.account_path, receive_address: preview.receive.address, receive_token_address: preview.receive.token_address, change_address: preview.change.address }) }

pub use optn_platform::{HardwareTransport, HardwareVendor, TransportSupport};
pub use optn_core::airgap::{classify_scanned_account, AccountEntry, ScannedAccount};
pub use optn_core::multisig::{Cosigner, MultisigPreview, MAX_COSIGNERS};
pub use optn_core::psbt::{mobile_fragment_label, QrAnimation, SeedCashQr, MOBILE_FRAGMENT_OPTIONS};

pub fn transport_support(surface: AppSurface) -> TransportSupport { match surface { AppSurface::Desktop => TransportSupport { native_usb: true, native_ble: true, camera: true, micro_sd: true, iframe: true, ..TransportSupport::NONE }, AppSurface::Android => TransportSupport { native_usb: true, native_ble: true, nfc: true, camera: true, ..TransportSupport::NONE }, AppSurface::Ios => TransportSupport { native_ble: true, nfc: true, camera: true, ..TransportSupport::NONE }, AppSurface::Web => TransportSupport { web_hid: true, web_usb: true, web_ble: true, camera: true, iframe: true, ..TransportSupport::NONE }, AppSurface::Extension => TransportSupport { web_hid: true, web_usb: true, camera: true, ..TransportSupport::NONE } } }

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HardwareSessionState { pub vendor: Option<HardwareVendor>, pub connected: bool, pub device_label: Option<String>, pub account_xpub: Option<String>, pub derivation_path: Option<AccountPath>, pub ledger_link: LedgerLink }
impl HardwareSessionState { pub const fn new() -> Self { Self { vendor: None, connected: false, device_label: None, account_xpub: None, derivation_path: None, ledger_link: LedgerLink::Usb } } pub fn offers_link_choice(&self) -> bool { matches!(self.vendor, Some(HardwareVendor::Ledger)) } pub fn effective_path(&self, wallet_account: AccountPath) -> AccountPath { self.derivation_path.unwrap_or(wallet_account) } pub fn path_warning(&self, network: Network) -> Option<AccountPath> { self.derivation_path.filter(|a| !a.is_scanned_for(network)) } pub fn disconnect(&mut self) { self.connected = false; self.device_label = None; self.account_xpub = None; } }
pub use optn_platform::LedgerLink;

#[derive(Debug, Clone, PartialEq, Eq)] pub struct MultisigSetupPreview { pub wallet_name: String, pub policy: String, pub required: u8, pub total: u8, pub receive_address: String, pub receive_token_address: String, pub change_address: String, pub cosigner_names: Vec<String> }
pub fn multisig_setup_preview(network: Network, wallet_name: &str, required: u8, cosigners: &[Cosigner]) -> Result<MultisigSetupPreview, String> { let wallet_name = wallet_name.trim(); if wallet_name.is_empty() { return Err("Give the wallet a name.".into()); } let preview = optn_core::multisig::multisig_preview(network, required, cosigners).map_err(|e| e.to_string())?; Ok(MultisigSetupPreview { wallet_name: wallet_name.to_owned(), policy: preview.policy, required: preview.required, total: preview.total, receive_address: preview.receive.address, receive_token_address: preview.receive.token_address, change_address: preview.change.address, cosigner_names: preview.cosigner_names }) }

#[derive(Debug, Clone, PartialEq, Eq)] pub struct HardwareSetupPreview { pub vendor: HardwareVendor, pub wallet_name: String, pub account_xpub: String, pub master_fingerprint: Option<String>, pub account_path: String, pub receive_address: String, pub receive_token_address: String, pub change_address: String }
pub fn hardware_setup_preview(network: Network, vendor: HardwareVendor, wallet_name: &str, account_xpub: &str, master_fingerprint: &str) -> Result<HardwareSetupPreview, String> { if !HardwareVendor::OFFERED.contains(&vendor) { return Err(format!("{} is not a supported device.", vendor.label())); } let watch = watch_only_setup_preview(network, wallet_name, account_xpub, master_fingerprint)?; Ok(HardwareSetupPreview { vendor, wallet_name: watch.wallet_name, account_xpub: watch.account_xpub, master_fingerprint: watch.master_fingerprint, account_path: watch.account_path, receive_address: watch.receive_address, receive_token_address: watch.receive_token_address, change_address: watch.change_address }) }

#[derive(Debug, Clone, PartialEq, Eq)] pub struct HardwareViewModel { pub layout: LayoutKind, pub network: Network, pub vendors: Vec<HardwareVendor>, pub available: bool }
pub const fn hardware_integration_ready(vendor: HardwareVendor, surface: AppSurface) -> bool { matches!((vendor, surface), (HardwareVendor::Keystone, _) | (HardwareVendor::Ledger | HardwareVendor::OneKey, AppSurface::Desktop | AppSurface::Web | AppSurface::Extension) | (HardwareVendor::Trezor, AppSurface::Desktop)) }
pub fn hardware_vendors_for(surface: AppSurface) -> Vec<HardwareVendor> { let support = transport_support(surface); HardwareVendor::OFFERED.iter().copied().filter(|v| v.is_reachable_with(support)).filter(|v| hardware_integration_ready(*v, surface)).collect() }
pub fn hardware_view_model(state: &AppState) -> HardwareViewModel { let available = state.features.enabled(state.surface, FeatureFlag::HardwareWallet); HardwareViewModel { layout: state.layout(), network: state.network, vendors: if available { hardware_vendors_for(state.surface) } else { Vec::new() }, available } }

pub fn seed_wallet_preview(network: Network, wallet_name: &str, mnemonic: &str) -> Result<OpenedWallet, String> { seed_wallet_preview_at(network, wallet_name, mnemonic, AccountPath::default_for(network)) }
pub fn seed_wallet_preview_at(network: Network, wallet_name: &str, mnemonic: &str, account: AccountPath) -> Result<OpenedWallet, String> { let wallet_name = wallet_name.trim(); if wallet_name.is_empty() { return Err("Give the wallet a name.".into()); } let receive_address = seed_receive_address_at(network, mnemonic, account).map_err(|e| e.to_string())?; Ok(OpenedWallet { kind: WalletKind::Seed, name: wallet_name.to_owned(), receive_address, master_fingerprint: None, account_path: account.to_string(), multisig_policy: None, account_xpub: None }) }

#[cfg(test)]
mod tests {
    use super::*;

    fn open_chipnet_seed(state: &mut AppState, name: &str) {
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, name, BIP39_TEST_VECTOR_MNEMONIC).expect("seed preview");
        state.apply(AppAction::OpenCreatedWallet { name: opened.name, receive_address: opened.receive_address, account_path: opened.account_path });
    }

    fn dest() -> String { optn_core::cashaddr::Address::from_hash(Network::Chipnet.prefix(), optn_core::cashaddr::AddressKind::P2pkh, [0x7a; 20]).encode() }

    #[test]
    fn actions_are_framework_independent_state_transitions() {
        let mut state = AppState::default();
        assert_eq!(state.reduce(AppAction::ToggleTheme), Some(AppEvent::ThemeChanged(ThemeMode::Dark)));
        assert_eq!(state.reduce(AppAction::SetNetwork(Network::Chipnet)), Some(AppEvent::NetworkChanged(Network::Chipnet)));
        assert_eq!(state.reduce(AppAction::OpenHelp), Some(AppEvent::HelpVisibilityChanged(true)));
        assert_eq!(state.reduce(AppAction::Navigate(AppRoute::ImportWallet)), Some(AppEvent::RouteChanged(AppRoute::ImportWallet)));
    }

    #[test]
    fn app_fee_preferences_are_typed_app_state_and_prepare_send_records_them() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        assert_eq!(state.fee_preferences, FeePreferences::app_default());
        assert_eq!(state.resolved_fee_rate(), RELAY_MINIMUM_FEE_RATE);
        assert_eq!(settings_view_model(&state).fee_preferences.mode, FeeMode::Auto);

        assert_eq!(state.reduce(AppAction::SetFeeMode(FeeMode::Custom)), Some(AppEvent::FeePreferencesChanged));
        let custom = FeeRate::from_satoshis_per_kb(1700);
        assert_eq!(state.reduce(AppAction::SetCustomFeeRate(custom)), Some(AppEvent::FeePreferencesChanged));
        assert_eq!(state.resolved_fee_rate(), custom);

        open_chipnet_seed(&mut state, "fees");
        state.apply(AppAction::InsertCoin(chipnet_demo_coin(20_000, 1).expect("coin")));
        state.apply(AppAction::PrepareSend { destination: dest(), amount_sats: 5_000, coin: None });
        assert_eq!(state.spend.as_ref().map(|p| p.fee_rate), Some(custom));
        assert_eq!(state.spend.as_ref().map(|p| p.fee_for_serialized_bytes(250)), Some(425));
    }

    #[test]
    fn custom_fee_cannot_bypass_relay_floor_and_zero_restores_editor_default() {
        let mut state = AppState::default();
        state.apply(AppAction::SetFeeMode(FeeMode::Custom));
        state.apply(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(500)));
        assert_eq!(state.resolved_fee_rate(), RELAY_MINIMUM_FEE_RATE);
        state.apply(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(0)));
        assert_eq!(state.fee_preferences.custom_rate, DEFAULT_CUSTOM_FEE_RATE);
    }

    #[test]
    fn watch_only_is_offered_everywhere_and_extension_seed_spending_fails_closed() {
        for surface in [AppSurface::Desktop, AppSurface::Android, AppSurface::Ios, AppSurface::Web, AppSurface::Extension] { assert!(surface.offers_watch_only()); }
        let mut viewer = AppState::for_surface(AppSurface::Extension); open_chipnet_seed(&mut viewer, "hot"); viewer.apply(AppAction::PrepareSend { destination: viewer.wallet.as_ref().unwrap().receive_address.clone(), amount_sats: 1000, coin: None }); assert!(viewer.spend.is_none());
    }

    #[test]
    fn server_override_is_network_scoped() {
        let mut state = AppState::default(); state.apply(AppAction::SetServer { kind: ServerKind::Electrum, entry: "main.example:50002".into() }); assert!(settings_view_model(&state).servers_are_custom); state.apply(AppAction::SetNetwork(Network::Chipnet)); assert!(!settings_view_model(&state).servers_are_custom);
    }

    #[test]
    fn hardware_and_watch_only_plans_remain_unsigned() {
        let mut watch = AppState::for_surface(AppSurface::Ios); watch.apply(AppAction::SetNetwork(Network::Chipnet)); let wallet = optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").unwrap(); let xpub = wallet.account_xpub(Network::Chipnet, 0).unwrap(); let preview = watch_only_setup_preview(Network::Chipnet, "watch", &xpub, "").unwrap(); watch.apply(AppAction::OpenWatchOnlyWallet(preview)); watch.apply(AppAction::InsertCoin(chipnet_demo_coin(8_000, 2).unwrap())); watch.apply(AppAction::PrepareSend { destination: dest(), amount_sats: 2_000, coin: None }); assert_eq!(watch.spend.as_ref().unwrap().kind, SpendKind::WatchOnlyUnsignedPsbt);
    }
}
