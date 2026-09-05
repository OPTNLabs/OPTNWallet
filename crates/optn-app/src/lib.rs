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

impl AppSurface {
    /// Whether this surface may build and submit a transaction at all.
    ///
    /// The browser extension is a **read-only viewer**, and the release that
    /// introduced it made that a fail-closed boundary rather than a hidden
    /// button: "spending/signing routes and lifecycle services are not mounted,
    /// and transaction submission fails closed". It ships without a secure key
    /// lifecycle designed for a popup, so a build that merely *looks* unable to
    /// spend is the thing that was ruled out.
    ///
    /// Hiding Actions from the popup's navigation is not this rule. Navigation
    /// is a renderer's business, and a renderer cannot be trusted with a
    /// security boundary -- which is the whole reason the application owns the
    /// decision and every renderer asks.
    pub const fn can_spend(self) -> bool {
        !matches!(self, Self::Extension)
    }

    /// The other half of the same sentence, for a caller that reads better this
    /// way.
    pub const fn is_viewer_only(self) -> bool {
        !self.can_spend()
    }

    /// Whether this surface offers Watch Only onboarding.
    ///
    /// True everywhere today, and written out per surface rather than as a
    /// blanket `true` so withdrawing it from one platform later is a single
    /// line here instead of a restructure.
    ///
    /// Watch Only is the air-gap entry point, not a reduced kind of wallet, so
    /// the default is to offer it. It needs no transport -- an account xPub can
    /// be pasted -- which is why it reaches surfaces that can neither open a
    /// USB device nor a camera.
    #[allow(
        clippy::match_like_matches_macro,
        reason = "the per-surface shape is the feature; today's values all being true is not"
    )]
    pub const fn offers_watch_only(self) -> bool {
        match self {
            Self::Desktop => true,
            Self::Android => true,
            Self::Ios => true,
            Self::Web => true,
            Self::Extension => true,
        }
    }

    /// Whether this surface offers hardware-wallet onboarding.
    ///
    /// Desktop only today, and the reason matters because it is not the one it
    /// looks like. This is **not** "the other platforms cannot reach a device":
    ///
    /// - Ledger, Trezor and OneKey variously speak USB, Bluetooth and NFC, and
    ///   the Ledger wire choice is already modelled per wallet.
    /// - Android supports USB host mode, so a phone can hold a cable device.
    /// - Keystone needs only a camera, which every phone has, and
    ///   `transport_support` already says so.
    ///
    /// What is missing is the *integration*, and it differs per platform and
    /// per vendor: a browser extension may need a TypeScript library or a wasm
    /// build where an Android app needs a native plugin and the desktop shell
    /// owns USB in Rust. That is a research question, not a settled one, so
    /// this is switched off where the work has not been done rather than
    /// claimed impossible.
    #[allow(
        clippy::match_like_matches_macro,
        reason = "each surface is its own decision to make as the integrations land"
    )]
    pub const fn offers_hardware_wallet(self) -> bool {
        match self {
            Self::Desktop => true,
            // A browser tab and an extension popup both reach three of the
            // five devices today: a Ledger over WebHID, a OneKey through its
            // own web SDK, and a Keystone by camera. The extension is where
            // people reach for a hardware wallet -- it is what they do with
            // MetaMask -- so switching it off there was the wrong default.
            Self::Web => true,
            Self::Extension => true,
            // No native plugin on either yet. Not a claim that a phone cannot
            // reach a device: an Android can hold a cable, both have radios,
            // both have NFC, and a Tangem is a phone-only device. The work is
            // simply not done.
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

/// User overrides. `None` means "use the surface default" — not a nullable bool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureFlags {
    pub cash_fusion: Option<bool>,
    pub hardware_wallet: Option<bool>,
    pub watch_only: Option<bool>,
}

impl FeatureFlags {
    /// Which surfaces may offer a flag at all, before any user override.
    ///
    /// CashFusion is desktop-only because it needs a long-lived background
    /// process the other shells do not have.
    ///
    /// Hardware is desktop-only for a different and less permanent reason: the
    /// vendor integrations only exist there yet. It is *not* that the other
    /// platforms cannot reach a device. Ledger, Trezor and OneKey variously
    /// speak USB, Bluetooth and NFC; Android supports USB host mode; and
    /// Keystone needs only a camera, which every phone has. What differs per
    /// platform is the library — a browser extension may need TypeScript or
    /// wasm where an Android app needs something else again — and that is
    /// unresearched rather than decided. See `offers_hardware_wallet`.
    ///
    /// Watch Only is different in kind and is offered everywhere. It is how an
    /// air-gapped device is added -- SeedCash and Keystone both arrive through
    /// it -- and unlike hardware it needs no transport at all, because an
    /// account xPub can be pasted. A popup with no camera and no USB can still
    /// watch a cold wallet, which is exactly the case for the extension.
    pub const fn surface_allows(surface: AppSurface, flag: FeatureFlag) -> bool {
        match flag {
            FeatureFlag::CashFusion => matches!(surface, AppSurface::Desktop),
            FeatureFlag::HardwareWallet => surface.offers_hardware_wallet(),
            FeatureFlag::WatchOnly => surface.offers_watch_only(),
        }
    }

    /// Whether this flag is on here, given the surface's default and any
    /// explicit choice made over it.
    ///
    /// Hardware is **hidden on a phone, not forbidden**. Everything behind it
    /// ships: the transports are described per device, the integrations are
    /// listed per surface, and a Keystone is reached by camera, which a phone
    /// has. What is missing is a native plugin for the cabled devices, so the
    /// *default* is off -- and a default is something an explicit choice
    /// overrides. Switching it on reveals exactly the devices that surface can
    /// actually drive, which on a phone today is the air-gapped one.
    ///
    /// The other two clamp instead, and for a reason rather than by symmetry.
    /// CashFusion needs a long-lived background process a phone shell does not
    /// have, so turning it on could not make it work. Watch Only is already
    /// allowed on every surface, so it has no hidden state to reveal. Only
    /// hardware has somewhere to go when it is switched on.
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
    /// App-wide fee policy. Providers may advise Auto, but never own this preference.
    pub fee_preferences: FeePreferences,
    /// The connected device, if any. Separate from the opened wallet: a
    /// wallet remembers which device it belongs to while nothing is plugged in.
    pub hardware: HardwareSessionState,
    /// Per-network server overrides. Absent means the network default.
    pub servers: ServerOverrides,
    /// Whether Settings is currently showing the identifying wallet fields.
    /// Cleared by locking, so a reveal never outlives the unlocked session.
    pub identity_revealed: bool,
    /// RPA stealth sats. Deliberately not in `coins`: they are a separate
    /// pool, added to the portfolio total rather than counted as UTXOs.
    pub stealth_sats: u64,
    /// The connect control and whatever a paired session is waiting on.
    pub connect: ConnectState,
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
    /// The account xPub this wallet watches, when it is known.
    ///
    /// Present for watch-only, hardware and air-gapped wallets, which are
    /// created from one. Absent for a seed wallet, whose xPub would have to be
    /// re-derived from a seed this crate does not hold. Public material, but
    /// identifying, so Settings keeps it behind the reveal gate.
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
            fee_preferences: FeePreferences::app_default(),
            hardware: HardwareSessionState::new(),
            servers: ServerOverrides::new(),
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
    SetFeeMode(FeeMode),
    SetCustomFeeRate(FeeRate),
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
    /// The account the device should derive from. `None` clears the choice and
    /// returns the device to the wallet's own account.
    SetHardwareDerivationPath(Option<AccountPath>),
    /// A device answered. Public material only.
    HardwareConnected {
        label: String,
        account_xpub: String,
    },
    /// Forget the attachment, keep the chosen device.
    DisconnectHardware,
    /// Hide the identifying wallet fields again. Needs no authorisation.
    HideWalletIdentity,
    /// Record the RPA stealth balance a scan found.
    SetStealthSats(u64),
    /// Point one endpoint at a user-run server. An empty entry clears it.
    SetServer {
        kind: ServerKind,
        entry: String,
    },
    /// Drop every override for the selected network.
    UseNetworkDefaultServers,
    PrepareSend {
        destination: String,
        amount_sats: u64,
        /// Coin control: spend this coin specifically. `None` selects
        /// automatically.
        #[allow(clippy::option_option)]
        coin: Option<Outpoint>,
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
    FeePreferencesChanged(FeePreferences),
    NetworkChanged(Network),
    HelpVisibilityChanged(bool),
    SurfaceChanged(AppSurface),
    FeatureFlagChanged { flag: FeatureFlag, enabled: bool },
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
            AppAction::SetFeeMode(mode) if self.fee_preferences.mode != mode => {
                self.fee_preferences.mode = mode;
                Some(AppEvent::FeePreferencesChanged(self.fee_preferences))
            }
            AppAction::SetCustomFeeRate(rate) if self.fee_preferences.custom_rate != rate => {
                self.fee_preferences.custom_rate = rate;
                Some(AppEvent::FeePreferencesChanged(self.fee_preferences))
            }
            AppAction::SetNetwork(network) if self.network != network => {
                self.network = network;
                // Coins belong to a chain. Keeping them across a switch would
                // count chipnet coins as a mainnet balance and let a spend
                // plan select one, so the derived state is cleared exactly as
                // the settings copy promises: switching "clears the active
                // network records ... and resynchronizes receive/change
                // addresses". The wallet itself stays open; it has not become
                // a different wallet, only an unsynced one.
                self.coins.clear();
                self.pledges.clear();
                self.spend = None;
                self.stealth_sats = 0;
                // A paired session is bound to the chain it paired on. A
                // request carried across the switch would be answered against
                // coins that are not the ones it was built from.
                self.connect.cancel_all();
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
                // Hardware is the one flag that may be switched on where the
                // surface default is off -- otherwise the setter would store
                // `Some(false)` for a request to turn it on, and the toggle
                // would silently do nothing. The other two clamp, because a
                // surface that does not allow them has no way to run them.
                let wanted = match flag {
                    FeatureFlag::HardwareWallet => enabled,
                    FeatureFlag::CashFusion | FeatureFlag::WatchOnly => {
                        enabled && FeatureFlags::surface_allows(self.surface, flag)
                    }
                };
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
                    account_xpub: Some(preview.account_xpub),
                });
                self.spend = None;
                self.notice = None;
                self.return_to = None;
                self.route = AppRoute::WalletHome;
                self.lock.mark_unlocked();
                Some(AppEvent::WalletOpened)
            }
            AppAction::SetStealthSats(sats) => {
                if self.stealth_sats == sats {
                    return None;
                }
                self.stealth_sats = sats;
                Some(AppEvent::CoinsChanged)
            }
            AppAction::HideWalletIdentity => {
                if !self.identity_revealed {
                    return None;
                }
                self.identity_revealed = false;
                Some(AppEvent::AppLockChanged)
            }
            AppAction::SetServer { kind, entry } => {
                // Scoped to the selected network, so a chipnet host cannot be
                // written into mainnet's slot.
                match self.servers.set(self.network, kind, &entry) {
                    Ok(_) => Some(AppEvent::ServersChanged),
                    Err(message) => self.reject(message),
                }
            }
            AppAction::UseNetworkDefaultServers => {
                if self.servers.use_network_default(self.network) {
                    Some(AppEvent::ServersChanged)
                } else {
                    None
                }
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
            AppAction::SetHardwareDerivationPath(account) => {
                if self.hardware.vendor.is_none() {
                    return self.reject("Choose a device first.".into());
                }
                if self.hardware.derivation_path == account {
                    return None;
                }
                self.hardware.derivation_path = account;
                // The exported account belonged to the old path. Keeping it
                // would show one account's xPub beside another's path.
                self.hardware.account_xpub = None;
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
                    // A shared wallet has a cosigner set, not one account key.
                    account_xpub: None,
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
                    account_xpub: Some(preview.account_xpub),
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
                coin,
            } => {
                let Some(wallet) = self.wallet.as_ref() else {
                    return self.reject("open a wallet first".into());
                };
                // A viewer may still build an *unsigned* PSBT. Nothing is spent
                // by doing so: a watch-only wallet holds no key, the signing
                // happens on an air-gapped device, and refusing here would mean
                // a seed signer could not be used from a popup for no reason
                // beyond the build it was opened in. What a viewer must not do
                // is sign, and a wallet that could sign is refused below.
                if self.surface.is_viewer_only()
                    && wallet.spending_capability() == SpendingCapability::Seed
                {
                    return self
                        .reject("this build can view a wallet but not spend from it".into());
                }
                let fee_rate = self
                    .fee_preferences
                    .resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE);
                match prepare_spend_with_fee_and_coin(
                    &self.coins,
                    self.network,
                    &destination,
                    amount_sats,
                    wallet.spending_capability(),
                    fee_rate,
                    coin,
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
                        self.identity_revealed = true;
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
            | AppAction::SetFeeMode(_)
            | AppAction::SetCustomFeeRate(_)
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
            // A seed wallet's xPub would have to be re-derived from a seed
            // this crate does not keep.
            account_xpub: None,
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
        // A reveal must never outlive the unlocked session: coming back to a
        // locked wallet showing its xPub would defeat the gate entirely.
        self.identity_revealed = false;
        self.wallet = None;
        self.spend = None;
        self.coins.clear();
        self.pledges.clear();
        // The RPA pool is wallet balance too, and it is the half that does not
        // live in the UTXO set -- so clearing the coins alone left a locked
        // wallet still showing a portfolio total. PR #6 made "no wallet is open
        // unless its key is cached" an invariant precisely so a closed wallet
        // cannot keep driving the UI.
        self.stealth_sats = 0;
        // A request belongs to the session that raised it, and that session
        // belonged to this wallet. Carrying one across the lock would ask the
        // next wallet to sign something it never saw.
        self.connect.cancel_all();
        // The exported account belongs to the wallet that was open. The device
        // stays chosen and stays plugged in, but carrying one wallet's xPub
        // into the next one would attribute an identity to the wrong wallet.
        self.hardware.account_xpub = None;
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
        // Fail closed on the signing half too, not only on building the
        // transaction: a viewer that can authorise a spend is a viewer that
        // spends as soon as anything downstream forgets to check.
        if scope == AuthScope::Spend && self.surface.is_viewer_only() {
            return self.reject("this build can view a wallet but not spend from it".into());
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

/// The animated-QR fragment sizes this surface offers.
///
/// A desktop gets the full range; a phone gets Paytaca's shorter, lower list.
/// The split is not a judgement about screens -- it is that a phone fleet is
/// thousands of different cameras, and the ones that fail belong to people who
/// are not in the room when it is tested. Paytaca measured theirs against such
/// a fleet and expect to lower the minimum further for weaker devices, so the
/// mobile list is their current answer rather than a constant.
///
/// The extension has no camera and shows no scanner at all. It is given the
/// mobile list for the case where a shell later grants one, rather than an
/// empty list that would read as "no options" instead of "no scanner".
pub fn qr_fragment_options(surface: AppSurface) -> &'static [usize] {
    match surface {
        AppSurface::Desktop | AppSurface::Web => SeedCashQr::FRAGMENT_OPTIONS,
        AppSurface::Android | AppSurface::Ios | AppSurface::Extension => MOBILE_FRAGMENT_OPTIONS,
    }
}

/// What to call a fragment size on this surface.
///
/// A desktop has room for "Highest density (fewest frames)"; a phone gets one
/// word. The same numbers where they overlap, different words, because the
/// control is a different size.
pub fn qr_fragment_label(surface: AppSurface, fragment: usize) -> Option<&'static str> {
    match surface {
        AppSurface::Desktop | AppSurface::Web => SeedCashQr::fragment_label(fragment),
        AppSurface::Android | AppSurface::Ios | AppSurface::Extension => {
            mobile_fragment_label(fragment)
        }
    }
}

/// The fragment size to start on.
///
/// The lowest the surface offers, on every one. It is the size a SeedCash
/// camera was observed to read, and starting denser to save a few seconds is a
/// trade made against whoever's device cannot manage it -- who then has no way
/// to know that turning the density down is the fix.
pub fn default_qr_fragment(surface: AppSurface) -> usize {
    qr_fragment_options(surface)
        .first()
        .copied()
        .unwrap_or(SeedCashQr::CHUNK_SIZE)
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

/// The portfolio total, with the stealth pool kept separate from the UTXOs.
pub fn portfolio_totals(state: &AppState) -> PortfolioTotals {
    PortfolioTotals {
        spendable_sats: state.coins.spendable_sats(),
        reserved_sats: state.coins.reserved_sats(),
        stealth_sats: state.stealth_sats,
    }
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
    Device,
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
            Self::Device => "Hardware device",
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
            Self::Device => "Connected signer, its label, and how it is reached",
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
    /// The endpoint actually in force: an override, or the network default.
    pub electrum_endpoint: String,
    /// Whether this network has any user-set server.
    pub servers_are_custom: bool,
    /// The device session, so Settings can show every field it holds.
    pub hardware: HardwareSessionState,
    /// The account the device will actually derive from, already resolved.
    ///
    /// A renderer shows this without holding the fallback rule, which is what
    /// stopped the React screens from each having to compare against the
    /// sentinel and one of them forgetting.
    pub hardware_derivation_path: String,
    /// Set when the device's chosen account is one this network never scans.
    ///
    /// A warning, not a correction: the path may be exactly what was meant.
    pub hardware_path_warning: Option<String>,
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
    // Only where a device can actually be reached; a row that can never do
    // anything is worse than no row.
    if state
        .features
        .enabled(state.surface, FeatureFlag::HardwareWallet)
    {
        rows.push(SettingsRowId::Device);
    }
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
        electrum_endpoint: state.servers.effective_electrum(state.network),
        servers_are_custom: !state.servers.for_network(state.network).is_empty(),
        hardware_derivation_path: {
            let wallet_account = state
                .wallet
                .as_ref()
                .and_then(|wallet| parse_account_path(&wallet.account_path).ok())
                .unwrap_or_else(|| AccountPath::default_for(state.network));
            state.hardware.effective_path(wallet_account).path()
        },
        hardware_path_warning: state.hardware.path_warning(state.network).map(|account| {
            format!(
                "{} is not an account this wallet scans on {}. It is kept as chosen.",
                account.path(),
                state.network
            )
        }),
        hardware: state.hardware.clone(),
        show_cash_fusion,
        rows,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOnlySetupPreview {
    pub wallet_name: String,
    /// The account xPub this preview was built from.
    pub account_xpub: String,
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
        account_xpub: account_xpub.trim().to_owned(),
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

pub use optn_core::airgap::{classify_scanned_account, AccountEntry, ScannedAccount};
pub use optn_core::multisig::{Cosigner, MultisigPreview, MAX_COSIGNERS};
pub use optn_core::psbt::{
    mobile_fragment_label, QrAnimation, SeedCashQr, MOBILE_FRAGMENT_OPTIONS,
};

/// Transports a surface can be relied on to provide.
///
/// A Tauri WebView owns USB natively but exposes no WebHID; a browser tab is
/// the mirror image. Reachability is then a property of the device and the
/// transport together, not a single "is this desktop" flag — which is what
/// would otherwise hide Keystone, an air-gapped device that needs only a
/// camera, on phones.
pub fn transport_support(surface: AppSurface) -> TransportSupport {
    match surface {
        // A cable, a radio, a camera and a card reader.
        //
        // Not NFC. No laptop has a reader built in, and the ones people add
        // arrive over USB -- which means trusting an arbitrary USB device to
        // sit in the path between the wallet and a signing device. That is a
        // meaningful thing to be wrong about, so the reader is not probed for
        // and the option is not offered. Someone who owns one can still use
        // the cable.
        AppSurface::Desktop => TransportSupport {
            native_usb: true,
            native_ble: true,
            camera: true,
            micro_sd: true,
            iframe: true,
            ..TransportSupport::NONE
        },
        // A phone with USB host mode, a radio, NFC and a camera -- everything
        // except a card slot.
        AppSurface::Android => TransportSupport {
            native_usb: true,
            native_ble: true,
            nfc: true,
            camera: true,
            ..TransportSupport::NONE
        },
        // iOS gives an app no USB path to a wallet, so Bluetooth and NFC are
        // the wired-equivalents here, plus the camera.
        AppSurface::Ios => TransportSupport {
            native_ble: true,
            nfc: true,
            camera: true,
            ..TransportSupport::NONE
        },
        // A browser tab has the web transports and a camera, and no NFC.
        AppSurface::Web => TransportSupport {
            web_hid: true,
            web_usb: true,
            web_ble: true,
            camera: true,
            iframe: true,
            ..TransportSupport::NONE
        },
        // A popup can ask for WebHID and WebUSB, which is a device dance it
        // can complete, and it can ask for a camera too.
        //
        // The camera was left out here on the assumption that an extension
        // cannot have one. MetaMask disproves it: its extension connects a
        // Keystone by scanning animated QR with the computer's webcam, and
        // Keystone's own documentation says the QR protocol "can only be used
        // when a camera (webcam) is installed on the computer". Since an
        // extension is where people expect to reach for a hardware wallet,
        // getting this wrong would hide the one device that needs no driver,
        // no cable and no vendor daemon.
        //
        // Still no NFC: a browser has no card-tap API, which is why a Tangem
        // does not appear here and a Keystone does.
        AppSurface::Extension => TransportSupport {
            web_hid: true,
            web_usb: true,
            camera: true,
            ..TransportSupport::NONE
        },
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
    /// The account the device was told to use, when the user chose one.
    ///
    /// `None` means they never did, and the wallet's own account is used
    /// instead. The React slice had to express that with a sentinel --
    /// `UNSET_DERIVATION_PATH = "m/44'/145'/0'"` -- and every reader had to
    /// compare against that exact literal, with a comment warning that "an
    /// equal-looking expression here would silently stop matching if either
    /// side moved". The sentinel is also a *mainnet* path, so a reader that
    /// forgot the comparison showed `…/145'/…` to a chipnet wallet.
    ///
    /// `Option` says the same thing with nothing to compare against.
    pub derivation_path: Option<AccountPath>,
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
            derivation_path: None,
            ledger_link: LedgerLink::Usb,
        }
    }

    /// Whether the Ledger wire choice should even be offered.
    pub fn offers_link_choice(&self) -> bool {
        matches!(self.vendor, Some(HardwareVendor::Ledger))
    }

    /// The account this device will actually derive from.
    ///
    /// The wallet's own when the user never chose one, which is what keeps a
    /// mainnet literal off a chipnet wallet's settings screen.
    pub fn effective_path(&self, wallet_account: AccountPath) -> AccountPath {
        self.derivation_path.unwrap_or(wallet_account)
    }

    /// A chosen account that this network would never scan.
    ///
    /// Returned rather than corrected: the path may be exactly what the user
    /// meant, and silently swapping it is how a device signs for an account
    /// nobody asked for. `None` when there is nothing to warn about.
    pub fn path_warning(&self, network: Network) -> Option<AccountPath> {
        self.derivation_path
            .filter(|account| !account.is_scanned_for(network))
    }

    /// Forget the attachment but keep the chosen device, as
    /// `disconnectHardwareWallet` does: the wallet still knows what it is,
    /// it just is not talking to it.
    pub fn disconnect(&mut self) {
        self.connected = false;
        self.device_label = None;
        self.account_xpub = None;
        // The chosen account survives: unplugging a device does not undo a
        // setting, and re-plugging it should not silently derive elsewhere.
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
    /// The account xPub the device exported.
    pub account_xpub: String,
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
        account_xpub: watch.account_xpub,
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

/// Whether this wallet can actually drive that device on that surface.
///
/// The third thing a picker needs, and the one that was missing. The device's
/// own transports say what it can do; [`transport_support`] says what the
/// runtime offers; this says whether the code to join them exists yet. All
/// three are needed, because a device that is reachable in principle and has
/// no integration still fails when someone taps it -- which is worse than not
/// offering it, since the user goes looking for a cable that was never the
/// problem.
///
/// Read off the services rather than aspirations:
///
/// - **Ledger** ships browser transports of its own, `hw-transport-webhid` and
///   `hw-transport-web-ble`, plus the native path on desktop.
/// - **OneKey** has `@onekeyfe/hd-web-sdk` for browsers and shares Trezor's
///   native session on desktop, being a Trezor derivative.
/// - **Keystone** needs no vendor library at all. It is animated QR, so it
///   works wherever there is a camera and nothing else has to be true.
/// - **Trezor** is desktop-only right now. Its browser path went out with
///   `@trezor/connect-web`, whose dependency chain carried the whole Stellar
///   SDK, and is being rebuilt on `@trezor/transport`.
/// - **Tangem** has no integration anywhere yet, and both of its JavaScript
///   bridges are archived, so it needs native code on each phone.
pub const fn hardware_integration_ready(vendor: HardwareVendor, surface: AppSurface) -> bool {
    matches!(
        (vendor, surface),
        (HardwareVendor::Keystone, _)
            | (
                HardwareVendor::Ledger | HardwareVendor::OneKey,
                AppSurface::Desktop | AppSurface::Web | AppSurface::Extension
            )
            | (HardwareVendor::Trezor, AppSurface::Desktop)
    )
}

/// The devices this surface can actually drive, in the order they are listed.
///
/// Two filters, and each removes something the other cannot see: the device
/// has to be reachable on this runtime's transports, and the integration has
/// to exist. A Tangem drops out on a desktop because no laptop taps a card; a
/// Trezor drops out in a browser because the code is not written yet. Neither
/// needs a rule naming it.
///
/// Deliberately *not* filtered by whether hardware is switched on here. That
/// is the flag's question and the caller's to ask -- keeping it out means this
/// answers "what could this surface reach", so a phone whose hardware section
/// has been switched on gets the devices it can genuinely drive rather than an
/// empty list. Today that is the Keystone: a camera is a camera, and the
/// air-gapped device needs no plugin the phone does not have.
pub fn hardware_vendors_for(surface: AppSurface) -> Vec<HardwareVendor> {
    let support = transport_support(surface);
    HardwareVendor::OFFERED
        .iter()
        .copied()
        .filter(|vendor| vendor.is_reachable_with(support))
        .filter(|vendor| hardware_integration_ready(*vendor, surface))
        .collect()
}

pub fn hardware_view_model(state: &AppState) -> HardwareViewModel {
    let available = state
        .features
        .enabled(state.surface, FeatureFlag::HardwareWallet);
    HardwareViewModel {
        layout: state.layout(),
        network: state.network,
        // Only the devices this surface can actually drive. An empty list
        // is the honest answer when the flag is off, and a short list is the
        // honest answer when only some devices are reachable -- painting all
        // five everywhere sent people to buy a cable that was never going to
        // help.
        vendors: if available {
            hardware_vendors_for(state.surface)
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
        account_xpub: None,
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

    /// Two cosigners with fingerprints, built from the shared test mnemonic.
    ///
    /// The descriptor tests live in optn-core beside the parser; these live
    /// here because optn-core carries no dev-dependencies on purpose -- it is
    /// excluded from the workspace, verified by Kani and built for wasm, and
    /// keeping it dependency-free is worth more than test proximity.
    fn descriptor_cosigners() -> Vec<optn_core::multisig::Cosigner> {
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        vec![
            optn_core::multisig::Cosigner {
                name: "Ada".into(),
                account_xpub: wallet.account_xpub(Network::Chipnet, 0).expect("xpub"),
                master_fingerprint: Some("4c9a1f7b".into()),
            },
            optn_core::multisig::Cosigner {
                name: "Bo".into(),
                account_xpub: wallet.account_xpub(Network::Chipnet, 1).expect("xpub"),
                master_fingerprint: Some("0f1e2d3c".into()),
            },
        ]
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(256))]

        /// A descriptor is text another wallet wrote, so the inputs that
        /// matter are the ones nobody thought to write a test for.
        ///
        /// Misreading one does not fail loudly: it yields a *valid* wallet at
        /// addresses the money is not at, and the symptom is an empty balance.
        /// So the property is not "it parses" but "whatever parses is a
        /// wallet the type's promises still hold for".
        #[test]
        fn arbitrary_text_is_refused_rather_than_misread(raw in ".{0,300}") {
            if let Ok(parsed) = optn_core::multisig::parse_descriptor(&raw) {
                proptest::prop_assert!(parsed.keys.len() >= 2);
                proptest::prop_assert!(parsed.required > 0);
                proptest::prop_assert!(usize::from(parsed.required) <= parsed.keys.len());
                proptest::prop_assert!(!parsed.branches.is_empty());
            }
        }

        /// The same for a whole BSMS record, which arrives as a file.
        #[test]
        fn arbitrary_text_is_not_a_setup_record(raw in ".{0,500}") {
            if let Ok(record) = optn_core::multisig::parse_bsms_record(&raw) {
                proptest::prop_assert_eq!(record.version.as_str(), "1.0");
                proptest::prop_assert!(!record.path_restrictions.is_empty());
                proptest::prop_assert!(!record.first_address.trim().is_empty());
            }
        }

        /// One byte changed in a real descriptor is where a parser actually
        /// breaks. The shape is still right, so it gets much further in
        /// before meeting whatever the mutation broke.
        ///
        /// The failure to rule out is not a crash. It is a mutated descriptor
        /// parsing happily into a *different* wallet, which is the case that
        /// looks like an empty balance instead of an error.
        #[test]
        fn a_single_changed_byte_never_yields_a_different_wallet(
            position in 0usize..512,
            byte in proptest::prelude::any::<u8>(),
        ) {
            let account = AccountPath::new(145, 0).expect("in range");
            let good = optn_core::multisig::descriptor_set(2, &descriptor_cosigners(), account)
                .expect("exports")
                .receive;

            let mut bytes = good.clone().into_bytes();
            let at = position % bytes.len();
            bytes[at] = byte;
            let Ok(mutated) = String::from_utf8(bytes) else {
                return Ok(());
            };
            proptest::prop_assume!(mutated != good);

            if let Ok(parsed) = optn_core::multisig::parse_descriptor(&mutated) {
                let original =
                    optn_core::multisig::parse_descriptor(&good).expect("the real one parses");
                proptest::prop_assert_eq!(
                    parsed.keys,
                    original.keys,
                    "a mutated descriptor parsed into different keys"
                );
                proptest::prop_assert_eq!(parsed.required, original.required);
            }
        }

        /// Truncation is the other thing that happens to a file: a short read,
        /// a half-finished download, a copy that missed the last line.
        ///
        /// A cut inside the fourth line still leaves four lines, so the record
        /// parses -- and then fails verification, because the address no
        /// longer matches the policy. That is the fourth line doing its job.
        /// What must never happen is a truncated record that both parses and
        /// verifies, because that is a short read becoming a wallet.
        #[test]
        fn truncation_never_produces_a_usable_setup(cut in 0usize..400) {
            let account = AccountPath::new(145, 0).expect("in range");
            let body = optn_core::multisig::descriptor_set(2, &descriptor_cosigners(), account)
                .expect("exports")
                .receive;
            let body = body.rsplit_once('#').expect("checksummed").0;
            let multipath = body.replace("/0/*", "/<0;1>/*");
            let full = format!(
                "BSMS 1.0\n{multipath}\n/0/*,/1/*\nbchtest:pr09rncy7wrmcz4qvp36w4y3xcsfk38m559jqz3kz4"
            );

            let at = cut % full.len();
            let truncated = &full[..at];
            proptest::prop_assume!(truncated != full);

            if let Ok(record) = optn_core::multisig::parse_bsms_record(truncated) {
                proptest::prop_assert!(
                    record.verify_first_address(Network::Chipnet).is_err(),
                    "a truncated record verified, so a short read becomes a wallet"
                );
            }
        }
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

    /// Every shell the wallet ships in.
    const ALL_SURFACES: [AppSurface; 5] = [
        AppSurface::Desktop,
        AppSurface::Android,
        AppSurface::Ios,
        AppSurface::Web,
        AppSurface::Extension,
    ];

    #[test]
    fn the_device_picker_is_the_device_and_the_platform_together() {
        use optn_platform::{HardwareTransport as T, HardwareVendor as V};

        // The whole model in one table: what a user is offered is the
        // intersection of what the device can do and what the runtime has.
        // Neither list mentions the other, which is why a new device needs no
        // per-surface rule and a new surface needs no per-device rule.
        let methods = |vendor: V, surface: AppSurface| -> Vec<T> {
            vendor.connection_methods(transport_support(surface))
        };

        // Trezor: a cable and a radio on Android, radio only on iOS, because
        // iOS gives an app no USB path to a wallet.
        assert_eq!(
            methods(V::Trezor, AppSurface::Android),
            vec![T::NativeUsb, T::NativeBle]
        );
        assert_eq!(methods(V::Trezor, AppSurface::Ios), vec![T::NativeBle]);

        // OneKey on an iPhone: three ways in and not a cable among them.
        assert_eq!(
            methods(V::OneKey, AppSurface::Ios),
            vec![T::NativeBle, T::Nfc, T::Camera]
        );
        // ...and no NFC on a desktop, because no laptop has a reader. The
        // device still supports it; the machine does not.
        assert!(!methods(V::OneKey, AppSurface::Desktop).contains(&T::Nfc));
        assert!(methods(V::OneKey, AppSurface::Desktop).contains(&T::NativeUsb));

        // Tangem is a card. NFC or nothing, so it appears on phones and
        // nowhere else -- not on a desktop, and not in an extension, because
        // a browser cannot tap a card.
        for phone in [AppSurface::Android, AppSurface::Ios] {
            assert_eq!(methods(V::Tangem, phone), vec![T::Nfc], "{phone:?}");
        }
        for no_nfc in [AppSurface::Desktop, AppSurface::Web, AppSurface::Extension] {
            assert!(
                methods(V::Tangem, no_nfc).is_empty(),
                "{no_nfc:?} cannot tap a card"
            );
        }

        // Keystone is the opposite: a camera is all it needs, so it reaches
        // every surface including the extension, where every cable and radio
        // path is closed. That is what MetaMask does with a Keystone, and it
        // is the widest reach of any device here.
        for surface in ALL_SURFACES {
            assert!(
                methods(V::Keystone, surface).contains(&T::Camera),
                "{surface:?} must be able to reach a Keystone"
            );
        }
        // Its second channel needs a card slot, which only a desktop has.
        assert!(methods(V::Keystone, AppSurface::Desktop).contains(&T::MicroSd));
        assert!(!methods(V::Keystone, AppSurface::Ios).contains(&T::MicroSd));

        // No surface offers a transport it does not have.
        for surface in ALL_SURFACES {
            let support = transport_support(surface);
            for vendor in V::OFFERED {
                for transport in vendor.connection_methods(support) {
                    assert!(
                        support.provides(transport),
                        "{surface:?} offered {transport:?} for {vendor:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_card_is_a_hardware_wallet_and_reachable_only_by_tap() {
        use optn_platform::{HardwareTransport as T, HardwareVendor as V};

        // Firmware is the line, not shape and not transport. A Tangem has no
        // screen, no battery and no port, and it is still a hardware wallet:
        // it runs its own firmware and the seed is made on the card.
        assert!(V::Tangem.holds_firmware());
        assert!(V::OFFERED.contains(&V::Tangem));

        // One transport, and it is the one no desktop and no browser has.
        assert_eq!(V::Tangem.transports(), &[T::Nfc]);
        assert!(
            !V::USB_DEVICES.contains(&V::Tangem),
            "there is nothing to plug in"
        );

        // Multisig stays behind an advanced control here as everywhere else.
        assert!(!V::Tangem.multisig_is_default());

        // Round-trips over the wire rather than arriving decoded as a Ledger.
        assert_eq!(V::from_id(V::Tangem.id()), Some(V::Tangem));
        assert_eq!(V::Tangem.id(), "tangem");
    }

    #[test]
    fn watch_only_is_offered_on_every_surface_and_switchable_on_each() {
        // Watch Only is the door an air-gapped device comes through, and it
        // needs no transport at all: an account xPub can be pasted. A popup
        // with no camera and no USB can still watch a cold wallet, which is
        // exactly the extension's case -- so it is on everywhere, and the
        // per-surface flag is how a platform turns it off, not how it earns it.
        //
        // Hardware is separate and stays off where the vendor integration does
        // not exist yet. That is an availability fact, not a claim that a phone
        // cannot reach a device.
        let expected = [
            (AppSurface::Desktop, true, true),
            (AppSurface::Android, true, false),
            (AppSurface::Ios, true, false),
            (AppSurface::Web, true, true),
            (AppSurface::Extension, true, true),
        ];
        for (surface, watch_only, hardware) in expected {
            let vm = onboarding_view_model(&AppState::for_surface(surface));
            assert_eq!(vm.show_watch_only, watch_only, "{surface:?}");
            assert_eq!(
                vm.show_hardware_wallet, hardware,
                "{surface:?} hardware follows the integrations, not the shell"
            );
        }

        for surface in ALL_SURFACES {
            let mut state = AppState::for_surface(surface);
            assert!(onboarding_view_model(&state).show_watch_only, "{surface:?}");
            state.apply(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::WatchOnly,
                enabled: false,
            });
            assert!(!onboarding_view_model(&state).show_watch_only);
            assert!(!onboarding_actions(&state).contains(&OnboardingAction::CreateWatchOnlyWallet));
            state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
            assert_ne!(state.route, AppRoute::WatchOnlyWallet, "{surface:?}");

            // And back on again: the flag is a switch, not a one-way gate.
            state.apply(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::WatchOnly,
                enabled: true,
            });
            assert!(onboarding_view_model(&state).show_watch_only, "{surface:?}");
            state.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
            assert_eq!(state.route, AppRoute::WatchOnlyWallet, "{surface:?}");
        }
    }

    #[test]
    fn every_landing_page_puts_watch_only_with_create_and_import() {
        for surface in ALL_SURFACES {
            let actions = onboarding_actions(&AppState::for_surface(surface));
            assert_eq!(actions[0], OnboardingAction::CreateWallet, "{surface:?}");
            assert_eq!(actions[1], OnboardingAction::ImportWallet, "{surface:?}");
            assert_eq!(
                actions[2],
                OnboardingAction::CreateWatchOnlyWallet,
                "{surface:?} must show Watch Only"
            );
            // Hardware is the one that varies, and only where the vendor
            // integration is missing.
            assert_eq!(
                actions.contains(&OnboardingAction::ConnectHardwareWallet),
                surface.offers_hardware_wallet(),
                "{surface:?}"
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
            // Hardware is no longer one of these. CashFusion needs a
            // long-lived background process the other shells do not have,
            // which is a fact about the shell; hardware needs an integration
            // per vendor, which is work. Only the browsers have that work
            // done, so only the phones hide it.
            assert_eq!(
                none.enabled(surface, FeatureFlag::HardwareWallet),
                surface.offers_hardware_wallet(),
                "{surface:?}"
            );
        }
    }

    #[test]
    fn hardware_on_a_phone_is_hidden_rather_than_forbidden() {
        let mut state = AppState::default();
        assert_eq!(
            state.reduce(AppAction::SetSurface(AppSurface::Android)),
            Some(AppEvent::SurfaceChanged(AppSurface::Android))
        );

        // What ships: nothing on screen, because the default is off.
        let vm = onboarding_view_model(&state);
        assert!(!vm.show_hardware_wallet, "off by default on a phone");
        assert!(!vm.show_cash_fusion);
        assert!(vm.show_watch_only);

        // Switching it on is a real toggle, not a no-op. The setter used to
        // clamp the value to the surface default and store `Some(false)` for
        // a request to turn it on, so the section could never be reached.
        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::HardwareWallet,
                enabled: true,
            }),
            Some(AppEvent::FeatureFlagChanged {
                flag: FeatureFlag::HardwareWallet,
                enabled: true,
            })
        );
        assert_eq!(state.features.hardware_wallet, Some(true));
        assert!(
            onboarding_view_model(&state).show_hardware_wallet,
            "the section appears once it is switched on"
        );

        // And it shows the device a phone can genuinely drive rather than an
        // empty list or a lie. Keystone is reached by camera, which needs no
        // native plugin; the cabled devices have no mobile integration yet and
        // stay out on their own account, not because the surface hid them.
        let devices = hardware_view_model(&state).vendors;
        assert!(
            devices.contains(&HardwareVendor::Keystone),
            "a phone has a camera: {devices:?}"
        );
        for absent in [
            HardwareVendor::Ledger,
            HardwareVendor::Trezor,
            HardwareVendor::OneKey,
        ] {
            assert!(
                !devices.contains(&absent),
                "{absent:?} has no mobile integration yet: {devices:?}"
            );
        }

        // CashFusion is a veto and stays one: a phone shell has no long-lived
        // background process, so switching it on could not make it work.
        assert_eq!(
            state.reduce(AppAction::SetFeatureEnabled {
                flag: FeatureFlag::CashFusion,
                enabled: true,
            }),
            None
        );
        assert_eq!(state.features.cash_fusion, None);

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
    fn create_import_and_watch_only_open_home_on_every_surface() {
        for surface in ALL_SURFACES {
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

            // Watching a cold wallet needs no transport, so the route opens
            // on the shells with no camera and no USB too.
            assert!(
                onboarding_actions(&AppState::for_surface(surface))
                    .contains(&OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} must expose Watch Only onboarding"
            );
            let mut route = AppState::for_surface(surface);
            route.apply(AppAction::SetNetwork(Network::Chipnet));
            route.apply(AppAction::Navigate(AppRoute::WatchOnlyWallet));
            assert_eq!(route.route, AppRoute::WatchOnlyWallet, "{surface:?}");
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
            coin: None,
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
            coin: None,
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
            coin: None,
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
            let expected_prefix: &[OnboardingAction] = if matches!(
                surface,
                AppSurface::Desktop | AppSurface::Android | AppSurface::Ios
            ) {
                &[
                    OnboardingAction::CreateWallet,
                    OnboardingAction::ImportWallet,
                    OnboardingAction::CreateWatchOnlyWallet,
                ]
            } else {
                &[
                    OnboardingAction::CreateWallet,
                    OnboardingAction::ImportWallet,
                ]
            };
            assert_eq!(
                &actions[..expected_prefix.len()],
                expected_prefix,
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
            coin: None,
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
    fn the_portfolio_total_adds_stealth_without_counting_it_as_a_utxo() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, "rpa", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });
        state.apply(AppAction::InsertCoin(
            chipnet_demo_coin(100_000, 1).expect("coin"),
        ));

        // Without stealth the total is just the UTXOs, and no split is shown.
        let plain = portfolio_totals(&state);
        assert_eq!(plain.total_sats(), 100_000);
        assert!(!plain.shows_split());

        assert_eq!(
            state.reduce(AppAction::SetStealthSats(50_000)),
            Some(AppEvent::CoinsChanged)
        );
        let totals = portfolio_totals(&state);
        assert_eq!(
            totals.utxo_sats(),
            100_000,
            "stealth must not be counted as a UTXO"
        );
        assert_eq!(totals.total_sats(), 150_000, "but it is part of the total");
        assert_eq!(
            totals.split_label().as_deref(),
            Some("0.00100000 BCH spendable + 0.00050000 BCH stealth")
        );

        // Coin control still only sees UTXOs; stealth is not spendable here.
        assert_eq!(coins_view_model(&state).spendable_sats, 100_000);

        // Setting the same value twice is not an event.
        assert_eq!(state.reduce(AppAction::SetStealthSats(50_000)), None);

        // Stealth belongs to a chain like any other balance.
        state.apply(AppAction::SetNetwork(Network::Mainnet));
        assert_eq!(portfolio_totals(&state).stealth_sats, 0);
    }

    #[test]
    fn switching_network_drops_coins_that_belong_to_the_other_chain() {
        // Coins belong to a chain. Carrying them across a switch would count
        // chipnet coins as a mainnet balance, and let a send plan pick one.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, "switcher", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        let receive = opened.receive_address.clone();
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });

        let coin = chipnet_demo_coin(9_000, 1).expect("coin");
        let dest = coin.address().to_string();
        state.apply(AppAction::InsertCoin(coin));
        state.apply(AppAction::PrepareSend {
            destination: dest,
            amount_sats: 1_000,
            coin: None,
        });
        assert_eq!(coins_view_model(&state).spendable_sats, 9_000);
        assert!(state.spend.is_some());

        state.apply(AppAction::SetNetwork(Network::Mainnet));
        assert_eq!(
            coins_view_model(&state).spendable_sats,
            0,
            "chipnet coins must not be counted as a mainnet balance"
        );
        assert!(state.spend.is_none(), "a stale plan must not survive");
        assert!(state.pledges.is_empty());

        // The wallet is still open and is still the same wallet -- unsynced,
        // not re-identified.
        assert_eq!(
            state.wallet.as_ref().map(|w| w.receive_address.clone()),
            Some(receive)
        );
    }

    #[test]
    fn the_wallet_identity_stays_hidden_until_a_reveal_is_confirmed() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        let preview =
            watch_only_setup_preview(Network::Chipnet, "wallet 8", &xpub, "0f0f0f0f").expect("ok");
        state.apply(AppAction::OpenWatchOnlyWallet(preview));

        let hidden = wallet_identity(
            state.wallet.as_ref(),
            state.network,
            Some(1),
            None,
            false,
            state.identity_revealed,
        )
        .expect("a wallet is open");
        assert_eq!(hidden.name, "wallet 8");
        assert_eq!(hidden.wallet_type, WalletTypeLabel::WatchOnly);
        assert!(!hidden.is_revealed(), "nothing identifying before a reveal");

        // Reveal always prompts, so a request alone shows nothing.
        state.apply(AppAction::RequestReveal { now_ms: 1_000 });
        assert!(!state.identity_revealed);
        state.apply(AppAction::ConfirmAuth { now_ms: 1_000 });
        assert!(state.identity_revealed);

        let shown = wallet_identity(
            state.wallet.as_ref(),
            state.network,
            Some(1),
            None,
            false,
            state.identity_revealed,
        )
        .expect("open")
        .revealed
        .expect("revealed");
        assert_eq!(shown.derivation_path, "m/44'/1'/0'");
        assert_eq!(shown.account_xpub.as_deref(), Some(xpub.as_str()));
        assert_eq!(shown.master_fingerprint.as_deref(), Some("0f0f0f0f"));
        assert_eq!(shown.wallet_hash.map(|h| h.len()), Some(64));

        // Hiding needs no authorisation; a second hide is not an event.
        assert!(state.reduce(AppAction::HideWalletIdentity).is_some());
        assert!(!state.identity_revealed);
        assert_eq!(state.reduce(AppAction::HideWalletIdentity), None);

        // And a reveal never survives a lock.
        state.apply(AppAction::RequestReveal { now_ms: 2_000 });
        state.apply(AppAction::ConfirmAuth { now_ms: 2_000 });
        assert!(state.identity_revealed);
        state.apply(AppAction::LockWallet);
        assert!(
            !state.identity_revealed,
            "a locked wallet must not come back showing its xPub"
        );
    }

    #[test]
    fn coin_control_spends_the_named_coin_through_the_application() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let opened = seed_wallet_preview(Network::Chipnet, "coins", BIP39_TEST_VECTOR_MNEMONIC)
            .expect("preview");
        state.apply(AppAction::OpenCreatedWallet {
            name: opened.name,
            receive_address: opened.receive_address,
            account_path: opened.account_path,
        });

        let small = chipnet_demo_coin(3_000, 1).expect("small");
        let large = chipnet_demo_coin(9_000, 2).expect("large");
        let small_out = small.outpoint();
        let large_out = large.outpoint();
        let dest = large.address().to_string();
        state.apply(AppAction::InsertCoin(small));
        state.apply(AppAction::InsertCoin(large));

        // Naming a coin spends that coin.
        state.apply(AppAction::PrepareSend {
            destination: dest.clone(),
            amount_sats: 2_000,
            coin: Some(large_out),
        });
        assert_eq!(
            state.spend.as_ref().map(|plan| plan.selected),
            Some(large_out)
        );

        // A coin that cannot cover it is refused by name, and the previous
        // plan is not left standing as if it were the new one.
        state.apply(AppAction::PrepareSend {
            destination: dest.clone(),
            amount_sats: 5_000,
            coin: Some(small_out),
        });
        assert!(state
            .notice
            .as_deref()
            .is_some_and(|n| n.contains("does not cover")));

        // Freezing removes it from coin control as well as from automatic
        // selection -- the freeze is the reservation, not a UI filter.
        state.apply(AppAction::FreezeCoin(large_out));
        state.apply(AppAction::PrepareSend {
            destination: dest,
            amount_sats: 2_000,
            coin: Some(large_out),
        });
        assert!(state
            .notice
            .as_deref()
            .is_some_and(|n| n.contains("frozen")));
    }

    #[test]
    fn settings_shows_every_device_field_where_a_device_can_be_reached() {
        // Fields that exist in state but never reach Settings are fields the
        // port dropped. All five are asserted through the view model.
        let mut desktop = AppState::for_surface(AppSurface::Desktop);
        assert!(settings_view_model(&desktop)
            .rows
            .contains(&SettingsRowId::Device));

        desktop.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Ledger,
        )));
        desktop.apply(AppAction::SetLedgerLink(LedgerLink::Bluetooth));
        desktop.apply(AppAction::HardwareConnected {
            label: "Nano X".into(),
            account_xpub: "xpub-under-test".into(),
        });

        let vm = settings_view_model(&desktop);
        assert_eq!(vm.hardware.vendor, Some(HardwareVendor::Ledger));
        assert!(vm.hardware.connected);
        assert_eq!(vm.hardware.device_label.as_deref(), Some("Nano X"));
        assert_eq!(vm.hardware.account_xpub.as_deref(), Some("xpub-under-test"));
        assert_eq!(vm.hardware.ledger_link, LedgerLink::Bluetooth);
        assert!(vm.hardware.offers_link_choice());

        // A row that could never do anything is worse than no row, so it is
        // absent wherever no device can be driven yet.
        for surface in [AppSurface::Android, AppSurface::Ios] {
            assert!(
                !settings_view_model(&AppState::for_surface(surface))
                    .rows
                    .contains(&SettingsRowId::Device),
                "{surface:?} has no device integration yet"
            );
        }
    }

    #[test]
    fn a_server_override_follows_the_selected_network() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        assert!(!settings_view_model(&state).servers_are_custom);

        // Set a mainnet server, then switch network. The chipnet settings
        // must not inherit it: a chipnet Fulcrum answering mainnet queries
        // returns empty results indistinguishable from an empty wallet.
        assert_eq!(
            state.reduce(AppAction::SetServer {
                kind: ServerKind::Electrum,
                entry: "main.example:50002".into(),
            }),
            Some(AppEvent::ServersChanged)
        );
        assert_eq!(
            settings_view_model(&state).electrum_endpoint,
            "main.example:50002"
        );

        state.apply(AppAction::SetNetwork(Network::Chipnet));
        let chipnet = settings_view_model(&state);
        assert!(!chipnet.servers_are_custom, "chipnet inherits nothing");
        assert_eq!(
            chipnet.electrum_endpoint,
            format!(
                "{}:{}",
                Network::Chipnet.default_host(),
                Network::Chipnet.default_port()
            )
        );

        // Back on mainnet the override is still there.
        state.apply(AppAction::SetNetwork(Network::Mainnet));
        assert!(settings_view_model(&state).servers_are_custom);
    }

    #[test]
    fn an_unusable_server_is_refused_with_a_notice_and_changes_nothing() {
        let mut state = AppState::for_surface(AppSurface::Desktop);
        // Remote plaintext Electrum: the server would be told every address
        // in the wallet.
        state.apply(AppAction::SetServer {
            kind: ServerKind::Electrum,
            // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- a JavaScript rule on Rust; this code is what refuses remote ws://
            entry: "ws://fulcrum.example:50003".into(),
        });
        assert!(state
            .notice
            .as_deref()
            .is_some_and(|n| n.contains("every address")));
        assert!(!settings_view_model(&state).servers_are_custom);

        // Use network default is a no-op when nothing is set, rather than a
        // spurious event.
        assert_eq!(state.reduce(AppAction::UseNetworkDefaultServers), None);

        state.apply(AppAction::SetServer {
            kind: ServerKind::Peer,
            entry: "node.example:8333".into(),
        });
        assert!(settings_view_model(&state).servers_are_custom);
        assert_eq!(
            state.reduce(AppAction::UseNetworkDefaultServers),
            Some(AppEvent::ServersChanged)
        );
        assert!(!settings_view_model(&state).servers_are_custom);
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
        // desktop-only switch. Reachability is the device and the platform
        // together.
        let phone = transport_support(AppSurface::Android);
        assert!(HardwareVendor::Keystone.is_reachable_with(phone));
        // A Nano X speaks Bluetooth, and a phone has a radio, so it is
        // reachable there -- which the old model denied.
        assert!(HardwareVendor::Ledger.is_reachable_with(phone));

        let desktop = transport_support(AppSurface::Desktop);
        for vendor in HardwareVendor::OFFERED {
            // Tangem is the exception, and the model produces it rather than
            // being told: a card is reached by tap, and no laptop taps.
            let expected = *vendor != HardwareVendor::Tangem;
            assert_eq!(
                vendor.is_reachable_with(desktop),
                expected,
                "{vendor:?} on desktop"
            );
        }

        // A browser has WebHID but no native USB, and still reaches a Ledger.
        assert!(HardwareVendor::Ledger.is_reachable_with(transport_support(AppSurface::Web)));

        // A popup can do a WebHID dance and can also ask for a camera, so the
        // air-gapped device is reachable there too. This is what MetaMask
        // does with a Keystone, and the extension is where people reach for a
        // hardware wallet, so it would be the worst place to get wrong.
        let popup = transport_support(AppSurface::Extension);
        assert!(HardwareVendor::Ledger.is_reachable_with(popup));
        assert!(HardwareVendor::Keystone.is_reachable_with(popup));
        assert!(HardwareVendor::Keystone.unreachable_reason(popup).is_none());

        // A card still is not, because a browser cannot tap one, and the
        // reason says so instead of failing silently.
        assert!(!HardwareVendor::Tangem.is_reachable_with(popup));
        assert!(HardwareVendor::Tangem.unreachable_reason(popup).is_some());
    }

    #[test]
    fn the_connection_methods_offered_are_the_device_and_the_platform_together() {
        // Neither list alone decides it. A Trezor speaks USB and Bluetooth; a
        // phone has both and an iPhone has only the radio, so the same device
        // offers two methods on Android and one on iOS.
        let android = transport_support(AppSurface::Android);
        let ios = transport_support(AppSurface::Ios);

        let trezor_android = HardwareVendor::Trezor.connection_methods(android);
        assert!(trezor_android.contains(&HardwareTransport::NativeUsb));
        assert!(trezor_android.contains(&HardwareTransport::NativeBle));

        let trezor_ios = HardwareVendor::Trezor.connection_methods(ios);
        assert_eq!(trezor_ios, vec![HardwareTransport::NativeBle]);

        // OneKey is the interesting one: USB, Bluetooth, NFC or QR. On an
        // iPhone that is radio, tap and camera -- three ways in, on the
        // platform with no cable at all.
        let onekey_ios = HardwareVendor::OneKey.connection_methods(ios);
        assert!(onekey_ios.contains(&HardwareTransport::NativeBle));
        assert!(onekey_ios.contains(&HardwareTransport::Nfc));
        assert!(onekey_ios.contains(&HardwareTransport::Camera));
        assert!(!onekey_ios.contains(&HardwareTransport::NativeUsb));

        // No desktop has NFC, so the tap option simply is not offered there.
        let desktop = transport_support(AppSurface::Desktop);
        assert!(!HardwareVendor::OneKey
            .connection_methods(desktop)
            .contains(&HardwareTransport::Nfc));

        // And every method offered has a name to put on a button.
        for vendor in HardwareVendor::OFFERED {
            for method in vendor.connection_methods(desktop) {
                assert!(!method.label().is_empty(), "{vendor:?} {method:?}");
            }
        }
    }

    #[test]
    fn which_section_a_device_appears_in_follows_from_how_it_can_be_reached() {
        // Keystone signs over QR and microSD and nothing else -- its USB-C
        // charges the battery and flashes firmware, and no transaction crosses
        // it. So it is air-gapped, full stop, and belongs under Airgap.
        assert!(HardwareVendor::Keystone.is_air_gapped_only());
        for method in HardwareVendor::Keystone.transports() {
            assert!(method.is_air_gapped(), "{method:?}");
        }
        assert!(HardwareVendor::Keystone
            .transports()
            .contains(&HardwareTransport::MicroSd));

        // OneKey can sign over QR too, but it also speaks USB, Bluetooth and
        // NFC. Air-gap is one of its options rather than what it is, so it
        // belongs with the hardware wallets.
        assert!(!HardwareVendor::OneKey.is_air_gapped_only());
        assert!(HardwareVendor::OneKey
            .transports()
            .contains(&HardwareTransport::Camera));

        for vendor in [HardwareVendor::Ledger, HardwareVendor::Trezor] {
            assert!(!vendor.is_air_gapped_only(), "{vendor:?}");
        }
    }

    #[test]
    fn hardware_is_a_capability_of_the_surfaces_that_can_drive_a_device() {
        // The phones refuse the route and the open, so a renderer bug cannot
        // strand funds behind a device the surface cannot reach.
        let desktop = AppState::for_surface(AppSurface::Desktop);
        let vm = hardware_view_model(&desktop);
        assert!(vm.available);
        // Not every offered device: a Tangem is a card, and no laptop taps.
        assert_eq!(
            vm.vendors,
            vec![
                HardwareVendor::Ledger,
                HardwareVendor::Trezor,
                HardwareVendor::OneKey,
                HardwareVendor::Keystone
            ]
        );
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

        // On a phone the section offers nothing, so a renderer cannot paint
        // a device picker where no device can be driven yet.
        for surface in [AppSurface::Android, AppSurface::Ios] {
            let state = AppState::for_surface(surface);
            let vm = hardware_view_model(&state);
            assert!(!vm.available, "{surface:?}");
            assert!(vm.vendors.is_empty(), "{surface:?} must offer no devices");
        }

        // A browser offers the three it can actually drive, and no Trezor
        // until its transport is rebuilt, and no Tangem because a browser
        // cannot tap a card.
        for surface in [AppSurface::Web, AppSurface::Extension] {
            let vm = hardware_view_model(&AppState::for_surface(surface));
            assert!(vm.available, "{surface:?}");
            assert_eq!(
                vm.vendors,
                vec![
                    HardwareVendor::Ledger,
                    HardwareVendor::OneKey,
                    HardwareVendor::Keystone
                ],
                "{surface:?}"
            );
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
            coin: None,
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

    #[test]
    fn a_viewer_may_build_an_unsigned_psbt_for_an_airgapped_signer() {
        // Watch Only is the air-gap door, and a seed signer should be usable
        // from every platform that offers it. Building an unsigned PSBT spends
        // nothing: the wallet holds no key, and the signing happens on a device
        // that never touches this build. What a viewer must not do is sign.
        let mut viewer = AppState::for_surface(AppSurface::Extension);
        viewer.apply(AppAction::SetNetwork(Network::Chipnet));
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "").expect("mnemonic");
        let xpub = wallet.account_xpub(Network::Chipnet, 0).expect("xpub");
        let preview = watch_only_setup_preview(Network::Chipnet, "cold", &xpub, "4c9a1f7b")
            .expect("watch preview");
        let destination = preview.receive_address.clone();
        viewer.apply(AppAction::OpenWatchOnlyWallet(preview));
        assert_eq!(
            viewer.wallet.as_ref().map(|w| w.spending_capability()),
            Some(SpendingCapability::WatchOnly)
        );

        viewer.apply(AppAction::InsertCoin(
            chipnet_demo_coin(100_000, 4).expect("a coin to spend"),
        ));
        viewer.notice = None;
        viewer.apply(AppAction::PrepareSend {
            destination,
            amount_sats: 10_000,
            coin: None,
        });

        let plan = viewer
            .spend
            .as_ref()
            .unwrap_or_else(|| panic!("a viewer must still build one: {:?}", viewer.notice));
        assert_eq!(
            plan.kind,
            SpendKind::WatchOnlyUnsignedPsbt,
            "unsigned, for a device to sign"
        );

        // And a wallet that *could* sign is still refused on this build, which
        // is the boundary the read-only browser build actually needs.
        let mut seeded = AppState::for_surface(AppSurface::Extension);
        open_chipnet_seed(&mut seeded, "hot");
        let hot_destination = seeded
            .wallet
            .as_ref()
            .map(|w| w.receive_address.clone())
            .expect("a wallet");
        seeded.apply(AppAction::PrepareSend {
            destination: hot_destination,
            amount_sats: 1_000,
            coin: None,
        });
        assert_eq!(
            seeded.notice.as_deref(),
            Some("this build can view a wallet but not spend from it")
        );
        assert!(seeded.spend.is_none());
    }

    #[test]
    fn hardware_is_off_where_the_integration_is_missing_not_where_a_cable_is() {
        // The reason is not "these platforms cannot reach a device". Android
        // supports USB host mode, Ledger and OneKey speak Bluetooth, and
        // Keystone needs only a camera -- which transport_support already says
        // every phone has. What is missing is the per-platform integration, so
        // the switch is off where the work has not been done rather than where
        // it is impossible.
        assert!(AppSurface::Desktop.offers_hardware_wallet());
        // The browsers can drive a Ledger over WebHID, a OneKey through its
        // own web SDK, and a Keystone by camera, so they offer it too.
        assert!(AppSurface::Web.offers_hardware_wallet());
        assert!(AppSurface::Extension.offers_hardware_wallet());
        for surface in [AppSurface::Android, AppSurface::Ios] {
            assert!(!surface.offers_hardware_wallet(), "{surface:?} today");
        }

        // The evidence that it is not a transport question: a phone can already
        // reach an air-gapped device, and the model says so.
        for surface in [AppSurface::Android, AppSurface::Ios] {
            assert!(
                transport_support(surface).provides(HardwareTransport::Camera),
                "{surface:?} has a camera, so Keystone is reachable"
            );
        }
        // And the web surface has three device transports the desktop shell
        // does not, which is the opposite of the story a "desktop needs USB"
        // rule would tell.
        let web = transport_support(AppSurface::Web);
        assert!(web.provides(HardwareTransport::WebHid));
        assert!(web.provides(HardwareTransport::WebUsb));
        assert!(web.provides(HardwareTransport::WebBle));
    }

    #[test]
    fn a_phone_gets_the_conservative_qr_options_and_a_desktop_gets_them_all() {
        // Not a judgement about screens. A phone fleet is thousands of
        // cameras, and the ones that fail belong to people who are not in the
        // room when it is tested -- so the mobile list is the one measured
        // against such a fleet, and it is shorter and lower.
        for surface in [AppSurface::Desktop, AppSurface::Web] {
            assert_eq!(qr_fragment_options(surface), SeedCashQr::FRAGMENT_OPTIONS);
        }
        for surface in [AppSurface::Android, AppSurface::Ios] {
            assert_eq!(qr_fragment_options(surface), MOBILE_FRAGMENT_OPTIONS);
            assert!(
                qr_fragment_options(surface).len() < SeedCashQr::FRAGMENT_OPTIONS.len(),
                "{surface:?} gets fewer choices, not more"
            );
        }

        // Both start at the size a SeedCash camera was observed to read.
        // Starting denser saves a few seconds and costs someone whose device
        // cannot make it -- and they have no way to know the density is why.
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert_eq!(default_qr_fragment(surface), SeedCashQr::CHUNK_SIZE);
            // Every option a control offers has a word for its label, and the
            // words differ by surface even where the numbers do not.
            for fragment in qr_fragment_options(surface) {
                assert!(
                    qr_fragment_label(surface, *fragment).is_some(),
                    "{surface:?} {fragment}"
                );
            }
        }

        // A desktop describes the trade; a phone gets one word for it.
        assert_eq!(
            qr_fragment_label(AppSurface::Desktop, 50),
            Some("Easiest to scan (more frames)")
        );
        assert_eq!(qr_fragment_label(AppSurface::Android, 50), Some("Low"));
    }

    #[test]
    fn watch_only_is_offered_on_every_surface_because_it_is_the_airgap_door() {
        // Watch Only is how an air-gapped device is added -- SeedCash and
        // Keystone both arrive through it -- so it is not a reduced kind of
        // wallet to be rationed by platform. It also needs no transport: an
        // account xPub can be pasted, which is why it reaches a popup that can
        // open neither a USB device nor a camera.
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert!(surface.offers_watch_only(), "{surface:?}");
            assert!(
                FeatureFlags::surface_allows(surface, FeatureFlag::WatchOnly),
                "{surface:?} must be allowed to offer Watch Only"
            );
            let state = AppState::for_surface(surface);
            assert!(
                onboarding_actions(&state).contains(&OnboardingAction::CreateWatchOnlyWallet),
                "{surface:?} must actually offer it on the landing page"
            );
        }

        // The contrast that makes the rule a rule rather than a preference.
        // Watch Only is *allowed* everywhere, unconditionally, because it needs
        // no transport at all. Hardware's phone default is off for a different
        // reason and of a different kind: no native plugin is written for the
        // cabled devices. That is missing work, not a platform limit -- an
        // Android holds a cable, both phones have radios and NFC, and Tangem
        // is phone-only -- which is why it is a default something can override
        // rather than a veto. The two are gated on different things, not on
        // the same "is this a real platform" instinct.
        for surface in [AppSurface::Android, AppSurface::Ios] {
            assert!(
                !FeatureFlags::surface_allows(surface, FeatureFlag::HardwareWallet),
                "{surface:?} defaults hardware off: no device integration yet"
            );
            assert!(
                FeatureFlags {
                    hardware_wallet: Some(true),
                    ..FeatureFlags::default()
                }
                .enabled(surface, FeatureFlag::HardwareWallet),
                "{surface:?} hides hardware rather than forbidding it"
            );
            assert!(
                surface.offers_watch_only(),
                "{surface:?} still watches a cold wallet"
            );
        }
    }

    #[test]
    fn withdrawing_watch_only_from_a_surface_is_one_line() {
        // The switch exists so a platform can be turned off later without a
        // restructure. A user override already hides it per install; this is
        // the build-level half, and today every surface answers true.
        let hidden = FeatureFlags {
            watch_only: Some(false),
            ..FeatureFlags::default()
        };
        assert!(!hidden.enabled(AppSurface::Extension, FeatureFlag::WatchOnly));

        // With no override it is on, everywhere.
        let defaults = FeatureFlags::default();
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
            AppSurface::Extension,
        ] {
            assert!(
                defaults.enabled(surface, FeatureFlag::WatchOnly),
                "{surface:?}"
            );
        }
    }

    #[test]
    fn the_extension_viewer_fails_closed_on_spending_rather_than_hiding_it() {
        // The browser build ships without a key lifecycle designed for a popup,
        // so the release that introduced it made "cannot spend" a boundary the
        // application enforces, not a button the shell leaves out. Hiding
        // Actions from the popup navigation is presentation; a renderer cannot
        // be trusted with a security rule, which is why this is asserted
        // against the application and not against a screen.
        let mut viewer = AppState::for_surface(AppSurface::Extension);
        open_chipnet_seed(&mut viewer, "popup");
        assert!(viewer.surface.is_viewer_only());

        // A destination this wallet itself produced, so the refusal cannot be
        // mistaken for "that address is malformed".
        let destination = viewer
            .wallet
            .as_ref()
            .map(|wallet| wallet.receive_address.clone())
            .expect("a wallet is open");
        viewer.apply(AppAction::PrepareSend {
            destination,
            amount_sats: 1_000,
            coin: None,
        });
        assert_eq!(
            viewer.notice.as_deref(),
            Some("this build can view a wallet but not spend from it"),
            "a viewer must refuse to build a spend"
        );
        assert!(viewer.spend.is_none());
        assert_ne!(viewer.route, AppRoute::Send);

        // And the signing half refuses too, so nothing downstream can proceed
        // on an authorisation it should never have been given.
        viewer.notice = None;
        viewer.apply(AppAction::AuthorizeSpend { now_ms: 1_000 });
        assert_eq!(
            viewer.notice.as_deref(),
            Some("this build can view a wallet but not spend from it"),
            "a viewer must refuse to authorise a spend"
        );
        assert_eq!(
            viewer.lock.prompt, None,
            "and must not prompt for one either"
        );

        // The surfaces that do own a key lifecycle are unaffected.
        for surface in [
            AppSurface::Desktop,
            AppSurface::Android,
            AppSurface::Ios,
            AppSurface::Web,
        ] {
            assert!(surface.can_spend(), "{surface:?} is a full wallet");
        }
    }

    #[test]
    fn a_device_with_no_chosen_account_follows_the_wallet_rather_than_a_literal() {
        // The React slice expressed "not chosen" as UNSET_DERIVATION_PATH,
        // which is the string "m/44'/145'/0'" -- a *mainnet* path. Every reader
        // had to compare against that exact literal, under a comment warning
        // that an equal-looking expression would silently stop matching. A
        // reader that forgot showed 145' to a chipnet wallet.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SetNetwork(Network::Chipnet));
        state.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Keystone,
        )));

        let wallet_account = AccountPath::default_for(Network::Chipnet);
        assert_eq!(state.hardware.derivation_path, None, "nothing chosen yet");
        assert_eq!(
            state.hardware.effective_path(wallet_account),
            wallet_account,
            "an unchosen device derives where the wallet does"
        );
        assert_eq!(
            state.hardware.effective_path(wallet_account).coin_type(),
            1,
            "and that is chipnet's coin type, not the sentinel's 145"
        );
        assert_eq!(state.hardware.path_warning(Network::Chipnet), None);

        // Choosing one is respected exactly.
        let chosen = AccountPath::new(145, 2).expect("in range");
        state.apply(AppAction::SetHardwareDerivationPath(Some(chosen)));
        assert_eq!(state.hardware.derivation_path, Some(chosen));
        assert_eq!(state.hardware.effective_path(wallet_account), chosen);

        // Clearing it goes back to the wallet's, with nothing to compare
        // against and no literal to drift.
        state.apply(AppAction::SetHardwareDerivationPath(None));
        assert_eq!(state.hardware.derivation_path, None);
        assert_eq!(
            state.hardware.effective_path(wallet_account),
            wallet_account
        );
    }

    #[test]
    fn a_chosen_account_this_network_never_scans_is_reported_not_corrected() {
        // Silently swapping it is how a device signs for an account nobody
        // asked for; saying nothing is how a stale mainnet path rides onto
        // chipnet unflagged. So it is surfaced and left alone.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Ledger,
        )));
        let odd = AccountPath::new(9999, 0).expect("in range");
        state.apply(AppAction::SetHardwareDerivationPath(Some(odd)));

        assert_eq!(state.hardware.path_warning(Network::Chipnet), Some(odd));
        assert_eq!(state.hardware.path_warning(Network::Mainnet), Some(odd));
        assert_eq!(
            state.hardware.derivation_path,
            Some(odd),
            "reported, and still exactly what the user chose"
        );

        // A path either network scans raises nothing.
        state.apply(AppAction::SetHardwareDerivationPath(Some(
            AccountPath::default_for(Network::Mainnet),
        )));
        assert_eq!(state.hardware.path_warning(Network::Mainnet), None);
    }

    #[test]
    fn changing_the_account_drops_the_xpub_that_belonged_to_the_old_one() {
        // Otherwise settings shows one account's xPub beside another's path.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        state.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Trezor,
        )));
        state.apply(AppAction::HardwareConnected {
            label: "Trezor Model T".into(),
            account_xpub: "xpub-for-account-0".into(),
        });
        assert!(state.hardware.account_xpub.is_some());

        state.apply(AppAction::SetHardwareDerivationPath(Some(
            AccountPath::new(145, 1).expect("in range"),
        )));
        assert_eq!(state.hardware.account_xpub, None);
        // The device is still chosen and still attached; only its export is
        // stale.
        assert_eq!(state.hardware.vendor, Some(HardwareVendor::Trezor));
        assert!(state.hardware.connected);

        // And unplugging does not undo the setting: re-plugging must not
        // silently derive somewhere else.
        state.apply(AppAction::DisconnectHardware);
        assert_eq!(
            state.hardware.derivation_path,
            Some(AccountPath::new(145, 1).expect("in range"))
        );
        assert!(!state.hardware.connected);
    }

    #[test]
    fn locking_or_switching_chains_cancels_a_paired_sessions_request() {
        // A request belongs to the session that raised it, and that session to
        // one wallet on one chain. Carried across either boundary it would be
        // answered by a wallet that never saw it, against coins it was not
        // built from.
        let pending = ConnectRequest {
            protocol: ConnectProtocol::CashConnect,
            kind: RequestKind::SignTransaction,
            origin: "example.dapp".into(),
            id: "req-1".into(),
        };

        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "paired");
        assert!(state.connect.raise(pending.clone()));
        state.apply(AppAction::LockWallet);
        assert!(
            state.connect.request.is_none(),
            "a lock must not leave a signature request up"
        );

        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "paired");
        assert!(state.connect.raise(pending));
        state.apply(AppAction::SetNetwork(Network::Mainnet));
        assert!(
            state.connect.request.is_none(),
            "a chain switch must not leave one up either"
        );
    }

    #[test]
    fn a_locked_wallet_reports_no_balance_of_any_kind() {
        // "No wallet is open unless its key is cached" is the invariant the
        // per-wallet security model rests on, and a balance is what makes a
        // closed wallet look open. Clearing the coins is not enough: the RPA
        // pool is the half of the total that is deliberately not a UTXO, so it
        // has to be cleared by name or a locked wallet still shows a total.
        let mut state = AppState::for_surface(AppSurface::Desktop);
        open_chipnet_seed(&mut state, "locked-balance");
        state.apply(AppAction::SetStealthSats(50_000));
        state.apply(AppAction::SelectHardwareVendor(Some(
            HardwareVendor::Trezor,
        )));
        state.hardware.account_xpub = Some("xpub-from-the-device".into());
        assert!(portfolio_totals(&state).total_sats() > 0);

        state.apply(AppAction::LockWallet);

        let totals = portfolio_totals(&state);
        assert_eq!(totals.stealth_sats, 0, "the stealth pool is wallet balance");
        assert_eq!(totals.total_sats(), 0);
        assert!(!state.identity_revealed);
        assert_eq!(
            state.hardware.account_xpub, None,
            "one wallet's exported account must not follow the user into the next one"
        );
        // The device itself stays chosen: it is still plugged in.
        assert_eq!(state.hardware.vendor, Some(HardwareVendor::Trezor));
    }
}

#[cfg(test)]
mod fee_policy_integration_regression {
    use super::*;
    #[test]
    fn app_fee_policy_is_resolved_before_spend_planning_and_clamped() {
        let mut state = AppState::default();
        assert_eq!(state.fee_preferences, FeePreferences::app_default());
        state.reduce(AppAction::SetFeeMode(FeeMode::Custom));
        state.reduce(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(
            500,
        )));
        assert_eq!(
            state
                .fee_preferences
                .resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE),
            RELAY_MINIMUM_FEE_RATE
        );
        state.reduce(AppAction::SetCustomFeeRate(FeeRate::from_satoshis_per_kb(
            1700,
        )));
        assert_eq!(state.fee_preferences.custom_rate.satoshis_per_kb(), 1700);
    }
}
