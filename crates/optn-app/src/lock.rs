//! App lock, spend re-auth, and ciphertext session policy.
//!
//! Port of `KeyService.KeyPurpose` and desktop `DeviceIntegrityService`:
//! - Wallet files hold **ciphertext**. The session never stores a mnemonic.
//! - Auto-lock default is **Never** (0). Offered timers are 15 / 30 / 60 / 120
//!   / 240 minutes. Values 1 and 5 (removed UI options) map back to Never.
//! - **Never:** inactivity does not wipe the session. `Spend` re-prompts, then
//!   caches that grant for 10 minutes (timer resets on each successful auth).
//!   Opening the wallet counts as the first grant, so the first Send after
//!   unlock does not re-prompt.
//! - Timer modes: inactivity closes the wallet. Spend does not re-prompt —
//!   the auto-lock already covers walking away.
//! - `Reveal` (recovery / private key / xpub) always re-prompts.
//! - `Background` never prompts: CashFusion, auto-fusion, and other unattended
//!   work the user already consented to. A prompt mid-round would kill it.
//! - `Chat` never prompts: `signMessageForAddress` is not a spend.
//! - Locking, or opening another wallet, voids the spend cache immediately.

use crate::WalletKind;

/// After a successful spend auth, later spends skip the prompt for this long.
pub const SPEND_AUTH_TTL_MS: u64 = 600_000;

/// Offered auto-lock durations. Never is 0. Sub-15-minute choices are gone
/// because a CashFusion round takes minutes and dies with the key on lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AutoLockMinutes {
    #[default]
    Never,
    Fifteen,
    Thirty,
    Sixty,
    TwoHours,
    FourHours,
}

impl AutoLockMinutes {
    pub const fn as_minutes(self) -> u32 {
        match self {
            Self::Never => 0,
            Self::Fifteen => 15,
            Self::Thirty => 30,
            Self::Sixty => 60,
            Self::TwoHours => 120,
            Self::FourHours => 240,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Never => "Never",
            Self::Fifteen => "15 minutes",
            Self::Thirty => "30 minutes",
            Self::Sixty => "1 hour",
            Self::TwoHours => "2 hours",
            Self::FourHours => "4 hours",
        }
    }

    /// Persist / restore. Unknown values and the retired 1 / 5 minute options
    /// become Never, matching the desktop Redux sanitizer.
    pub const fn from_minutes(minutes: u32) -> Self {
        match minutes {
            15 => Self::Fifteen,
            30 => Self::Thirty,
            60 => Self::Sixty,
            120 => Self::TwoHours,
            240 => Self::FourHours,
            _ => Self::Never,
        }
    }

    pub const fn offered() -> [Self; 6] {
        [
            Self::Never,
            Self::Fifteen,
            Self::Thirty,
            Self::Sixty,
            Self::TwoHours,
            Self::FourHours,
        ]
    }

    pub const fn is_never(self) -> bool {
        matches!(self, Self::Never)
    }
}

/// Why a caller wants a private key. Same three purposes as `KeyPurpose` in
/// `src/services/KeyService.ts`, plus chat/message-sign which that service
/// already excludes from spend re-auth (`signMessageForAddress`).
///
/// The password itself never enters application state — the shell verifies,
/// then dispatches [`crate::AppAction::ConfirmAuth`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScope {
    /// Producing a signature that moves funds. Prompt only when auto-lock is
    /// Never and the 10 minute cache has expired.
    Spend,
    /// Handing the secret itself to the user. Always prompt.
    Reveal,
    /// CashFusion / auto-fusion. The user consented when they enabled it;
    /// a prompt mid-round would kill the round. Never prompt.
    Background,
    /// Chat / `signMessageForAddress`. Not a spend. Never prompt.
    Chat,
}

impl AuthScope {
    pub const fn title(self) -> &'static str {
        match self {
            Self::Spend => "Confirm send",
            Self::Reveal => "Confirm identity",
            Self::Background => "Fusion",
            Self::Chat => "Chat",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Self::Spend => "Enter the wallet password to sign this send.",
            Self::Reveal => "Enter the wallet password to reveal this secret.",
            Self::Background => "CashFusion does not re-prompt. You already consented.",
            Self::Chat => "Chat does not re-prompt. It is not a spend.",
        }
    }

    pub const fn never_prompts(self) -> bool {
        matches!(self, Self::Background | Self::Chat)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthDecision {
    Allow,
    Prompt,
}

/// Session lock + spend-auth cache. Copyable snapshot; no secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppLockState {
    pub auto_lock: AutoLockMinutes,
    pub unlock_epoch: u64,
    pub last_spend_auth_ms: u64,
    pub last_spend_auth_epoch: u64,
    pub last_activity_ms: u64,
    pub prompt: Option<AuthScope>,
}

impl Default for AppLockState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppLockState {
    pub const fn new() -> Self {
        Self {
            auto_lock: AutoLockMinutes::Never,
            unlock_epoch: 0,
            last_spend_auth_ms: 0,
            last_spend_auth_epoch: 0,
            last_activity_ms: 0,
            prompt: None,
        }
    }

    /// Seed wallets store ciphertext at rest. Watch-only has no seed. Hardware
    /// keeps the private key on the device.
    pub const fn secrets_are_ciphertext(kind: Option<WalletKind>) -> bool {
        matches!(kind, Some(WalletKind::Seed))
    }

    pub fn mark_unlocked(&mut self) {
        self.unlock_epoch = self.unlock_epoch.saturating_add(1);
        self.last_spend_auth_epoch = self.unlock_epoch;
        // Stamp on the first `observe` so the 10 minute window starts at the
        // first real clock the shell reports after open, not at unix epoch 0.
        self.last_spend_auth_ms = 0;
        self.last_activity_ms = 0;
        self.prompt = None;
    }

    pub fn lock(&mut self) {
        self.unlock_epoch = self.unlock_epoch.saturating_add(1);
        self.last_spend_auth_ms = 0;
        self.last_spend_auth_epoch = 0;
        self.last_activity_ms = 0;
        self.prompt = None;
    }

    /// Bind lazy unlock timestamps to `now_ms`. Safe to call on every tick.
    pub fn observe(&mut self, now_ms: u64) {
        if self.last_spend_auth_epoch == self.unlock_epoch && self.last_spend_auth_ms == 0 {
            self.last_spend_auth_ms = now_ms;
        }
        if self.last_activity_ms == 0 {
            self.last_activity_ms = now_ms;
        }
    }

    pub fn record_activity(&mut self, now_ms: u64) {
        self.observe(now_ms);
        self.last_activity_ms = now_ms;
    }

    pub fn spend_auth_still_valid(&self, now_ms: u64) -> bool {
        if self.last_spend_auth_epoch != self.unlock_epoch {
            return false;
        }
        let start = if self.last_spend_auth_ms == 0 {
            now_ms
        } else {
            self.last_spend_auth_ms
        };
        now_ms.saturating_sub(start) < SPEND_AUTH_TTL_MS
    }

    pub fn mark_spend_auth(&mut self, now_ms: u64) {
        self.last_spend_auth_ms = now_ms;
        self.last_spend_auth_epoch = self.unlock_epoch;
        self.prompt = None;
    }

    pub fn idle_should_lock(&self, now_ms: u64) -> bool {
        let minutes = self.auto_lock.as_minutes();
        if minutes == 0 || self.last_activity_ms == 0 {
            return false;
        }
        now_ms.saturating_sub(self.last_activity_ms) >= u64::from(minutes) * 60_000
    }

    pub fn decide(
        &self,
        scope: AuthScope,
        now_ms: u64,
        wallet_kind: Option<WalletKind>,
    ) -> AuthDecision {
        match scope {
            AuthScope::Reveal => AuthDecision::Prompt,
            AuthScope::Background | AuthScope::Chat => AuthDecision::Allow,
            AuthScope::Spend => {
                if wallet_kind != Some(WalletKind::Seed) {
                    return AuthDecision::Allow;
                }
                if !self.auto_lock.is_never() {
                    return AuthDecision::Allow;
                }
                if self.spend_auth_still_valid(now_ms) {
                    return AuthDecision::Allow;
                }
                AuthDecision::Prompt
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppLockViewModel {
    pub auto_lock: AutoLockMinutes,
    pub options: [AutoLockMinutes; 6],
    pub secrets_are_ciphertext: bool,
    pub spend_reauth: bool,
    pub prompt: Option<AuthScope>,
    pub cache_minutes: u32,
}

pub fn app_lock_view_model(
    lock: &AppLockState,
    wallet_kind: Option<WalletKind>,
) -> AppLockViewModel {
    AppLockViewModel {
        auto_lock: lock.auto_lock,
        options: AutoLockMinutes::offered(),
        secrets_are_ciphertext: AppLockState::secrets_are_ciphertext(wallet_kind),
        spend_reauth: lock.auto_lock.is_never() && wallet_kind == Some(WalletKind::Seed),
        prompt: lock.prompt,
        cache_minutes: (SPEND_AUTH_TTL_MS / 60_000) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_is_default_and_retired_short_timers_become_never() {
        assert_eq!(AutoLockMinutes::default(), AutoLockMinutes::Never);
        assert_eq!(AutoLockMinutes::from_minutes(0), AutoLockMinutes::Never);
        assert_eq!(AutoLockMinutes::from_minutes(1), AutoLockMinutes::Never);
        assert_eq!(AutoLockMinutes::from_minutes(5), AutoLockMinutes::Never);
        assert_eq!(AutoLockMinutes::from_minutes(15), AutoLockMinutes::Fifteen);
        assert_eq!(AutoLockMinutes::from_minutes(99), AutoLockMinutes::Never);
        assert_eq!(SPEND_AUTH_TTL_MS, 600_000);
    }

    #[test]
    fn never_prompts_on_send_only_after_the_ten_minute_cache() {
        let mut lock = AppLockState::new();
        lock.mark_unlocked();
        assert_eq!(lock.auto_lock, AutoLockMinutes::Never);
        lock.observe(1_000);
        assert_eq!(
            lock.decide(AuthScope::Spend, 1_000, Some(WalletKind::Seed)),
            AuthDecision::Allow,
            "first send after unlock must not re-prompt"
        );
        assert_eq!(
            lock.decide(
                AuthScope::Spend,
                1_000 + SPEND_AUTH_TTL_MS - 1,
                Some(WalletKind::Seed)
            ),
            AuthDecision::Allow
        );
        assert_eq!(
            lock.decide(
                AuthScope::Spend,
                1_000 + SPEND_AUTH_TTL_MS,
                Some(WalletKind::Seed)
            ),
            AuthDecision::Prompt,
            "exactly 10 minutes later the next send re-prompts"
        );
    }

    #[test]
    fn timer_modes_skip_spend_prompt_and_idle_closes_the_session() {
        let mut lock = AppLockState::new();
        lock.auto_lock = AutoLockMinutes::Fifteen;
        lock.mark_unlocked();
        lock.record_activity(1_000);
        assert_eq!(
            lock.decide(AuthScope::Spend, 1_000, Some(WalletKind::Seed)),
            AuthDecision::Allow
        );
        assert!(!lock.idle_should_lock(1_000 + 14 * 60_000));
        assert!(lock.idle_should_lock(1_000 + 15 * 60_000));
        lock.auto_lock = AutoLockMinutes::Never;
        assert!(!lock.idle_should_lock(1_000 + 240 * 60_000));
    }

    #[test]
    fn reveal_always_prompts_watch_only_and_hardware_do_not() {
        let lock = AppLockState::new();
        assert_eq!(
            lock.decide(AuthScope::Reveal, 0, Some(WalletKind::Seed)),
            AuthDecision::Prompt
        );
        assert_eq!(
            lock.decide(AuthScope::Spend, 0, Some(WalletKind::WatchOnly)),
            AuthDecision::Allow
        );
        assert_eq!(
            lock.decide(AuthScope::Spend, 0, Some(WalletKind::Hardware)),
            AuthDecision::Allow
        );
    }

    #[test]
    fn lock_or_new_wallet_voids_the_spend_cache() {
        let mut lock = AppLockState::new();
        lock.mark_unlocked();
        lock.mark_spend_auth(5_000);
        assert!(lock.spend_auth_still_valid(5_000));
        lock.lock();
        assert!(!lock.spend_auth_still_valid(5_001));
        lock.mark_unlocked();
        lock.observe(20_000);
        assert!(lock.spend_auth_still_valid(20_000));
        assert!(!lock.spend_auth_still_valid(20_000 + SPEND_AUTH_TTL_MS));
    }

    #[test]
    fn fusion_auto_and_chat_never_prompt_even_on_never_mode() {
        let mut lock = AppLockState::new();
        lock.mark_unlocked();
        lock.observe(1_000);
        let expired = 1_000 + SPEND_AUTH_TTL_MS;
        assert_eq!(
            lock.decide(AuthScope::Spend, expired, Some(WalletKind::Seed)),
            AuthDecision::Prompt
        );
        assert_eq!(
            lock.decide(AuthScope::Background, expired, Some(WalletKind::Seed)),
            AuthDecision::Allow,
            "CashFusion / auto-fusion must not re-prompt"
        );
        assert_eq!(
            lock.decide(AuthScope::Chat, expired, Some(WalletKind::Seed)),
            AuthDecision::Allow,
            "chat / message sign must not re-prompt"
        );
    }

    #[test]
    fn seed_wallets_are_ciphertext_at_rest() {
        assert!(AppLockState::secrets_are_ciphertext(Some(WalletKind::Seed)));
        assert!(!AppLockState::secrets_are_ciphertext(Some(
            WalletKind::WatchOnly
        )));
        assert!(!AppLockState::secrets_are_ciphertext(Some(
            WalletKind::Hardware
        )));
        assert!(!AppLockState::secrets_are_ciphertext(None));
    }
}
