#![forbid(unsafe_code)]

//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch typed actions. Runtime/shell
//! adapters may subscribe to typed events. No UI or native-shell framework
//! belongs in this crate.

pub use optn_core::coins::{Coin, CoinSet, FreezeReason, Outpoint};
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
    prepare_spend, sign_seed_spend, SpendKind, SpendPlan, SpendingCapability, SIGHASH_ALL_FORKID,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    /// Light surfaces, dark text.
    Light,
    /// Charcoal everyday dark. Not OLED black.
    Gray,
    /// OPTN brand green.
    Green,
    /// True black / OLED.
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

/// Visual language on top of a theme mode. Not a second wallet.
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

/// Build/runtime surface. Feature flags are booleans derived from this, then
/// optionally turned off by the user. Hardware wallets stay desktop-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppSurface {
    Desktop,
    Android,
    Ios,
    Web,
    Extension,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureFlag {
    CashFusion,
    HardwareWallet,
    WatchOnly,
}

/// User overrides. `None` means "use the surface default" — not a nullable bool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureFlags {
    pub cash_fusion: Option<bool>,
    pub hardware_wallet: Option<bool>,
    pub watch_only: Option<bool>,
}

impl FeatureFlags {
    /// Hardware wallets and CashFusion are desktop-only flags.
    /// Watch Only is allowed on every surface; a false override hides it.
    pub const fn surface_allows(surface: AppSurface, flag: FeatureFlag) -> bool {
        match flag {
            FeatureFlag::CashFusion | FeatureFlag::HardwareWallet => {
                matches!(surface, AppSurface::Desktop)
            }
            FeatureFlag::WatchOnly => true,
        }
    }

    pub fn enabled(self, surface: AppSurface, flag: FeatureFlag) -> bool {
        if !Self::surface_allows(surface, flag) {
            return false;
        }
        match flag {
            FeatureFlag::CashFusion => self.cash_fusion.unwrap_or(true),
            FeatureFlag::HardwareWallet => self.hardware_wallet.unwrap_or(true),
            FeatureFlag::WatchOnly => self.watch_only.unwrap_or(true),
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
}

/// Product layout. Desktop gets a wide shell; every other surface is stacked.
/// Do not derive this from CSS breakpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutKind {
    Desktop,
    Compact,
}

impl LayoutKind {
    pub const fn from_surface(surface: AppSurface) -> Self {
        match surface {
            AppSurface::Desktop => Self::Desktop,
            AppSurface::Android | AppSurface::Ios | AppSurface::Web | AppSurface::Extension => {
                Self::Compact
            }
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
}

/// Public session for an opened wallet. The mnemonic never lives here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletKind {
    Seed,
    WatchOnly,
    /// Public keys here, private key on a connected device. Distinct from
    /// WatchOnly: this wallet can spend, it just cannot sign locally.
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedWallet {
    pub kind: WalletKind,
    pub name: String,
    pub receive_address: String,
    pub master_fingerprint: Option<String>,
    /// The BIP44 account this wallet was opened at, as text. Settings shows
    /// it, and it is what a rescan or an air-gapped signer has to agree with,
    /// so it follows the wallet rather than being recomputed from the network.
    pub account_path: String,
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
            features: FeatureFlags {
                cash_fusion: None,
                hardware_wallet: None,
                watch_only: None,
            },
            coins: CoinSet::new(),
            pledges: Vec::new(),
            notice: None,
            wallet: None,
            spend: None,
        }
    }

    pub const fn layout(&self) -> LayoutKind {
        LayoutKind::from_surface(self.surface)
    }

    pub fn fundme(&self) -> FundMeProduct {
        optn_core::fundme::product()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppAction {
    Navigate(AppRoute),
    ToggleTheme,
    SetTheme(ThemeMode),
    SetSkin(UiSkin),
    SetNetwork(Network),
    OpenHelp,
    CloseHelp,
    SetSurface(AppSurface),
    SetFeatureEnabled {
        flag: FeatureFlag,
        enabled: bool,
    },
    InsertCoin(Coin),
    FreezeCoin(Outpoint),
    UnfreezeCoin(Outpoint),
    SetCoinLabel {
        outpoint: Outpoint,
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
        account_path: String,
    },
    OpenImportedWallet {
        name: String,
        receive_address: String,
        account_path: String,
    },
    OpenWatchOnlyWallet(WatchOnlySetupPreview),
    OpenHardwareWallet(HardwareSetupPreview),
    PrepareSend {
        destination: String,
        amount_sats: u64,
    },
    RebuildWallet,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    RouteChanged(AppRoute),
    ThemeChanged(ThemeMode),
    SkinChanged(UiSkin),
    NetworkChanged(Network),
    HelpVisibilityChanged(bool),
    SurfaceChanged(AppSurface),
    FeatureFlagChanged { flag: FeatureFlag, enabled: bool },
    CoinsChanged,
    FlipstarterPledgesChanged,
    NoticeChanged,
    WalletOpened,
    SpendPrepared,
    WalletRebuilt,
}

impl AppState {
    /// Apply one typed action and return the observable domain/application event
    /// produced by the state transition. No event is emitted for a no-op.
    pub fn reduce(&mut self, action: AppAction) -> Option<AppEvent> {
        match action {
            AppAction::Navigate(route) => {
                if route.is_wallet_chrome() && self.wallet.is_none() {
                    return self
                        .reject("Create, import, or open a watch-only wallet first.".into());
                }
                if route == AppRoute::WatchOnlyWallet
                    && !self.features.enabled(self.surface, FeatureFlag::WatchOnly)
                {
                    return self.reject("Watch-only is turned off.".into());
                }
                if route == AppRoute::HardwareWallet
                    && !self
                        .features
                        .enabled(self.surface, FeatureFlag::HardwareWallet)
                {
                    return self.reject("Hardware wallets are not available here.".into());
                }
                if self.route == route {
                    return None;
                }
                self.route = route;
                Some(AppEvent::RouteChanged(route))
            }
            AppAction::ToggleTheme => {
                self.theme = self.theme.next();
                Some(AppEvent::ThemeChanged(self.theme))
            }
            AppAction::SetTheme(theme) if self.theme != theme => {
                self.theme = theme;
                Some(AppEvent::ThemeChanged(theme))
            }
            AppAction::SetSkin(skin) if self.skin != skin => {
                self.skin = skin;
                Some(AppEvent::SkinChanged(skin))
            }
            AppAction::SetNetwork(network) if self.network != network => {
                self.network = network;
                Some(AppEvent::NetworkChanged(network))
            }
            AppAction::OpenHelp if !self.help_open => {
                self.help_open = true;
                Some(AppEvent::HelpVisibilityChanged(true))
            }
            AppAction::CloseHelp if self.help_open => {
                self.help_open = false;
                Some(AppEvent::HelpVisibilityChanged(false))
            }
            AppAction::SetSurface(surface) if self.surface != surface => {
                self.surface = surface;
                self.features = FeatureFlags::default();
                Some(AppEvent::SurfaceChanged(surface))
            }
            AppAction::SetFeatureEnabled { flag, enabled } => {
                let next = self.features.enabled(self.surface, flag);
                let wanted = enabled && FeatureFlags::surface_allows(self.surface, flag);
                if next == wanted {
                    return None;
                }
                match flag {
                    FeatureFlag::CashFusion => self.features.cash_fusion = Some(wanted),
                    FeatureFlag::HardwareWallet => self.features.hardware_wallet = Some(wanted),
                    FeatureFlag::WatchOnly => self.features.watch_only = Some(wanted),
                }
                Some(AppEvent::FeatureFlagChanged {
                    flag,
                    enabled: wanted,
                })
            }
            AppAction::InsertCoin(coin) => match self.coins.insert(coin) {
                Ok(()) => {
                    self.notice = None;
                    Some(AppEvent::CoinsChanged)
                }
                Err(error) => self.reject(error.to_string()),
            },
            AppAction::FreezeCoin(outpoint) => {
                match self.coins.freeze(outpoint, FreezeReason::User) {
                    Ok(()) => {
                        self.notice = None;
                        Some(AppEvent::CoinsChanged)
                    }
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::UnfreezeCoin(outpoint) => match self.coins.unfreeze(outpoint) {
                Ok(reason) => {
                    if reason == FreezeReason::FlipstarterPledge {
                        if let Some(pledge) = self
                            .pledges
                            .iter_mut()
                            .find(|pledge| pledge.outpoint == outpoint)
                        {
                            pledge.status = PledgeStatus::Cancelled {
                                spend_to_self: true,
                            };
                        }
                    }
                    self.notice = None;
                    Some(AppEvent::CoinsChanged)
                }
                Err(error) => self.reject(error.to_string()),
            },
            AppAction::SetCoinLabel { outpoint, label } => {
                match self.coins.set_label(outpoint, label) {
                    Ok(()) => {
                        self.notice = None;
                        Some(AppEvent::CoinsChanged)
                    }
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::PrepareFlipstarterPledge { blob, now_unix } => {
                match optn_core::flipstarter::prepare_pledge(
                    &mut self.coins,
                    &mut self.pledges,
                    self.network,
                    &blob,
                    now_unix,
                ) {
                    Ok(_) => {
                        self.notice = None;
                        Some(AppEvent::FlipstarterPledgesChanged)
                    }
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::CancelFlipstarterPledge(pledge_id) => {
                match optn_core::flipstarter::cancel_pledge(
                    &mut self.coins,
                    &mut self.pledges,
                    pledge_id,
                ) {
                    Ok(_) => {
                        self.notice = None;
                        Some(AppEvent::FlipstarterPledgesChanged)
                    }
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::ClearNotice => {
                if self.notice.is_none() {
                    None
                } else {
                    self.notice = None;
                    Some(AppEvent::NoticeChanged)
                }
            }
            AppAction::OpenCreatedWallet {
                name,
                receive_address,
                account_path,
            } => self.open_seed_wallet(name, receive_address, account_path),
            AppAction::OpenImportedWallet {
                name,
                receive_address,
                account_path,
            } => self.open_seed_wallet(name, receive_address, account_path),
            AppAction::OpenWatchOnlyWallet(preview) => {
                if !self.features.enabled(self.surface, FeatureFlag::WatchOnly) {
                    return self.reject("Watch-only is turned off.".into());
                }
                self.wallet = Some(OpenedWallet {
                    kind: WalletKind::WatchOnly,
                    name: preview.wallet_name,
                    receive_address: preview.receive_address,
                    master_fingerprint: preview.master_fingerprint,
                    account_path: preview.account_path,
                });
                self.spend = None;
                self.notice = None;
                self.route = AppRoute::WalletHome;
                Some(AppEvent::WalletOpened)
            }
            AppAction::OpenHardwareWallet(preview) => {
                // Same gate as the route: a surface without USB must not end
                // up holding a wallet that can only be spent from a device.
                if !self
                    .features
                    .enabled(self.surface, FeatureFlag::HardwareWallet)
                {
                    return self.reject("Hardware wallets are not available here.".into());
                }
                self.wallet = Some(OpenedWallet {
                    kind: WalletKind::Hardware,
                    name: preview.wallet_name,
                    receive_address: preview.receive_address,
                    master_fingerprint: preview.master_fingerprint,
                    account_path: preview.account_path,
                });
                self.spend = None;
                self.notice = None;
                self.route = AppRoute::WalletHome;
                Some(AppEvent::WalletOpened)
            }
            AppAction::PrepareSend {
                destination,
                amount_sats,
            } => {
                let Some(wallet) = self.wallet.as_ref() else {
                    return self.reject("open a wallet first".into());
                };
                match prepare_spend(
                    &self.coins,
                    self.network,
                    &destination,
                    amount_sats,
                    wallet.spending_capability(),
                ) {
                    Ok(plan) => {
                        self.spend = Some(plan);
                        self.notice = None;
                        self.route = AppRoute::Send;
                        Some(AppEvent::SpendPrepared)
                    }
                    Err(error) => self.reject(error.to_string()),
                }
            }
            AppAction::RebuildWallet => {
                if self.wallet.is_none() {
                    return self.reject("open a wallet first".into());
                }
                self.coins.clear();
                self.pledges.clear();
                self.spend = None;
                self.notice = None;
                Some(AppEvent::WalletRebuilt)
            }
            AppAction::SetNetwork(_)
            | AppAction::SetTheme(_)
            | AppAction::SetSkin(_)
            | AppAction::OpenHelp
            | AppAction::CloseHelp
            | AppAction::SetSurface(_) => None,
        }
    }

    fn open_seed_wallet(
        &mut self,
        name: String,
        receive_address: String,
        account_path: String,
    ) -> Option<AppEvent> {
        let name = name.trim();
        if name.is_empty() {
            return self.reject("Give the wallet a name.".into());
        }
        if receive_address.trim().is_empty() {
            return self.reject("Receive address is missing.".into());
        }
        // An unparseable path would open a wallet whose Settings and whose
        // rescan disagree about which branch it lives on.
        let Ok(account) = parse_account_path(&account_path) else {
            return self.reject(format!("'{account_path}' is not a BIP44 account path."));
        };
        self.wallet = Some(OpenedWallet {
            kind: WalletKind::Seed,
            name: name.to_owned(),
            receive_address,
            master_fingerprint: None,
            account_path: account.to_string(),
        });
        self.spend = None;
        self.notice = None;
        self.route = AppRoute::WalletHome;
        Some(AppEvent::WalletOpened)
    }

    fn reject(&mut self, message: String) -> Option<AppEvent> {
        if self.notice.as_deref() == Some(message.as_str()) {
            return Some(AppEvent::NoticeChanged);
        }
        self.notice = Some(message);
        Some(AppEvent::NoticeChanged)
    }

    /// Convenience for callers that only care about the resulting state.
    pub fn apply(&mut self, action: AppAction) {
        let _ = self.reduce(action);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingViewModel {
    pub network_prefix: &'static str,
    pub create_wallet_href: &'static str,
    pub import_wallet_href: &'static str,
    pub watch_only_wallet_href: &'static str,
    pub dark: bool,
    pub help_open: bool,
    pub show_cash_fusion: bool,
    pub show_hardware_wallet: bool,
    pub show_watch_only: bool,
}

pub fn onboarding_view_model(state: &AppState) -> OnboardingViewModel {
    OnboardingViewModel {
        network_prefix: state.network.prefix(),
        create_wallet_href: AppRoute::CreateWallet.fragment(),
        import_wallet_href: AppRoute::ImportWallet.fragment(),
        watch_only_wallet_href: AppRoute::WatchOnlyWallet.fragment(),
        dark: state.theme.is_dark_surface(),
        help_open: state.help_open,
        show_cash_fusion: state
            .features
            .enabled(state.surface, FeatureFlag::CashFusion),
        show_hardware_wallet: state
            .features
            .enabled(state.surface, FeatureFlag::HardwareWallet),
        show_watch_only: state
            .features
            .enabled(state.surface, FeatureFlag::WatchOnly),
    }
}

/// Ordered landing CTAs. Renderers must draw this list; they must not invent a
/// Create/Import-only menu that drops Watch Only on Android/iOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnboardingAction {
    CreateWallet,
    ImportWallet,
    CreateWatchOnlyWallet,
    ConnectHardwareWallet,
}

impl OnboardingAction {
    pub const fn href(self) -> Option<&'static str> {
        match self {
            Self::CreateWallet => Some(AppRoute::CreateWallet.fragment()),
            Self::ImportWallet => Some(AppRoute::ImportWallet.fragment()),
            Self::CreateWatchOnlyWallet => Some(AppRoute::WatchOnlyWallet.fragment()),
            Self::ConnectHardwareWallet => Some(AppRoute::HardwareWallet.fragment()),
        }
    }

    pub const fn route(self) -> Option<AppRoute> {
        match self {
            Self::CreateWallet => Some(AppRoute::CreateWallet),
            Self::ImportWallet => Some(AppRoute::ImportWallet),
            Self::CreateWatchOnlyWallet => Some(AppRoute::WatchOnlyWallet),
            Self::ConnectHardwareWallet => Some(AppRoute::HardwareWallet),
        }
    }
}

pub fn onboarding_actions(state: &AppState) -> Vec<OnboardingAction> {
    let vm = onboarding_view_model(state);
    let mut actions = vec![
        OnboardingAction::CreateWallet,
        OnboardingAction::ImportWallet,
    ];
    if vm.show_watch_only {
        actions.push(OnboardingAction::CreateWatchOnlyWallet);
    }
    if vm.show_hardware_wallet {
        actions.push(OnboardingAction::ConnectHardwareWallet);
    }
    actions
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductNavItem {
    Home,
    Assets,
    Actions,
    Receive,
    Explore,
    History,
    Settings,
}

impl ProductNavItem {
    pub const fn route(self) -> AppRoute {
        match self {
            Self::Home => AppRoute::WalletHome,
            Self::Assets => AppRoute::Coins,
            Self::Actions => AppRoute::Actions,
            Self::Receive => AppRoute::Receive,
            Self::Explore => AppRoute::Explore,
            Self::History => AppRoute::History,
            Self::Settings => AppRoute::Settings,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Assets => "Assets",
            Self::Actions => "Actions",
            Self::Receive => "Receive",
            Self::Explore => "Explore",
            Self::History => "History",
            Self::Settings => "Settings",
        }
    }

    pub fn is_active(self, route: AppRoute) -> bool {
        match self {
            Self::Home => route == AppRoute::WalletHome,
            Self::Assets => route == AppRoute::Coins,
            Self::Actions => matches!(route, AppRoute::Actions | AppRoute::Flipstarter),
            Self::Receive => route == AppRoute::Receive,
            Self::Explore => matches!(route, AppRoute::Explore | AppRoute::FundMe),
            Self::History => route == AppRoute::History,
            Self::Settings => route == AppRoute::Settings,
        }
    }
}

/// Bottom-nav destinations for a surface.
///
/// Five on the product surfaces, matching `docs/ui-overhaul/A_home_single.png`
/// and issue #71 (`Home · Assets · Actions · Explore · Settings`). Recent
/// activity is a panel on Home with "View all", not a sixth tab — a sixth also
/// costs touch-target width at the 44px minimum the issue requires.
///
/// The extension popup is a constrained viewer, exactly as the React shell
/// treats it (`AppShell viewerOnly`): no Actions, no Settings, and Receive and
/// History take those slots instead. A popup is too small for the action and
/// settings flows, and porting that rule keeps the two shells consistent.
pub fn product_nav(state: &AppState) -> Vec<ProductNavItem> {
    match state.surface {
        AppSurface::Extension => vec![
            ProductNavItem::Home,
            ProductNavItem::Assets,
            ProductNavItem::Receive,
            ProductNavItem::History,
        ],
        AppSurface::Desktop | AppSurface::Android | AppSurface::Ios | AppSurface::Web => vec![
            ProductNavItem::Home,
            ProductNavItem::Assets,
            ProductNavItem::Actions,
            ProductNavItem::Explore,
            ProductNavItem::Settings,
        ],
    }
}

/// Chipnet faucet used by the TS wallet settings row.
pub const CHIPNET_FAUCET_URL: &str = "https://tbch.googol.cash/";

/// Display helper used by the home portfolio card. 1 BCH = 100_000_000 sats.
pub fn format_bch(sats: u64) -> String {
    let whole = sats / 100_000_000;
    let frac = sats % 100_000_000;
    format!("{whole}.{frac:08} BCH")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoinsViewModel {
    pub layout: LayoutKind,
    pub spendable_sats: u64,
    pub reserved_sats: u64,
    pub coins: Vec<Coin>,
}

pub fn coins_view_model(state: &AppState) -> CoinsViewModel {
    CoinsViewModel {
        layout: state.layout(),
        spendable_sats: state.coins.spendable_sats(),
        reserved_sats: state.coins.reserved_sats(),
        coins: state.coins.iter().cloned().collect(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlipstarterViewModel {
    pub layout: LayoutKind,
    pub network: Network,
    pub pledges: Vec<FlipstarterPledge>,
    pub spendable_sats: u64,
    pub sighash: u8,
}

pub fn flipstarter_view_model(state: &AppState) -> FlipstarterViewModel {
    FlipstarterViewModel {
        layout: state.layout(),
        network: state.network,
        pledges: state.pledges.clone(),
        spendable_sats: state.coins.spendable_sats(),
        sighash: optn_core::flipstarter::PLEDGE_SIGHASH,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FundMeViewModel {
    pub layout: LayoutKind,
    pub product: FundMeProduct,
    pub available: bool,
}

pub fn fundme_view_model(state: &AppState) -> FundMeViewModel {
    let product = state.fundme();
    FundMeViewModel {
        layout: state.layout(),
        product,
        available: !matches!(product.status, FundMeStatus::Unavailable),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryKind {
    Received,
    PendingSend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub kind: HistoryKind,
    pub txid: String,
    pub amount_sats: u64,
    pub address: String,
    pub reserved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryViewModel {
    pub layout: LayoutKind,
    pub entries: Vec<HistoryEntry>,
}

/// History is derived from opened coins and a pending spend. Rebuild clears it.
pub fn history_view_model(state: &AppState) -> HistoryViewModel {
    let mut entries: Vec<HistoryEntry> = state
        .coins
        .iter()
        .map(|coin| HistoryEntry {
            kind: HistoryKind::Received,
            txid: coin.outpoint().txid_hex(),
            amount_sats: coin.value_sats(),
            address: coin.address().to_owned(),
            reserved: coin.is_reserved(),
        })
        .collect();
    if let Some(plan) = state.spend.as_ref() {
        entries.push(HistoryEntry {
            kind: HistoryKind::PendingSend,
            txid: plan.selected.txid_hex(),
            amount_sats: plan.amount_sats,
            address: plan.destination.clone(),
            reserved: false,
        });
    }
    HistoryViewModel {
        layout: state.layout(),
        entries,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsRowId {
    Network,
    Faucet,
    WalletInfo,
    Derivation,
    Recovery,
    RebuildWallet,
    Servers,
    CashFusion,
}

impl SettingsRowId {
    pub const fn title(self) -> &'static str {
        match self {
            Self::Network => "Network",
            Self::Faucet => "Chipnet Faucet",
            Self::WalletInfo => "Wallet info",
            Self::Derivation => "Derivation Path",
            Self::Recovery => "Recovery Phrase",
            Self::RebuildWallet => "Rebuild Wallet",
            Self::Servers => "Servers",
            Self::CashFusion => "CashFusion",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Network => "Switch between Mainnet and Chipnet",
            Self::Faucet => "Get test BCH on Chipnet",
            Self::WalletInfo => "Name, type, network, and receive address",
            Self::Derivation => "Active BIP44 account path",
            Self::Recovery => "Back up your wallet",
            Self::RebuildWallet => "Wipe chain data and resync from network (keeps seed)",
            Self::Servers => "Electrum · Block explorer · Transaction fees",
            Self::CashFusion => "Privacy mixing on desktop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsViewModel {
    pub layout: LayoutKind,
    pub network: Network,
    pub faucet_url: Option<&'static str>,
    pub wallet_name: Option<String>,
    pub wallet_kind: Option<WalletKind>,
    pub receive_address: Option<String>,
    pub derivation_path: String,
    pub electrum_host: &'static str,
    pub show_cash_fusion: bool,
    pub rows: Vec<SettingsRowId>,
}

pub fn settings_view_model(state: &AppState) -> SettingsViewModel {
    let faucet_url = matches!(state.network, Network::Chipnet).then_some(CHIPNET_FAUCET_URL);
    let mut rows = vec![SettingsRowId::Network];
    if faucet_url.is_some() {
        rows.push(SettingsRowId::Faucet);
    }
    rows.extend([
        SettingsRowId::WalletInfo,
        SettingsRowId::Derivation,
        SettingsRowId::Recovery,
        SettingsRowId::RebuildWallet,
        SettingsRowId::Servers,
    ]);
    let show_cash_fusion = state
        .features
        .enabled(state.surface, FeatureFlag::CashFusion);
    if show_cash_fusion {
        rows.push(SettingsRowId::CashFusion);
    }
    SettingsViewModel {
        layout: state.layout(),
        network: state.network,
        faucet_url,
        wallet_name: state.wallet.as_ref().map(|wallet| wallet.name.clone()),
        wallet_kind: state.wallet.as_ref().map(|wallet| wallet.kind),
        receive_address: state
            .wallet
            .as_ref()
            .map(|wallet| wallet.receive_address.clone()),
        // The open wallet's own account, not a guess from the network. A
        // wallet opened at a non-default account must not read as default.
        derivation_path: state
            .wallet
            .as_ref()
            .map(|wallet| wallet.account_path.clone())
            .unwrap_or_else(|| AccountPath::default_for(state.network).to_string()),
        electrum_host: state.network.default_host(),
        show_cash_fusion,
        rows,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOnlySetupPreview {
    pub wallet_name: String,
    pub master_fingerprint: Option<String>,
    pub account_path: String,
    pub receive_address: String,
    pub receive_token_address: String,
    pub change_address: String,
}

/// Validate watch-only onboarding data in the application/domain layer.
///
/// Renderers submit strings; the shared core decides whether the account xPub
/// and optional master fingerprint are valid and derives the public preview.
pub fn watch_only_setup_preview(
    network: Network,
    wallet_name: &str,
    account_xpub: &str,
    master_fingerprint: &str,
) -> Result<WatchOnlySetupPreview, String> {
    let wallet_name = wallet_name.trim();
    if wallet_name.is_empty() {
        return Err("Give the wallet a name.".into());
    }
    if wallet_name.chars().count() > 80 {
        return Err("Wallet name is too long.".into());
    }

    let fingerprint = optn_core::watch_only::normalize_master_fingerprint(master_fingerprint)
        .map_err(|error| error.to_string())?;
    let preview = optn_core::watch_only::account_preview(network, account_xpub)
        .map_err(|error| error.to_string())?;

    Ok(WatchOnlySetupPreview {
        wallet_name: wallet_name.to_owned(),
        master_fingerprint: fingerprint,
        account_path: preview.account_path,
        receive_address: preview.receive.address,
        receive_token_address: preview.receive.token_address,
        change_address: preview.change.address,
    })
}

/// Vendors onboarding offers, surfaced from `optn-platform` so the renderer
/// does not keep its own list.
pub use optn_platform::HardwareVendor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareSetupPreview {
    pub vendor: HardwareVendor,
    pub wallet_name: String,
    pub master_fingerprint: Option<String>,
    pub account_path: String,
    pub receive_address: String,
    pub receive_token_address: String,
    pub change_address: String,
}

/// Validate an account exported from a hardware device.
///
/// A device hands over the same public material a watch-only import does — an
/// account xPub plus an optional fingerprint — so this reuses that validation
/// rather than duplicating it. What differs is the resulting wallet: it can
/// spend, because the device holds the key.
pub fn hardware_setup_preview(
    network: Network,
    vendor: HardwareVendor,
    wallet_name: &str,
    account_xpub: &str,
    master_fingerprint: &str,
) -> Result<HardwareSetupPreview, String> {
    if !HardwareVendor::OFFERED.contains(&vendor) {
        return Err(format!("{} is not a supported device.", vendor.label()));
    }
    let watch = watch_only_setup_preview(network, wallet_name, account_xpub, master_fingerprint)?;
    Ok(HardwareSetupPreview {
        vendor,
        wallet_name: watch.wallet_name,
        master_fingerprint: watch.master_fingerprint,
        account_path: watch.account_path,
        receive_address: watch.receive_address,
        receive_token_address: watch.receive_token_address,
        change_address: watch.change_address,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareViewModel {
    pub layout: LayoutKind,
    pub network: Network,
    /// Empty when the surface does not offer hardware wallets at all.
    pub vendors: Vec<HardwareVendor>,
    pub available: bool,
}

pub fn hardware_view_model(state: &AppState) -> HardwareViewModel {
    let available = state
        .features
        .enabled(state.surface, FeatureFlag::HardwareWallet);
    HardwareViewModel {
        layout: state.layout(),
        network: state.network,
        // No vendor list when the capability is off, so a renderer cannot
        // paint a device picker on a surface that has no USB.
        vendors: if available {
            HardwareVendor::OFFERED.to_vec()
        } else {
            Vec::new()
        },
        available,
    }
}

/// Derive a seed wallet's public receive address. The mnemonic is not stored.
pub fn seed_wallet_preview(
    network: Network,
    wallet_name: &str,
    mnemonic: &str,
) -> Result<OpenedWallet, String> {
    seed_wallet_preview_at(
        network,
        wallet_name,
        mnemonic,
        AccountPath::default_for(network),
    )
}

/// Derive a seed wallet's public receive address at a chosen BIP44 account.
///
/// The mnemonic is borrowed and not stored. The account travels with the
/// returned wallet so every later surface — Settings, receive, rescan — agrees
/// about which branch this wallet lives on.
pub fn seed_wallet_preview_at(
    network: Network,
    wallet_name: &str,
    mnemonic: &str,
    account: AccountPath,
) -> Result<OpenedWallet, String> {
    let wallet_name = wallet_name.trim();
    if wallet_name.is_empty() {
        return Err("Give the wallet a name.".into());
    }
    let receive_address =
        seed_receive_address_at(network, mnemonic, account).map_err(|error| error.to_string())?;
    Ok(OpenedWallet {
        kind: WalletKind::Seed,
        name: wallet_name.to_owned(),
        receive_address,
        master_fingerprint: None,
        account_path: account.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_framework_independent_state_transitions() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::ToggleTheme),
            Some(AppEvent::ThemeChanged(ThemeMode::Dark))
        );
        assert_eq!(
            state.reduce(AppAction::SetNetwork(Network::Chipnet)),
            Some(AppEvent::NetworkChanged(Network::Chipnet))
        );
        assert_eq!(
            state.reduce(AppAction::OpenHelp),
            Some(AppEvent::HelpVisibilityChanged(true))
        );
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::ImportWallet)),
            Some(AppEvent::RouteChanged(AppRoute::ImportWallet))
        );

        assert_eq!(state.theme, ThemeMode::Dark);
        assert_eq!(state.network, Network::Chipnet);
        assert!(state.help_open);
        assert_eq!(state.route, AppRoute::ImportWallet);
    }

    #[test]
    fn no_op_actions_emit_no_events() {
        let mut state = AppState::default();
        assert_eq!(state.reduce(AppAction::SetNetwork(Network::Mainnet)), None);
        assert_eq!(state.reduce(AppAction::CloseHelp), None);
        assert_eq!(state.reduce(AppAction::Navigate(AppRoute::Landing)), None);
    }

    proptest::proptest! {
        #[test]
        fn arbitrary_action_sequences_keep_view_model_consistent(
            actions in proptest::collection::vec(0u8..16, 0..256)
        ) {
            let mut state = AppState::default();

            for action in actions {
                let action = match action {
                    0 => AppAction::Navigate(AppRoute::Landing),
                    1 => AppAction::Navigate(AppRoute::CreateWallet),
                    2 => AppAction::Navigate(AppRoute::ImportWallet),
                    3 => AppAction::Navigate(AppRoute::WatchOnlyWallet),
                    4 => AppAction::Navigate(AppRoute::WalletHome),
                    5 => AppAction::Navigate(AppRoute::Coins),
                    6 => AppAction::Navigate(AppRoute::Actions),
                    7 => AppAction::Navigate(AppRoute::Explore),
                    8 => AppAction::Navigate(AppRoute::Settings),
                    9 => AppAction::Navigate(AppRoute::Flipstarter),
                    10 => AppAction::Navigate(AppRoute::FundMe),
                    11 => AppAction::Navigate(AppRoute::History),
                    12 => AppAction::ToggleTheme,
                    13 => AppAction::SetNetwork(Network::Mainnet),
                    14 => AppAction::SetNetwork(Network::Chipnet),
                    _ => if state.help_open {
                        AppAction::CloseHelp
                    } else {
                        AppAction::OpenHelp
                    },
                };
                state.apply(action);

                let vm = onboarding_view_model(&state);
                proptest::prop_assert_eq!(
                    vm.network_prefix,
                    state.network.prefix()
                );
                proptest::prop_assert_eq!(
                    vm.dark,
                    state.theme.is_dark_surface()
                );
                proptest::prop_assert_eq!(state.skin, state.skin);
                proptest::prop_assert_eq!(vm.help_open, state.help_open);
            }
        }
    }

    #[test]
    fn theme_and_skin_do_not_change_wallet_route_or_network() {
        let mut state = AppState::default();
        state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        assert_eq!(
            state.reduce(AppAction::SetTheme(ThemeMode::Gray)),
            Some(AppEvent::ThemeChanged(ThemeMode::Gray))
        );
        assert_eq!(
            state.reduce(AppAction::SetSkin(UiSkin::Cyberpunk)),
            Some(AppEvent::SkinChanged(UiSkin::Cyberpunk))
        );
        assert_eq!(state.route, AppRoute::WatchOnlyWallet);
        assert_eq!(state.network, Network::Chipnet);
        assert_eq!(state.theme, ThemeMode::Gray);
        assert_eq!(state.skin, UiSkin::Cyberpunk);
        assert_eq!(state.theme.next(), ThemeMode::Green);
        assert_eq!(ThemeMode::Green.css_class(), "theme-green");
        assert_eq!(UiSkin::Cyberpunk.css_class(), "skin-cyberpunk");
    }

    #[test]
    fn watch_only_navigation_emits_a_typed_route_event() {
        let mut state = AppState::default();
        assert_eq!(state.route, AppRoute::Landing);
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::WatchOnlyWallet)),
            Some(AppEvent::RouteChanged(AppRoute::WatchOnlyWallet))
        );
        assert_eq!(state.route, AppRoute::WatchOnlyWallet);
        assert_eq!(state.route.fragment(), "#/watch-only");
        assert_eq!(
            onboarding_view_model(&state).watch_only_wallet_href,
            "#/watch-only"
        );
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::WatchOnlyWallet)),
            None
        );
    }

    #[test]
    fn onboarding_view_model_comes_from_application_state() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));

        let vm = onboarding_view_model(&state);
        assert_eq!(vm.network_prefix, "bchtest");
        assert_eq!(vm.create_wallet_href, "#/createwallet");
        assert_eq!(vm.import_wallet_href, "#/importwallet");
        assert_eq!(vm.watch_only_wallet_href, "#/watch-only");
        assert!(vm.show_cash_fusion);
        assert!(vm.show_hardware_wallet);
        assert!(vm.show_watch_only);
    }

    #[test]
    fn watch_only_is_a_flag_default_on_every_surface() {
        let expected = [
            (AppSurface::Desktop, true, true),
            (AppSurface::Android, true, false),
            (AppSurface::Ios, true, false),
            (AppSurface::Web, true, false),
            (AppSurface::Extension, true, false),
        ];
        for (surface, watch_only, hardware) in expected {
            let vm = onboarding_view_model(&AppState::for_surface(surface));
            assert_eq!(
                vm.show_watch_only, watch_only,
                "{surface:?} watch-only defaults on; hide it with the flag"
            );
            assert_eq!(
                vm.show_hardware_wallet, hardware,
                "{surface:?} hardware stays a desktop-only flag"
            );
        }

        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let mut state = AppState::for_surface(surface);
            assert!(
                onboarding_view_model(&state).show_watch_only,
                "{surface:?} Watch Only defaults on"
            );
            state.apply(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::WatchOnly,
                enabled: false,
            });
            assert!(
                !onboarding_view_model(&state).show_watch_only,
                "{surface:?} Watch Only hides when the flag is false"
            );
            assert!(
                !onboarding_actions(&state).contains(&OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} landing must not list Watch Only when the flag is off"
            );
            state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
            assert_ne!(
                state.route,
                AppRoute::WatchOnlyWallet,
                "{surface:?} must not open Watch Only while the flag is off"
            );
        }
    }

    #[test]
    fn native_landing_actions_put_watch_only_with_create_and_import() {
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let actions = onboarding_actions(&AppState::for_surface(surface));
            assert_eq!(actions[0], OnboardingAction::CreateWallet, "{surface:?}");
            assert_eq!(actions[1], OnboardingAction::ImportWallet, "{surface:?}");
            assert_eq!(
                actions[2],
                OnboardingAction::CreateWatchOnlyWallet,
                "{surface:?} must show Watch Only when the flag is on"
            );
            assert!(
                !matches!(
                    surface,
                    AppSurface::Android | AppSurface::Ios | AppSurface::Web | AppSurface::Extension
                ) || !actions.contains(&OnboardingAction::ConnectHardwareWallet),
                "{surface:?} must not offer USB hardware onboarding"
            );
        }
    }

    #[test]
    fn cash_fusion_and_hardware_wallet_are_boolean_surface_toggles() {
        let none = FeatureFlags::default();
        assert!(none.enabled(AppSurface::Desktop, FeatureFlag::CashFusion));
        assert!(none.enabled(AppSurface::Desktop, FeatureFlag::HardwareWallet));

        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert!(
                !none.enabled(surface, FeatureFlag::CashFusion),
                "{surface:?} must hide CashFusion"
            );
            assert!(
                !none.enabled(surface, FeatureFlag::HardwareWallet),
                "{surface:?} must hide hardware wallets"
            );
        }
    }

    #[test]
    fn hardware_wallet_cannot_be_enabled_off_desktop() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::SetSurface(AppSurface::Android)),
            Some(AppEvent::SurfaceChanged(AppSurface::Android))
        );
        let vm = onboarding_view_model(&state);
        assert!(!vm.show_hardware_wallet);
        assert!(!vm.show_cash_fusion);
        assert!(vm.show_watch_only);

        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::HardwareWallet,
                enabled: true,
            }),
            None
        );
        assert_eq!(state.features.hardware_wallet, None);

        state.apply(AppAction::SetSurface(AppSurface::Desktop));
        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::CashFusion,
                enabled: false,
            }),
            Some(AppEvent::FeatureFlagChanged {
                flag: FeatureFlag::CashFusion,
                enabled: false,
            })
        );
        assert_eq!(state.features.cash_fusion, Some(false));
        assert!(!onboarding_view_model(&state).show_cash_fusion);
        assert!(onboarding_view_model(&state).show_hardware_wallet);

        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::HardwareWallet,
                enabled: false,
            }),
            Some(AppEvent::FeatureFlagChanged {
                flag: FeatureFlag::HardwareWallet,
                enabled: false,
            })
        );
        assert_eq!(state.features.hardware_wallet, Some(false));
        assert!(!onboarding_view_model(&state).show_hardware_wallet);
    }

    #[test]
    fn desktop_layout_is_not_a_css_breakpoint() {
        assert_eq!(
            LayoutKind::from_surface(AppSurface::Desktop),
            LayoutKind::Desktop
        );
        assert_eq!(LayoutKind::Desktop.css_class(), "shell-desktop");
        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert_eq!(
                LayoutKind::from_surface(surface),
                LayoutKind::Compact,
                "{surface:?} stays compact; do not share sm/lg with desktop"
            );
            assert_eq!(
                AppState::for_surface(surface).layout().css_class(),
                "shell-mobile"
            );
        }
    }

    #[test]
    fn user_freeze_moves_sats_from_spendable_to_reserved() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        let coin = chipnet_demo_coin(25_000, 1).expect("coin");
        let outpoint = coin.outpoint();
        assert_eq!(
            state.reduce(AppAction::InsertCoin(coin)),
            Some(AppEvent::CoinsChanged)
        );
        assert_eq!(coins_view_model(&state).spendable_sats, 25_000);
        assert_eq!(
            state.reduce(AppAction::FreezeCoin(outpoint)),
            Some(AppEvent::CoinsChanged)
        );
        let vm = coins_view_model(&state);
        assert_eq!(vm.spendable_sats, 0);
        assert_eq!(vm.reserved_sats, 25_000);
        assert_eq!(vm.layout, LayoutKind::Desktop);
        assert_eq!(
            state.coins.get(outpoint).and_then(Coin::freeze),
            Some(FreezeReason::User)
        );
    }

    #[test]
    fn flipstarter_pledge_uses_the_shared_freeze_not_fundme() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let coin = chipnet_demo_coin(4_000, 3).expect("coin");
        let outpoint = coin.outpoint();
        state.apply(AppAction::InsertCoin(coin));

        let address = optn_core::cashaddr::Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2pkh,
            [0x42; 20],
        )
        .encode();
        let json = format!(
            r#"{{"outputs":[{{"value":1000,"address":"{address}"}}],"data":{{"alias":"Ada"}},"donation":{{"amount":4000}}}}"#
        );
        let blob = encode_campaign_blob(&json);

        assert_eq!(
            state.reduce(AppAction::PrepareFlipstarterPledge {
                blob,
                now_unix: None,
            }),
            Some(AppEvent::FlipstarterPledgesChanged)
        );
        assert_eq!(
            state.coins.get(outpoint).and_then(Coin::freeze),
            Some(FreezeReason::FlipstarterPledge)
        );
        assert_eq!(state.pledges.len(), 1);
        assert_eq!(state.pledges[0].alias.as_deref(), Some("Ada"));
        let fundme = fundme_view_model(&state);
        assert!(!fundme.available);
        assert_eq!(fundme.product.name, "FundMe");
        assert_ne!(fundme.product.name, "Flipstarter");
        assert_eq!(
            flipstarter_view_model(&state).sighash,
            optn_core::flipstarter::PLEDGE_SIGHASH
        );

        let pledge_id = state.pledges[0].id;
        assert_eq!(
            state.reduce(AppAction::CancelFlipstarterPledge(pledge_id)),
            Some(AppEvent::FlipstarterPledgesChanged)
        );
        assert!(state.coins.get(outpoint).is_some_and(Coin::is_spendable));
        assert_eq!(
            state.pledges[0].status,
            PledgeStatus::Cancelled {
                spend_to_self: true
            }
        );
    }

    #[test]
    fn flipstarter_rejects_a_frozen_coin_and_keeps_fundme_separate() {
        let mut state = AppState::default();
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let coin = chipnet_demo_coin(2_000, 8).expect("coin");
        let outpoint = coin.outpoint();
        state.apply(AppAction::InsertCoin(coin));
        state.apply(AppAction::FreezeCoin(outpoint));

        let address = optn_core::cashaddr::Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2pkh,
            [0x42; 20],
        )
        .encode();
        let json = format!(
            r#"{{"outputs":[{{"value":1,"address":"{address}"}}],"donation":{{"amount":2000}}}}"#
        );
        state.apply(AppAction::PrepareFlipstarterPledge {
            blob: encode_campaign_blob(&json),
            now_unix: None,
        });
        assert!(state.pledges.is_empty());
        assert!(state
            .notice
            .as_deref()
            .is_some_and(|text| text.contains("exactly 2000 sats")));
        let nav = product_nav(&state);
        let labels: Vec<&str> = nav.iter().map(|item| item.label()).collect();
        assert_eq!(
            labels,
            vec!["Home", "Assets", "Actions", "Explore", "Settings"]
        );
        // History is still a route, reached from Home's "View all" rather
        // than a sixth tab. See the_bottom_nav_matches_the_blueprint...
        assert_eq!(AppRoute::History.fragment(), "#/history");
        assert_eq!(AppRoute::Flipstarter.fragment(), "#/flipstarter");
        assert_eq!(AppRoute::FundMe.fragment(), "#/fundme");
        assert_eq!(AppRoute::Coins.fragment(), "#/assets");
        assert_eq!(format_bch(100_001_127), "1.00001127 BCH");
        assert!(AppRoute::WalletHome.is_wallet_chrome());
        assert!(!AppRoute::Landing.is_wallet_chrome());
    }

    fn open_chipnet_seed(state: &mut AppState, name: &str) {
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, name, BIP39_TEST_VECTOR_MNEMONIC)
            .expect("seed preview");
        assert!(opened.receive_address.starts_with("bchtest:"));
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
    }

    #[test]
    fn native_create_import_and_watch_only_open_home() {
        for surface in [AppSurface::Desktop, AppSurface::Android, AppSurface::Ios] {
            let mut created = AppState::for_surface(surface);
            open_chipnet_seed(&mut created, "created");
            assert_eq!(created.route, AppRoute::WalletHome, "{surface:?} create");
            assert_eq!(
                created.wallet.as_ref().map(|wallet| wallet.kind),
                Some(WalletKind::Seed)
            );

            let mut imported = AppState::for_surface(surface);
            imported.apply(AppAction::SetNetwork(Network::Chipnet));
            let opened =
                seed_wallet_preview(Network::Chipnet, "imported", BIP39_TEST_VECTOR_MNEMONIC)
                    .expect("import preview");
            imported.apply(AppAction::OpenImportedWallet {
                name: opened.name,
                receive_address: opened.receive_address,
                account_path: opened.account_path,
            });
            assert_eq!(imported.route, AppRoute::WalletHome, "{surface:?} import");

            let mut watch = AppState::for_surface(surface);
            watch.apply(AppAction::SetNetwork(Network::Chipnet));
            let wallet = optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
                .expect("mnemonic");
            let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
            let preview = watch_only_setup_preview(Network::Chipnet, "watch", &xpub, "4c9a1f7b")
                .expect("watch preview");
            assert!(preview.receive_address.starts_with("bchtest:"));
            assert_eq!(preview.master_fingerprint.as_deref(), Some("4c9a1f7b"));
            watch.apply(AppAction::OpenWatchOnlyWallet(preview));
            assert_eq!(watch.route, AppRoute::WalletHome, "{surface:?} watch-only");
            assert_eq!(
                watch.wallet.as_ref().map(|wallet| wallet.kind),
                Some(WalletKind::WatchOnly)
            );
        }

        for surface in [AppSurface::Web, AppSurface::Extension] {
            assert!(
                onboarding_actions(&AppState::for_surface(surface))
                    .contains(&OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} must show Watch Only when the flag is on"
            );
            let mut state = AppState::for_surface(surface);
            state.apply(AppAction::SetNetwork(Network::Chipnet));
            state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
            assert_eq!(state.route, AppRoute::WatchOnlyWallet, "{surface:?}");
        }
    }

    #[test]
    fn create_and_import_use_the_shared_cli_word_counts() {
        assert_eq!(BIP39_WORD_COUNTS, [12, 15, 18, 21, 24]);
        assert_eq!(BIP39_DEFAULT_WORD_COUNT, 12);
        for words in BIP39_WORD_COUNTS {
            let len = entropy_len_for_word_count(words).expect("cli word count");
            let entropy = vec![0x5a_u8; len];
            let phrase = mnemonic_from_entropy(&entropy).expect("phrase");
            assert_eq!(phrase.split_whitespace().count(), words);
            let opened = seed_wallet_preview_at(
                Network::Chipnet,
                "shared",
                &phrase,
                AccountPath::default_for(Network::Chipnet),
            )
            .expect("open");
            assert!(
                opened.receive_address.starts_with("bchtest:"),
                "{words}-word Chipnet receive"
            );
            let mut state = AppState::for_surface(AppSurface::Desktop);
            state.apply(AppAction::SetNetwork(Network::Chipnet));
            state.apply(AppAction::OpenImportedWallet {
                name: opened.name,
                receive_address: opened.receive_address,
                account_path: opened.account_path,
            });
            assert_eq!(state.route, AppRoute::WalletHome, "{words}-word import");
        }
        assert!(entropy_len_for_word_count(16).is_err());
    }

    #[test]
    fn home_is_blocked_until_a_wallet_is_opened() {
        let mut state = AppState::for_surface(AppSurface::Android);
        assert_eq!(
            state.reduce(AppAction::Navigate(AppRoute::WalletHome)),
            Some(AppEvent::NoticeChanged)
        );
        assert_eq!(state.route, AppRoute::Landing);
    }

    #[test]
    fn seed_send_selects_spendable_coin_watch_only_is_unsigned_psbt() {
        let dest = optn_core::cashaddr::Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2pkh,
            [0x7a; 20],
        )
        .encode();

        let mut seed = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut seed, "seed");
        seed.apply(AppAction::InsertCoin(
            chipnet_demo_coin(9_000, 1).expect("coin"),
        ));
        seed.apply(AppAction::PrepareSend {
            destination: dest.clone(),
            amount_sats: 9_000,
        });
        let plan = seed.spend.as_ref().expect("seed spend");
        assert_eq!(plan.sighash, SIGHASH_ALL_FORKID);
        assert!(plan.uses_seed_signing());
        assert_eq!(plan.kind, SpendKind::SeedSpecified);

        let frozen = chipnet_demo_coin(9_000, 2).expect("frozen");
        let frozen_out = frozen.outpoint();
        seed.apply(AppAction::InsertCoin(frozen));
        seed.apply(AppAction::FreezeCoin(frozen_out));
        seed.spend = None;
        seed.apply(AppAction::PrepareSend {
            destination: dest.clone(),
            amount_sats: 9_000,
        });
        assert_ne!(
            seed.spend.as_ref().map(|plan| plan.selected),
            Some(frozen_out)
        );

        let mut watch = AppState::for_surface(AppSurface::Ios);
        watch.apply(AppAction::SetNetwork(Network::Chipnet));
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        let preview =
            watch_only_setup_preview(Network::Chipnet, "watch", &xpub, "").expect("preview");
        watch.apply(AppAction::OpenWatchOnlyWallet(preview));
        watch.apply(AppAction::InsertCoin(
            chipnet_demo_coin(4_000, 3).expect("coin"),
        ));
        watch.apply(AppAction::PrepareSend {
            destination: dest,
            amount_sats: 4_000,
        });
        let plan = watch.spend.expect("watch spend");
        assert_eq!(plan.kind, SpendKind::WatchOnlyUnsignedPsbt);
        assert!(!plan.uses_seed_signing());
        assert_eq!(
            sign_seed_spend(
                &plan,
                BIP39_TEST_VECTOR_MNEMONIC,
                Network::Chipnet,
                AccountPath::default_for(Network::Chipnet)
            ),
            Err(optn_core::spend::SpendError::WatchOnlyCannotSign)
        );
    }

    #[test]
    fn product_chrome_opens_home_and_lists_history() {
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let actions = onboarding_actions(&AppState::for_surface(surface));
            assert_eq!(
                actions[..3],
                [
                    OnboardingAction::CreateWallet,
                    OnboardingAction::ImportWallet,
                    OnboardingAction::CreateWatchOnlyWallet
                ],
                "{surface:?}"
            );
            let mut off = AppState::for_surface(surface);
            off.apply(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::WatchOnly,
                enabled: false,
            });
            assert!(
                !onboarding_actions(&off).contains(&OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} hides Watch Only when the flag is false"
            );

            let mut state = AppState::for_surface(surface);
            open_chipnet_seed(&mut state, "chrome");
            assert_eq!(state.route, AppRoute::WalletHome);
            state.apply(AppAction::Navigate(AppRoute::History));
            assert_eq!(state.route, AppRoute::History);
            assert!(AppRoute::History.is_wallet_chrome());
        }
        let labels: Vec<_> = product_nav(&AppState::for_surface(AppSurface::Desktop))
            .iter()
            .map(|item| item.label())
            .collect();
        assert_eq!(labels, ["Home", "Assets", "Actions", "Explore", "Settings"]);
        assert!(AppRoute::History.is_wallet_chrome());
    }

    #[test]
    fn history_comes_from_coins_and_rebuild_keeps_the_seed() {
        let dest = optn_core::cashaddr::Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2pkh,
            [0x7a; 20],
        )
        .encode();
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "history");
        let receive = state
            .wallet
            .as_ref()
            .map(|wallet| wallet.receive_address.clone())
            .expect("opened");
        assert!(receive.starts_with("bchtest:"));
        let coin = chipnet_demo_coin(8_000, 4).expect("coin");
        let frozen = chipnet_demo_coin(8_000, 5).expect("frozen");
        let frozen_out = frozen.outpoint();
        state.apply(AppAction::InsertCoin(coin));
        state.apply(AppAction::InsertCoin(frozen));
        state.apply(AppAction::FreezeCoin(frozen_out));
        let history = history_view_model(&state);
        assert_eq!(history.entries.len(), 2);
        assert!(history
            .entries
            .iter()
            .all(|entry| entry.kind == HistoryKind::Received));
        assert!(history.entries.iter().any(|entry| entry.reserved));

        state.apply(AppAction::PrepareSend {
            destination: dest,
            amount_sats: 8_000,
        });
        assert_ne!(
            state.spend.as_ref().map(|plan| plan.selected),
            Some(frozen_out)
        );
        assert_eq!(
            state.spend.as_ref().map(|plan| plan.sighash),
            Some(SIGHASH_ALL_FORKID)
        );
        assert_eq!(history_view_model(&state).entries.len(), 3);
        assert_eq!(
            history_view_model(&state)
                .entries
                .last()
                .map(|entry| entry.kind),
            Some(HistoryKind::PendingSend)
        );

        let opened = state.wallet.clone();
        state.apply(AppAction::RebuildWallet);
        assert_eq!(state.wallet, opened);
        assert!(state.coins.is_empty());
        assert!(state.spend.is_none());
        assert!(state.pledges.is_empty());
        assert!(history_view_model(&state).entries.is_empty());
        assert_eq!(state.route, AppRoute::Send);
    }

    #[test]
    fn settings_lists_chipnet_faucet_servers_rebuild_and_desktop_fusion() {
        let mut desktop = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut desktop, "settings");
        let chipnet = settings_view_model(&desktop);
        assert_eq!(chipnet.network, Network::Chipnet);
        assert_eq!(chipnet.faucet_url, Some(CHIPNET_FAUCET_URL));
        assert_eq!(chipnet.derivation_path, "m/44'/1'/0'");
        assert_eq!(chipnet.electrum_host, Network::Chipnet.default_host());
        assert!(chipnet.rows.contains(&SettingsRowId::Network));
        assert!(chipnet.rows.contains(&SettingsRowId::Faucet));
        assert!(chipnet.rows.contains(&SettingsRowId::WalletInfo));
        assert!(chipnet.rows.contains(&SettingsRowId::Derivation));
        assert!(chipnet.rows.contains(&SettingsRowId::Recovery));
        assert!(chipnet.rows.contains(&SettingsRowId::RebuildWallet));
        assert!(chipnet.rows.contains(&SettingsRowId::Servers));
        assert!(chipnet.rows.contains(&SettingsRowId::CashFusion));
        assert!(chipnet.show_cash_fusion);

        desktop.apply(AppAction::SetNetwork(Network::Mainnet));
        let mainnet = settings_view_model(&desktop);
        assert!(!mainnet.rows.contains(&SettingsRowId::Faucet));
        assert_eq!(mainnet.faucet_url, None);
        // The open wallet keeps its own account. Its addresses are still
        // derived under coin type 1, exactly as `receive_address` still shows
        // a bchtest address, so relabelling it as mainnet's m/44'/145'/0'
        // would point a rescan at a branch this wallet does not live on.
        assert_eq!(mainnet.derivation_path, "m/44'/1'/0'");
        assert_eq!(
            mainnet.receive_address, chipnet.receive_address,
            "the network toggle must not silently re-identify an open wallet"
        );

        // With no wallet open there is nothing to follow, so the row falls
        // back to what this network would derive.
        assert_eq!(
            settings_view_model(&AppState::for_surface(AppSurface::Desktop)).derivation_path,
            "m/44'/145'/0'"
        );

        desktop.apply(AppAction::SetFeatureEnabled {
            flag: FeatureFlag::CashFusion,
            enabled: false,
        });
        assert!(!settings_view_model(&desktop)
            .rows
            .contains(&SettingsRowId::CashFusion));

        let android = AppState::for_surface(AppSurface::Android);
        assert!(!settings_view_model(&android)
            .rows
            .contains(&SettingsRowId::CashFusion));
        assert!(!settings_view_model(&android).show_cash_fusion);
    }

    #[test]
    fn a_wallet_opened_at_a_chosen_account_keeps_and_reports_that_account() {
        let chosen = AccountPath::new(145, 1).expect("in range");
        let opened = seed_wallet_preview_at(
            Network::Mainnet,
            "second account",
            BIP39_TEST_VECTOR_MNEMONIC,
            chosen,
        )
        .expect("preview");
        assert_eq!(opened.account_path, "m/44'/145'/1'");
        assert_ne!(
            opened.receive_address,
            seed_wallet_preview(Network::Mainnet, "default", BIP39_TEST_VECTOR_MNEMONIC)
                .expect("default preview")
                .receive_address,
            "choosing an account must derive a different wallet"
        );

        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name.clone(),
            receive_address: opened.receive_address.clone(),
            account_path: opened.account_path.clone(),
        });
        assert_eq!(state.route, AppRoute::WalletHome);
        assert_eq!(
            settings_view_model(&state).derivation_path,
            "m/44'/145'/1'",
            "Settings must show the account the wallet was opened at"
        );
    }

    #[test]
    fn the_bottom_nav_matches_the_blueprint_and_the_react_shell() {
        // docs/ui-overhaul/A_home_single.png and issue #71 both specify five
        // destinations. A sixth would not fit the 44px touch targets the issue
        // requires, and recent activity belongs on Home behind "View all".
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
        ] {
            let nav = product_nav(&AppState::for_surface(surface));
            assert_eq!(
                nav,
                vec![
                    ProductNavItem::Home,
                    ProductNavItem::Assets,
                    ProductNavItem::Actions,
                    ProductNavItem::Explore,
                    ProductNavItem::Settings,
                ],
                "{surface:?} must match the blueprint bottom nav"
            );
        }

        // The React shell renders the extension popup with `viewerOnly`, which
        // drops Actions and Settings and puts Receive and Transactions in
        // their slots. Keep the two shells consistent.
        let extension = product_nav(&AppState::for_surface(AppSurface::Extension));
        assert_eq!(
            extension,
            vec![
                ProductNavItem::Home,
                ProductNavItem::Assets,
                ProductNavItem::Receive,
                ProductNavItem::History,
            ]
        );
        assert!(!extension.contains(&ProductNavItem::Settings));
        assert!(!extension.contains(&ProductNavItem::Actions));

        // Every destination must lead to a route the tab can highlight.
        for item in product_nav(&AppState::for_surface(AppSurface::Desktop))
            .into_iter()
            .chain(extension)
        {
            assert!(
                item.is_active(item.route()),
                "{item:?} must report itself active on its own route"
            );
            assert!(!item.label().is_empty());
        }
    }

    #[test]
    fn hardware_is_a_desktop_capability_end_to_end() {
        // Desktop offers it; every other surface refuses the route and the
        // open, so a renderer bug cannot strand funds behind a device the
        // surface cannot reach.
        let mut desktop = AppState::for_surface(AppSurface::Desktop);
        let vm = hardware_view_model(&desktop);
        assert!(vm.available);
        assert_eq!(vm.vendors, HardwareVendor::OFFERED.to_vec());
        assert!(!vm.vendors.contains(&HardwareVendor::Mock));
        desktop.apply(AppAction::Navigate(AppRoute::HardwareWallet));
        assert_eq!(desktop.route, AppRoute::HardwareWallet);
        assert_eq!(AppRoute::HardwareWallet.fragment(), "#/hardware");
        assert_eq!(
            OnboardingAction::ConnectHardwareWallet.route(),
            Some(AppRoute::HardwareWallet),
            "the landing action must lead somewhere"
        );

        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let mut state = AppState::for_surface(surface);
            let vm = hardware_view_model(&state);
            assert!(!vm.available, "{surface:?}");
            assert!(vm.vendors.is_empty(), "{surface:?} must offer no devices");
            state.apply(AppAction::Navigate(AppRoute::HardwareWallet));
            assert_ne!(state.route, AppRoute::HardwareWallet, "{surface:?}");
        }
    }

    #[test]
    fn a_hardware_wallet_can_spend_but_never_seed_signs() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        let preview = hardware_setup_preview(
            Network::Chipnet,
            HardwareVendor::Trezor,
            "device wallet",
            &xpub,
            "0f0f0f0f",
        )
        .expect("device account is valid");
        assert_eq!(preview.vendor, HardwareVendor::Trezor);
        assert_eq!(preview.account_path, "m/44'/1'/0'");

        state.apply(AppAction::OpenHardwareWallet(preview));
        assert_eq!(state.route, AppRoute::WalletHome);
        let opened = state.wallet.as_ref().expect("wallet opened");
        assert_eq!(opened.kind, WalletKind::Hardware);
        assert_eq!(opened.master_fingerprint.as_deref(), Some("0f0f0f0f"));
        // Not watch-only: it can spend, it just cannot sign here.
        assert_eq!(
            opened.spending_capability(),
            SpendingCapability::Hardware,
            "a device wallet must not be treated as watch-only"
        );

        let coin = chipnet_demo_coin(9_000, 1).expect("coin");
        let dest = coin.address().to_string();
        state.apply(AppAction::InsertCoin(coin));
        state.apply(AppAction::PrepareSend {
            destination: dest,
            amount_sats: 4_000,
        });
        let plan = state.spend.as_ref().expect("hardware spend planned");
        assert_eq!(plan.kind, SpendKind::HardwareUnsignedPsbt);
        assert!(!plan.uses_seed_signing());
    }

    #[test]
    fn an_unsupported_device_is_refused_before_a_wallet_opens() {
        // Mock exists for tests and adapters without USB. Offering it in the
        // product would let someone open a wallet nothing can sign for.
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        let refused = hardware_setup_preview(
            Network::Chipnet,
            HardwareVendor::Mock,
            "mock wallet",
            &xpub,
            "",
        );
        assert!(refused.is_err(), "Mock must not be onboardable");
    }

    #[test]
    fn opening_a_wallet_at_an_unparseable_account_is_refused() {
        // A path Settings cannot round-trip is a path a rescan cannot follow,
        // so it must not open a wallet at all.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::OpenCreatedWallet {
            name: "bad path".into(),
            receive_address: "bitcoincash:qexample".into(),
            account_path: "m/44'/145'/0'/0/0".into(),
        });
        assert_eq!(state.route, AppRoute::Landing);
        assert!(state.wallet.is_none());
        assert!(state.notice.is_some());
    }
}
