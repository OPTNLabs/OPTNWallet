#![forbid(unsafe_code)]

//! Framework-neutral application layer.
//!
//! UI frameworks render this state and dispatch typed actions. Runtime/shell
//! adapters may subscribe to typed events. No UI or native-shell framework
//! belongs in this crate.

mod flow;
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

    /// Landing and the five product tabs. Switching these replaces the overlay.
    pub const fn is_section_root(self) -> bool {
        matches!(
            self,
            Self::Landing
                | Self::WalletHome
                | Self::Coins
                | Self::Actions
                | Self::Explore
                | Self::Settings
        )
    }

    /// Fallback when an overlay was opened without recording a return tab.
    pub const fn default_parent(self) -> Option<Self> {
        match self {
            Self::Landing | Self::WalletHome | Self::Coins | Self::Actions | Self::Explore => None,
            Self::Settings => Some(Self::WalletHome),
            Self::CreateWallet
            | Self::ImportWallet
            | Self::WatchOnlyWallet
            | Self::HardwareWallet => Some(Self::Landing),
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
    /// The connected device, if any. Separate from the opened wallet: a
    /// wallet remembers which device it belongs to while nothing is plugged in.
    pub hardware: HardwareSessionState,
    pub create_step: CreateStep,
    pub import_step: ImportStep,
    pub settings_focus: Option<SettingsRowId>,
    pub watch_only_kind: WatchOnlyKind,
    pub multisig_step: MultisigStep,
    /// Tab that opened the current overlay. `None` on a section root.
    pub return_to: Option<AppRoute>,
    pub lock: AppLockState,
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
    /// `2 of 3` when this is a multisig wallet, `None` for single-sig.
    ///
    /// Kept beside the account rather than folded into it: a multisig wallet
    /// still has a derivation account, and writing the policy into that field
    /// would make Settings report a threshold where a path belongs.
    pub multisig_policy: Option<String>,
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
            hardware: HardwareSessionState::new(),
            create_step: CreateStep::Reveal,
            import_step: ImportStep::Words,
            settings_focus: None,
            watch_only_kind: WatchOnlyKind::Single,
            multisig_step: MultisigStep::Policy,
            return_to: None,
            lock: AppLockState::new(),
        }
    }

    pub const fn layout(&self) -> LayoutKind {
        LayoutKind::from_surface(self.surface)
    }

    pub fn fundme(&self) -> FundMeProduct {
        optn_core::fundme::product()
    }

    pub fn flow(&self) -> FlowViewModel {
        flow_view_model(
            self.route,
            self.create_step,
            self.import_step,
            self.settings_focus,
            self.return_to,
            self.watch_only_kind,
            self.multisig_step,
        )
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
    OpenMultisigWallet(MultisigSetupPreview),
    /// Choose which device to talk to. `None` forgets the device entirely.
    SelectHardwareVendor(Option<HardwareVendor>),
    /// Ledger only: USB or Bluetooth. Ignored by every other vendor.
    SetLedgerLink(LedgerLink),
    /// A device answered. Public material only.
    HardwareConnected {
        label: String,
        account_xpub: String,
    },
    /// Forget the attachment, keep the chosen device.
    DisconnectHardware,
    PrepareSend {
        destination: String,
        amount_sats: u64,
    },
    RebuildWallet,
    /// Pop the current section (create/import step, settings panel, or page).
    GoBack,
    /// Advance create/import/shared-wallet to the next desktop section. The
    /// renderer validates form fields first; the mnemonic never enters
    /// application state.
    AdvanceOnboarding,
    OpenSettingsRow(SettingsRowId),
    SetWatchOnlyKind(WatchOnlyKind),
    /// Persist an auto-lock duration. 1 and 5 minutes become Never.
    SetAutoLockMinutes(u32),
    /// Wipe the in-RAM session and return to the wallet picker.
    LockWallet,
    RecordActivity {
        now_ms: u64,
    },
    IdleCheck {
        now_ms: u64,
    },
    /// Sign/broadcast path. Password popup only when auto-lock is Never and
    /// the 10 minute spend cache has expired.
    AuthorizeSpend {
        now_ms: u64,
    },
    RequestReveal {
        now_ms: u64,
    },
    /// CashFusion / auto-fusion. Never prompts.
    AuthorizeBackground {
        now_ms: u64,
    },
    /// Chat / message sign. Never prompts.
    AuthorizeChat {
        now_ms: u64,
    },
    /// Shell already verified the password. Grants the current prompt.
    ConfirmAuth {
        now_ms: u64,
    },
    CancelAuth,
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
    HardwareSessionChanged,
    SpendPrepared,
    WalletRebuilt,
    FlowChanged,
    AppLockChanged,
    AuthRequired,
    SpendAuthorized,
    WalletLocked,
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
                let mut flow_changed = false;
                if route.is_section_root() {
                    if self.return_to.is_some() {
                        self.return_to = None;
                        flow_changed = true;
                    }
                } else if self.route.is_section_root() && self.return_to != Some(self.route) {
                    self.return_to = Some(self.route);
                    flow_changed = true;
                }
                if route == AppRoute::CreateWallet && self.create_step != CreateStep::Reveal {
                    self.create_step = CreateStep::Reveal;
                    flow_changed = true;
                }
                if route == AppRoute::ImportWallet && self.import_step != ImportStep::Words {
                    self.import_step = ImportStep::Words;
                    flow_changed = true;
                }
                if route == AppRoute::Settings && self.settings_focus.is_some() {
                    self.settings_focus = None;
                    flow_changed = true;
                }
                if route == AppRoute::WatchOnlyWallet
                    && (self.watch_only_kind != WatchOnlyKind::Single
                        || self.multisig_step != MultisigStep::Policy)
                {
                    self.watch_only_kind = WatchOnlyKind::Single;
                    self.multisig_step = MultisigStep::Policy;
                    flow_changed = true;
                }
                if self.route == route {
                    return flow_changed.then_some(AppEvent::FlowChanged);
                }
                if route == AppRoute::CreateWallet {
                    self.create_step = CreateStep::Reveal;
                }
                if route == AppRoute::ImportWallet {
                    self.import_step = ImportStep::Words;
                }
                if route == AppRoute::WatchOnlyWallet {
                    self.watch_only_kind = WatchOnlyKind::Single;
                    self.multisig_step = MultisigStep::Policy;
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
                    multisig_policy: None,
                });
                self.spend = None;
                self.notice = None;
                self.return_to = None;
                self.route = AppRoute::WalletHome;
                self.lock.mark_unlocked();
                Some(AppEvent::WalletOpened)
            }
            AppAction::SelectHardwareVendor(vendor) => {
                if self.hardware.vendor == vendor {
                    return None;
                }
                // Changing device invalidates whatever the last one said.
                self.hardware.disconnect();
                self.hardware.vendor = vendor;
                if vendor != Some(HardwareVendor::Ledger) {
                    // The wire choice is Ledger's; do not leave a stale
                    // Bluetooth preference sitting on a Trezor.
                    self.hardware.ledger_link = LedgerLink::Usb;
                }
                Some(AppEvent::HardwareSessionChanged)
            }
            AppAction::SetLedgerLink(link) => {
                if !self.hardware.offers_link_choice() || self.hardware.ledger_link == link {
                    return None;
                }
                self.hardware.ledger_link = link;
                Some(AppEvent::HardwareSessionChanged)
            }
            AppAction::HardwareConnected {
                label,
                account_xpub,
            } => {
                if self.hardware.vendor.is_none() {
                    return self.reject("Choose a device first.".into());
                }
                self.hardware.connected = true;
                self.hardware.device_label = Some(label);
                self.hardware.account_xpub = Some(account_xpub);
                Some(AppEvent::HardwareSessionChanged)
            }
            AppAction::DisconnectHardware => {
                if !self.hardware.connected && self.hardware.device_label.is_none() {
                    return None;
                }
                self.hardware.disconnect();
                Some(AppEvent::HardwareSessionChanged)
            }
            AppAction::OpenMultisigWallet(preview) => {
                // Multisig is a watch-only wallet: this device holds public
                // cosigner accounts and can never reach the threshold alone.
                // Spending is a PSBT the other cosigners countersign.
                if !self.features.enabled(self.surface, FeatureFlag::WatchOnly) {
                    return self.reject("Watch-only is turned off.".into());
                }
                self.wallet = Some(OpenedWallet {
                    kind: WalletKind::WatchOnly,
                    name: preview.wallet_name,
                    receive_address: preview.receive_address,
                    master_fingerprint: None,
                    account_path: AccountPath::default_for(self.network).to_string(),
                    multisig_policy: Some(preview.policy),
                });
                self.spend = None;
                self.notice = None;
                self.return_to = None;
                self.route = AppRoute::WalletHome;
                self.lock.mark_unlocked();
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
                    multisig_policy: None,
                });
                self.spend = None;
                self.notice = None;
                self.return_to = None;
                self.route = AppRoute::WalletHome;
                self.lock.mark_unlocked();
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
                        if self.route.is_section_root() {
                            self.return_to = Some(self.route);
                        }
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
            AppAction::GoBack => self.go_back(),
            AppAction::AdvanceOnboarding => self.advance_onboarding(),
            AppAction::OpenSettingsRow(row) => {
                if self.route != AppRoute::Settings {
                    return self.reject("open Settings first".into());
                }
                if !settings_view_model(self).rows.contains(&row) {
                    return self.reject("that setting is not available".into());
                }
                if self.settings_focus == Some(row) {
                    return None;
                }
                self.settings_focus = Some(row);
                Some(AppEvent::FlowChanged)
            }
            AppAction::SetWatchOnlyKind(kind) => {
                if self.route != AppRoute::WatchOnlyWallet {
                    return self.reject("open Watch Only first".into());
                }
                if self.watch_only_kind == kind {
                    return None;
                }
                self.watch_only_kind = kind;
                self.multisig_step = MultisigStep::Policy;
                Some(AppEvent::FlowChanged)
            }
            AppAction::SetAutoLockMinutes(minutes) => {
                let next = AutoLockMinutes::from_minutes(minutes);
                if self.lock.auto_lock == next {
                    return None;
                }
                self.lock.auto_lock = next;
                Some(AppEvent::AppLockChanged)
            }
            AppAction::LockWallet => self.lock_wallet(),
            AppAction::RecordActivity { now_ms } => {
                self.lock.record_activity(now_ms);
                None
            }
            AppAction::IdleCheck { now_ms } => {
                self.lock.observe(now_ms);
                if self.wallet.is_some() && self.lock.idle_should_lock(now_ms) {
                    self.lock_wallet()
                } else {
                    None
                }
            }
            AppAction::AuthorizeSpend { now_ms } => self.authorize(AuthScope::Spend, now_ms),
            AppAction::RequestReveal { now_ms } => self.authorize(AuthScope::Reveal, now_ms),
            AppAction::AuthorizeBackground { now_ms } => {
                self.authorize(AuthScope::Background, now_ms)
            }
            AppAction::AuthorizeChat { now_ms } => self.authorize(AuthScope::Chat, now_ms),
            AppAction::ConfirmAuth { now_ms } => {
                let scope = self.lock.prompt?;
                match scope {
                    AuthScope::Spend => {
                        self.lock.mark_spend_auth(now_ms);
                        Some(AppEvent::SpendAuthorized)
                    }
                    AuthScope::Reveal => {
                        self.lock.prompt = None;
                        Some(AppEvent::AppLockChanged)
                    }
                    AuthScope::Background | AuthScope::Chat => {
                        self.lock.prompt = None;
                        Some(AppEvent::AppLockChanged)
                    }
                }
            }
            AppAction::CancelAuth => {
                self.lock.prompt?;
                self.lock.prompt = None;
                Some(AppEvent::AppLockChanged)
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
            multisig_policy: None,
        });
        self.spend = None;
        self.notice = None;
        self.return_to = None;
        self.route = AppRoute::WalletHome;
        self.lock.mark_unlocked();
        Some(AppEvent::WalletOpened)
    }

    fn lock_wallet(&mut self) -> Option<AppEvent> {
        if self.wallet.is_none() && self.lock.prompt.is_none() {
            return None;
        }
        self.lock.lock();
        self.wallet = None;
        self.spend = None;
        self.coins.clear();
        self.pledges.clear();
        self.notice = None;
        self.settings_focus = None;
        self.return_to = None;
        self.route = AppRoute::Landing;
        Some(AppEvent::WalletLocked)
    }

    fn authorize(&mut self, scope: AuthScope, now_ms: u64) -> Option<AppEvent> {
        if self.wallet.is_none() {
            return self.reject("open a wallet first".into());
        }
        self.lock.observe(now_ms);
        let kind = self.wallet.as_ref().map(|wallet| wallet.kind);
        match self.lock.decide(scope, now_ms, kind) {
            AuthDecision::Allow => {
                if scope == AuthScope::Spend {
                    self.lock.mark_spend_auth(now_ms);
                    Some(AppEvent::SpendAuthorized)
                } else {
                    None
                }
            }
            AuthDecision::Prompt => {
                if self.lock.prompt == Some(scope) {
                    return None;
                }
                self.lock.prompt = Some(scope);
                Some(AppEvent::AuthRequired)
            }
        }
    }

    fn pop_overlay(&mut self) -> Option<AppEvent> {
        let dest = match self
            .return_to
            .take()
            .or_else(|| self.route.default_parent())
        {
            Some(dest) => dest,
            None if self.wallet.is_some() => AppRoute::WalletHome,
            None => AppRoute::Landing,
        };
        if self.route == dest {
            return None;
        }
        self.route = dest;
        Some(AppEvent::RouteChanged(dest))
    }

    fn go_back(&mut self) -> Option<AppEvent> {
        if self.lock.prompt.is_some() {
            self.lock.prompt = None;
            return Some(AppEvent::AppLockChanged);
        }
        match self.route {
            AppRoute::CreateWallet => match self.create_step.back() {
                Some(step) => {
                    self.create_step = step;
                    Some(AppEvent::FlowChanged)
                }
                None => self.pop_overlay(),
            },
            AppRoute::ImportWallet => match self.import_step.back() {
                Some(step) => {
                    self.import_step = step;
                    Some(AppEvent::FlowChanged)
                }
                None => self.pop_overlay(),
            },
            AppRoute::Settings if self.settings_focus.is_some() => {
                self.settings_focus = None;
                Some(AppEvent::FlowChanged)
            }
            AppRoute::Landing
            | AppRoute::WalletHome
            | AppRoute::Coins
            | AppRoute::Actions
            | AppRoute::Explore => None,
            AppRoute::WatchOnlyWallet if self.watch_only_kind == WatchOnlyKind::Shared => {
                match self.multisig_step.back() {
                    Some(step) => {
                        self.multisig_step = step;
                        Some(AppEvent::FlowChanged)
                    }
                    None => {
                        self.watch_only_kind = WatchOnlyKind::Single;
                        Some(AppEvent::FlowChanged)
                    }
                }
            }
            AppRoute::WatchOnlyWallet
            | AppRoute::HardwareWallet
            | AppRoute::Receive
            | AppRoute::Send
            | AppRoute::History
            | AppRoute::Flipstarter
            | AppRoute::FundMe
            | AppRoute::Settings => self.pop_overlay(),
        }
    }

    fn advance_onboarding(&mut self) -> Option<AppEvent> {
        match self.route {
            AppRoute::CreateWallet => match self.create_step.next() {
                Some(step) => {
                    self.create_step = step;
                    Some(AppEvent::FlowChanged)
                }
                None => self.reject("name the wallet, then open it.".into()),
            },
            AppRoute::ImportWallet => match self.import_step.next() {
                Some(step) => {
                    self.import_step = step;
                    Some(AppEvent::FlowChanged)
                }
                None => self.reject("name the wallet, then open it.".into()),
            },
            AppRoute::WatchOnlyWallet if self.watch_only_kind == WatchOnlyKind::Shared => {
                match self.multisig_step.next() {
                    Some(step) => {
                        self.multisig_step = step;
                        Some(AppEvent::FlowChanged)
                    }
                    None => self.reject("open the shared wallet from the confirmation.".into()),
                }
            }
            _ => self.reject("nothing to continue.".into()),
        }
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
            Self::ConnectHardwareWallet => Some(AppRoute::WatchOnlyWallet.fragment()),
        }
    }

    pub const fn route(self) -> Option<AppRoute> {
        match self {
            Self::CreateWallet => Some(AppRoute::CreateWallet),
            Self::ImportWallet => Some(AppRoute::ImportWallet),
            Self::CreateWatchOnlyWallet => Some(AppRoute::WatchOnlyWallet),
            Self::ConnectHardwareWallet => Some(AppRoute::WatchOnlyWallet),
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
    AppLock,
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
            Self::AppLock => "App lock",
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
            Self::AppLock => "Auto-lock · Password on send",
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
        SettingsRowId::AppLock,
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
pub use optn_platform::{HardwareTransport, HardwareVendor, TransportSupport};

pub use optn_core::airgap::{
    classify_scanned_account, AirgapSigner, ScannedAccount, AIRGAP_SUBTITLE, AIRGAP_TITLE,
};
pub use optn_core::multisig::{Cosigner, MultisigPreview, MAX_COSIGNERS};

/// Transports a surface can be relied on to provide.
///
/// A Tauri WebView owns USB natively but exposes no WebHID; a browser tab is
/// the mirror image. Reachability is then a property of the device and the
/// transport together, not a single "is this desktop" flag — which is what
/// would otherwise hide Keystone, an air-gapped device that needs only a
/// camera, on phones.
pub fn transport_support(surface: AppSurface) -> TransportSupport {
    match surface {
        AppSurface::Desktop => TransportSupport {
            native_usb: true,
            camera: true,
            iframe: true,
            ..TransportSupport::NONE
        },
        AppSurface::Android | AppSurface::Ios => TransportSupport {
            camera: true,
            ..TransportSupport::NONE
        },
        AppSurface::Web => TransportSupport {
            web_hid: true,
            web_usb: true,
            web_ble: true,
            camera: true,
            iframe: true,
            ..TransportSupport::NONE
        },
        // A popup has no room for a device dance and no camera permission.
        AppSurface::Extension => TransportSupport::NONE,
    }
}

/// The live device session.
///
/// Ported field-for-field from the React `hardwareWallet` slice, which the
/// Rust target had no equivalent of: which device, whether it is attached
/// right now, the label it reports, the account it exported, and the Ledger
/// wire preference.
///
/// `vendor: None` means no device has been chosen — not "Ledger by default".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HardwareSessionState {
    pub vendor: Option<HardwareVendor>,
    /// Attached right now. Distinct from `vendor.is_some()`: a wallet can
    /// remember its device across restarts while nothing is plugged in.
    pub connected: bool,
    /// What the device calls itself, shown in Settings.
    pub device_label: Option<String>,
    /// The account xPub last exported from it. Public material only.
    pub account_xpub: Option<String>,
    /// Ledger only; ignored by every other vendor.
    pub ledger_link: LedgerLink,
}

impl HardwareSessionState {
    /// No device chosen. `const` so `AppState::for_surface` stays const.
    pub const fn new() -> Self {
        Self {
            vendor: None,
            connected: false,
            device_label: None,
            account_xpub: None,
            ledger_link: LedgerLink::Usb,
        }
    }

    /// Whether the Ledger wire choice should even be offered.
    pub fn offers_link_choice(&self) -> bool {
        matches!(self.vendor, Some(HardwareVendor::Ledger))
    }

    /// Forget the attachment but keep the chosen device, as
    /// `disconnectHardwareWallet` does: the wallet still knows what it is,
    /// it just is not talking to it.
    pub fn disconnect(&mut self) {
        self.connected = false;
        self.device_label = None;
        self.account_xpub = None;
    }
}

pub use optn_platform::LedgerLink;

/// A multisig wallet validated and previewed, ready to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultisigSetupPreview {
    pub wallet_name: String,
    pub policy: String,
    pub required: u8,
    pub total: u8,
    pub receive_address: String,
    pub receive_token_address: String,
    pub change_address: String,
    pub cosigner_names: Vec<String>,
}

/// Validate a cosigner set and derive the shared P2SH addresses.
///
/// Every cosigner runs this and must land on the same address; BIP-67 key
/// ordering in `optn-core` is what guarantees that regardless of the order
/// they were typed in.
pub fn multisig_setup_preview(
    network: Network,
    wallet_name: &str,
    required: u8,
    cosigners: &[Cosigner],
) -> Result<MultisigSetupPreview, String> {
    let wallet_name = wallet_name.trim();
    if wallet_name.is_empty() {
        return Err("Give the wallet a name.".into());
    }
    let preview = optn_core::multisig::multisig_preview(network, required, cosigners)
        .map_err(|error| error.to_string())?;
    Ok(MultisigSetupPreview {
        wallet_name: wallet_name.to_owned(),
        policy: preview.policy,
        required: preview.required,
        total: preview.total,
        receive_address: preview.receive.address,
        receive_token_address: preview.receive.token_address,
        change_address: preview.change.address,
        cosigner_names: preview.cosigner_names,
    })
}

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
        multisig_policy: None,
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
    fn create_and_import_walk_desktop_sections_with_back() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::Navigate(AppRoute::CreateWallet));
        assert_eq!(state.flow().create_step, CreateStep::Reveal);
        assert_eq!(state.flow().next_label, "I wrote it down");
        assert!(state.flow().can_advance);

        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().create_step, CreateStep::Confirm);
        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().create_step, CreateStep::Reveal);

        state.apply(AppAction::AdvanceOnboarding);
        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().create_step, CreateStep::Path);
        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().create_step, CreateStep::Name);
        assert!(!state.flow().can_advance);

        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().create_step, CreateStep::Path);
        state.apply(AppAction::GoBack);
        state.apply(AppAction::GoBack);
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Landing);

        state.apply(AppAction::Navigate(AppRoute::ImportWallet));
        assert_eq!(state.flow().import_step, ImportStep::Words);
        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().import_step, ImportStep::Path);
        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().import_step, ImportStep::Name);
        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().import_step, ImportStep::Path);
    }

    #[test]
    fn settings_drills_into_a_row_and_back_returns_to_the_list() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "settings-flow");
        state.apply(AppAction::Navigate(AppRoute::Settings));
        assert_eq!(state.flow().settings_focus, None);
        state.apply(AppAction::OpenSettingsRow(SettingsRowId::RebuildWallet));
        assert_eq!(
            state.flow().settings_focus,
            Some(SettingsRowId::RebuildWallet)
        );
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Settings);
        assert_eq!(state.flow().settings_focus, None);
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::WalletHome);
    }

    #[test]
    fn overlay_back_returns_to_the_tab_that_opened_it() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "flow-return");

        state.apply(AppAction::Navigate(AppRoute::Actions));
        state.apply(AppAction::Navigate(AppRoute::Flipstarter));
        assert_eq!(state.flow().return_to, Some(AppRoute::Actions));
        assert_eq!(state.flow().back_label, "Actions");
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Actions);

        state.apply(AppAction::Navigate(AppRoute::Explore));
        state.apply(AppAction::Navigate(AppRoute::Flipstarter));
        assert_eq!(state.flow().back_label, "Explore");
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Explore);

        state.apply(AppAction::Navigate(AppRoute::Explore));
        state.apply(AppAction::Navigate(AppRoute::FundMe));
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Explore);

        state.apply(AppAction::Navigate(AppRoute::WalletHome));
        state.apply(AppAction::Navigate(AppRoute::Receive));
        assert_eq!(state.flow().back_label, "Home");
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::WalletHome);

        state.apply(AppAction::Navigate(AppRoute::Send));
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::WalletHome);

        state.apply(AppAction::Navigate(AppRoute::History));
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::WalletHome);
    }

    #[test]
    fn shared_wallet_walks_policy_cosigners_confirm_with_back() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
        assert_eq!(state.flow().watch_only_kind, WatchOnlyKind::Single);

        state.apply(AppAction::SetWatchOnlyKind(WatchOnlyKind::Shared));
        assert_eq!(state.flow().multisig_step, MultisigStep::Policy);
        assert_eq!(state.flow().title, "Shared wallet");
        assert!(state.flow().can_advance);

        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().multisig_step, MultisigStep::Cosigners);
        state.apply(AppAction::AdvanceOnboarding);
        assert_eq!(state.flow().multisig_step, MultisigStep::Confirm);
        assert!(!state.flow().can_advance);

        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().multisig_step, MultisigStep::Cosigners);
        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().multisig_step, MultisigStep::Policy);
        state.apply(AppAction::GoBack);
        assert_eq!(state.flow().watch_only_kind, WatchOnlyKind::Single);
        assert_eq!(state.route, AppRoute::WatchOnlyWallet);
        state.apply(AppAction::GoBack);
        assert_eq!(state.route, AppRoute::Landing);
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
        assert!(chipnet.rows.contains(&SettingsRowId::AppLock));
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
    fn the_device_session_is_driven_by_typed_actions() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        assert_eq!(state.hardware, HardwareSessionState::new());

        // Connecting before choosing a device is refused rather than
        // inventing a vendor.
        state.apply(AppAction::HardwareConnected {
            label: "Nano X".into(),
            account_xpub: "xpub-under-test".into(),
        });
        assert!(!state.hardware.connected);
        assert!(state.notice.is_some());

        assert_eq!(
            state.reduce(AppAction::SelectHardwareVendor(Some(
                HardwareVendor::Ledger
            ))),
            Some(AppEvent::HardwareSessionChanged)
        );
        assert!(state.hardware.offers_link_choice());
        assert_eq!(
            state.reduce(AppAction::SetLedgerLink(LedgerLink::Bluetooth)),
            Some(AppEvent::HardwareSessionChanged)
        );
        assert_eq!(state.hardware.ledger_link, LedgerLink::Bluetooth);

        state.apply(AppAction::HardwareConnected {
            label: "Nano X".into(),
            account_xpub: "xpub-under-test".into(),
        });
        assert!(state.hardware.connected);
        assert_eq!(state.hardware.device_label.as_deref(), Some("Nano X"));

        // Switching device drops the previous device's answers, and clears a
        // Bluetooth preference that means nothing to a Trezor.
        state.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Trezor,
        )));
        assert!(!state.hardware.connected, "a Trezor is not the Ledger");
        assert_eq!(state.hardware.account_xpub, None);
        assert_eq!(state.hardware.ledger_link, LedgerLink::Usb);
        assert!(!state.hardware.offers_link_choice());
        assert_eq!(
            state.reduce(AppAction::SetLedgerLink(LedgerLink::Bluetooth)),
            None
        );

        // Disconnect keeps the device, forgets the attachment.
        state.apply(AppAction::HardwareConnected {
            label: "Model T".into(),
            account_xpub: "xpub-two".into(),
        });
        assert_eq!(
            state.reduce(AppAction::DisconnectHardware),
            Some(AppEvent::HardwareSessionChanged)
        );
        assert_eq!(state.hardware.vendor, Some(HardwareVendor::Trezor));
        assert!(!state.hardware.connected);
        assert_eq!(state.reduce(AppAction::DisconnectHardware), None);

        // Forgetting the device entirely.
        state.apply(AppAction::SelectHardwareVendor(None));
        assert_eq!(state.hardware, HardwareSessionState::new());
    }

    #[test]
    fn the_device_session_keeps_every_field_the_react_slice_had() {
        let mut session = HardwareSessionState::default();
        // No device chosen is None, not a defaulted Ledger.
        assert_eq!(session.vendor, None);
        assert!(!session.connected);
        assert!(!session.offers_link_choice());
        assert_eq!(session.ledger_link, LedgerLink::Usb);

        session.vendor = Some(HardwareVendor::Ledger);
        session.connected = true;
        session.device_label = Some("Nano X".into());
        session.account_xpub = Some("xpub-under-test".into());
        session.ledger_link = LedgerLink::Bluetooth;

        // The wire choice is Ledger's alone.
        assert!(session.offers_link_choice());
        assert_eq!(session.ledger_link.label(), "Bluetooth");
        assert_eq!(
            session.ledger_link.transport(),
            HardwareTransport::WebBle,
            "Bluetooth must not be reported as a cable"
        );

        // Disconnecting forgets the attachment, not the device.
        session.disconnect();
        assert_eq!(session.vendor, Some(HardwareVendor::Ledger));
        assert!(!session.connected);
        assert_eq!(session.device_label, None);
        assert_eq!(session.account_xpub, None);

        let mut trezor = HardwareSessionState {
            vendor: Some(HardwareVendor::Trezor),
            ..HardwareSessionState::default()
        };
        assert!(
            !trezor.offers_link_choice(),
            "only Ledger has a wire to choose"
        );
        trezor.disconnect();
        assert_eq!(trezor.vendor, Some(HardwareVendor::Trezor));
    }

    #[test]
    fn a_multisig_wallet_is_previewed_from_cosigner_accounts() {
        let cosigners: Vec<Cosigner> = (0..3)
            .map(|account| {
                let wallet = optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
                    .expect("mnemonic");
                Cosigner {
                    name: String::new(),
                    account_xpub: wallet
                        .account_xpub(Network::Chipnet, account)
                        .expect("xpub"),
                    master_fingerprint: None,
                }
            })
            .collect();

        let preview = multisig_setup_preview(Network::Chipnet, "shared funds", 2, &cosigners)
            .expect("2-of-3 is valid");
        assert_eq!(preview.policy, "2 of 3");
        assert_eq!((preview.required, preview.total), (2, 3));
        assert!(preview.receive_address.starts_with("bchtest:p"), "P2SH");
        assert_ne!(preview.receive_address, preview.change_address);
        assert_eq!(
            preview.cosigner_names,
            vec!["Cosigner 1", "Cosigner 2", "Cosigner 3"]
        );

        // Order-independence is the whole point: cosigners type each other in
        // whatever order and must still land on one wallet.
        let mut shuffled = cosigners.clone();
        shuffled.reverse();
        let same = multisig_setup_preview(Network::Chipnet, "shared funds", 2, &shuffled)
            .expect("still valid");
        assert_eq!(preview.receive_address, same.receive_address);

        assert!(multisig_setup_preview(Network::Chipnet, "", 2, &cosigners).is_err());
        assert!(multisig_setup_preview(Network::Chipnet, "n", 4, &cosigners).is_err());
    }

    #[test]
    fn opening_a_multisig_wallet_keeps_its_policy_and_cannot_sign_alone() {
        let cosigners: Vec<Cosigner> = (0..3)
            .map(|account| {
                let wallet = optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
                    .expect("mnemonic");
                Cosigner {
                    name: String::new(),
                    account_xpub: wallet
                        .account_xpub(Network::Chipnet, account)
                        .expect("xpub"),
                    master_fingerprint: None,
                }
            })
            .collect();
        let preview = multisig_setup_preview(Network::Chipnet, "treasury", 2, &cosigners)
            .expect("2-of-3 preview");

        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::OpenMultisigWallet(preview.clone()));

        assert_eq!(state.route, AppRoute::WalletHome);
        let opened = state.wallet.as_ref().expect("multisig wallet opened");
        assert_eq!(opened.receive_address, preview.receive_address);
        assert_eq!(opened.multisig_policy.as_deref(), Some("2 of 3"));
        // The policy does not squat in the derivation field.
        assert_eq!(opened.account_path, "m/44'/1'/0'");
        // This device holds public cosigner accounts only, so it can never
        // reach the threshold by itself.
        assert_eq!(opened.kind, WalletKind::WatchOnly);
        assert_eq!(
            opened.spending_capability(),
            SpendingCapability::WatchOnly,
            "a multisig wallet must plan an unsigned PSBT for the cosigners"
        );
    }

    #[test]
    fn transports_decide_reachability_so_keystone_survives_on_a_phone() {
        // The old capability matrix collapsed every device into one
        // desktop-only switch. Keystone needs a camera, not a cable.
        let phone = transport_support(AppSurface::Android);
        assert!(HardwareVendor::Keystone.is_reachable_with(phone));
        assert!(!HardwareVendor::Ledger.is_reachable_with(phone));

        let desktop = transport_support(AppSurface::Desktop);
        for vendor in HardwareVendor::OFFERED {
            assert!(vendor.is_reachable_with(desktop), "{vendor:?} on desktop");
        }

        // A browser has WebHID but no native USB, and still reaches a Ledger.
        assert!(HardwareVendor::Ledger.is_reachable_with(transport_support(AppSurface::Web)));

        // A popup reaches nothing, and says why rather than blaming the cable.
        let popup = transport_support(AppSurface::Extension);
        assert!(!HardwareVendor::Keystone.is_reachable_with(popup));
        assert!(HardwareVendor::Keystone
            .unreachable_reason(popup)
            .is_some_and(|reason| reason.contains("camera")));
    }

    #[test]
    fn hardware_is_a_desktop_capability_end_to_end() {
        // Desktop offers it; every other surface refuses the route and the
        // open, so a renderer bug cannot strand funds behind a device the
        // surface cannot reach.
        let desktop = AppState::for_surface(AppSurface::Desktop);
        let vm = hardware_view_model(&desktop);
        assert!(vm.available);
        assert_eq!(vm.vendors, HardwareVendor::OFFERED.to_vec());
        assert!(!vm.vendors.contains(&HardwareVendor::Mock));
        // Devices are reached through Watch Only, matching the React shell:
        // the desktop watch-only card is where a device, a cosigner set, or a
        // pasted xPub all produce the same kind of wallet. There is no
        // standalone hardware route to navigate to.
        assert_eq!(
            OnboardingAction::ConnectHardwareWallet.route(),
            Some(AppRoute::WatchOnlyWallet),
            "the landing action must lead into Watch Only"
        );
        assert_eq!(
            OnboardingAction::ConnectHardwareWallet.href(),
            Some("#/watch-only")
        );

        // Off desktop the section offers nothing, so a renderer cannot paint
        // a device picker where no device can be reached.
        for surface in [
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            let state = AppState::for_surface(surface);
            let vm = hardware_view_model(&state);
            assert!(!vm.available, "{surface:?}");
            assert!(vm.vendors.is_empty(), "{surface:?} must offer no devices");
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

    #[test]
    fn never_mode_password_popup_is_only_on_send_after_ten_minutes() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "lock");
        assert_eq!(state.lock.auto_lock, AutoLockMinutes::Never);
        assert!(AppLockState::secrets_are_ciphertext(
            state.wallet.as_ref().map(|wallet| wallet.kind)
        ));

        state.apply(AppAction::RecordActivity { now_ms: 1_000 });
        state.apply(AppAction::AuthorizeSpend { now_ms: 1_000 });
        assert_eq!(state.lock.prompt, None, "first send after unlock is free");
        assert_eq!(
            state.reduce(AppAction::AuthorizeSpend {
                now_ms: 1_000 + SPEND_AUTH_TTL_MS,
            }),
            Some(AppEvent::AuthRequired)
        );
        assert_eq!(state.lock.prompt, Some(AuthScope::Spend));

        state.apply(AppAction::ConfirmAuth {
            now_ms: 1_000 + SPEND_AUTH_TTL_MS,
        });
        assert_eq!(state.lock.prompt, None);
        state.apply(AppAction::AuthorizeSpend {
            now_ms: 1_000 + SPEND_AUTH_TTL_MS + 1,
        });
        assert_eq!(state.lock.prompt, None, "successful auth resets the window");

        state.apply(AppAction::RequestReveal { now_ms: 2_000 });
        assert_eq!(state.lock.prompt, Some(AuthScope::Reveal));
        state.apply(AppAction::GoBack);
        assert_eq!(state.lock.prompt, None);

        let later = 1_000 + SPEND_AUTH_TTL_MS * 2 + 2;
        state.apply(AppAction::AuthorizeBackground { now_ms: later });
        assert_eq!(
            state.lock.prompt, None,
            "CashFusion / auto-fusion must not re-prompt"
        );
        state.apply(AppAction::AuthorizeChat { now_ms: later });
        assert_eq!(state.lock.prompt, None, "chat must not re-prompt");
        state.apply(AppAction::AuthorizeSpend { now_ms: later });
        assert_eq!(state.lock.prompt, Some(AuthScope::Spend));
    }

    #[test]
    fn timer_auto_lock_skips_spend_prompt_and_idle_returns_to_the_picker() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "idle");
        state.apply(AppAction::SetAutoLockMinutes(1));
        assert_eq!(state.lock.auto_lock, AutoLockMinutes::Never);
        state.apply(AppAction::SetAutoLockMinutes(15));
        assert_eq!(state.lock.auto_lock, AutoLockMinutes::Fifteen);

        state.apply(AppAction::RecordActivity { now_ms: 1_000 });
        state.apply(AppAction::AuthorizeSpend { now_ms: 1_000 });
        assert_eq!(state.lock.prompt, None);

        state.apply(AppAction::IdleCheck {
            now_ms: 1_000 + 15 * 60_000,
        });
        assert_eq!(state.route, AppRoute::Landing);
        assert!(state.wallet.is_none());
        assert!(state.coins.is_empty());
    }

    #[test]
    fn lock_now_wipes_the_session_and_voids_spend_auth() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "lock-now");
        state.apply(AppAction::RecordActivity { now_ms: 50 });
        state.apply(AppAction::LockWallet);
        assert_eq!(state.route, AppRoute::Landing);
        assert!(state.wallet.is_none());
        assert!(!state.lock.spend_auth_still_valid(50));
    }
}
