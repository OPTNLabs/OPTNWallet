//! Auto Fusion policy and session state.
//!
//! CashFusion is not a button. It is a long-lived service that decides, over
//! and over, whether to spend a fee on another round: is the feature on, is
//! Auto on, is a wallet open, is Tor up for the P2P transport, has the cooldown
//! elapsed, is a round already running. This module owns the part of that
//! decision that is pure, and the state a screen renders.
//!
//! Two boundaries matter and both came from the TypeScript engine this
//! replaces.
//!
//! **Policy holds no authority.** Whether a round is already running, whether
//! the fee cooldown has elapsed and whether any coin is still eligible are all
//! questions only the driver can answer — it holds the cross-window lease, the
//! atomic check-and-claim and live reconciliation. Duplicating them here would
//! be worse than useless for a fee decision: this layer cannot see other
//! windows, so its answer would pass while the authoritative one refused, and
//! the two would drift. Ask once, where it can actually be answered.
//!
//! **A preference is not permission to spend.** `auto_fuse_enabled` persists;
//! the arming does not. A wallet must receive an explicit start in the current
//! session before the driver may schedule a paid round, so restoring a wallet
//! or reopening the app never arms a fee-spending loop on its own. This is the
//! one place the word "start" appears, and it is a safety gate rather than a
//! manual-mode switch: once armed, the driver runs by itself.

/// The two transports for one feature. Mutually exclusive: only the selected
/// one may start a round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FusionMode {
    /// Peer-to-peer, coordinated over Nostr. Requires Tor.
    P2p,
    /// A CashFusion server, coordinated by the server's pools.
    Server,
}

impl FusionMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::P2p => "P2P",
            Self::Server => "Server",
        }
    }
}

/// The durable Auto Fusion preference.
///
/// Settings, not permission. See the module docs on arming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AutoFusionPolicy {
    /// Master switch. Nothing runs when this is off.
    pub cash_fusion_enabled: bool,
    /// Whether the driver may schedule rounds once armed.
    pub auto_fuse_enabled: bool,
    /// Selects the transport. The two are mutually exclusive.
    pub p2p_fusion_enabled: bool,
}

impl AutoFusionPolicy {
    /// The transport this policy selects.
    pub const fn mode(self) -> FusionMode {
        if self.p2p_fusion_enabled {
            FusionMode::P2p
        } else {
            FusionMode::Server
        }
    }
}

/// The part of the policy a holder actually stores.
///
/// The master switch is absent on purpose. "Is CashFusion available and on at
/// all" is already `FeatureFlag::CashFusion`, which also carries the
/// desktop-only surface rule; storing it a second time here would let the two
/// disagree, and the settings screen and the driver would then answer the same
/// question differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoFusionSettings {
    /// Whether the driver may schedule rounds once armed.
    pub auto_fuse_enabled: bool,
    /// Selects the transport. The two are mutually exclusive.
    pub p2p_fusion_enabled: bool,
}

impl AutoFusionSettings {
    /// Both off: Auto does not schedule paid rounds until a holder turns it
    /// on, and the transport defaults to Server.
    pub const fn new() -> Self {
        Self {
            auto_fuse_enabled: false,
            p2p_fusion_enabled: false,
        }
    }

    /// Combine with the master switch to get the policy the driver decides on.
    pub const fn with_master_switch(self, cash_fusion_enabled: bool) -> AutoFusionPolicy {
        AutoFusionPolicy {
            cash_fusion_enabled,
            auto_fuse_enabled: self.auto_fuse_enabled,
            p2p_fusion_enabled: self.p2p_fusion_enabled,
        }
    }
}

/// Everything the decision needs that is not a preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoFusionInputs {
    pub policy: AutoFusionPolicy,
    /// Armed by an explicit start in this session. Never persisted.
    pub session_armed: bool,
    /// A wallet is open and usable.
    pub wallet_open: bool,
    /// P2P cannot run without Tor. Server fusion enforces its own policy.
    pub tor_ready: bool,
}

/// Why the driver is not starting a round, or which transport it will use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoFusionDecision {
    /// Not now, and the reason is worth showing a holder.
    Hold {
        reason: &'static str,
    },
    Run {
        mode: FusionMode,
    },
}

impl AutoFusionDecision {
    pub const fn is_run(&self) -> bool {
        matches!(self, Self::Run { .. })
    }
}

/// May Auto Fusion start a round right now?
///
/// Pure: no timers, storage or network. The decision to spend a fee is exactly
/// the part that has to be exhaustively testable, and the driver around it is
/// only a clock.
pub fn decide_auto_fusion(input: AutoFusionInputs) -> AutoFusionDecision {
    if !input.policy.cash_fusion_enabled {
        return AutoFusionDecision::Hold {
            reason: "CashFusion is off",
        };
    }
    if !input.policy.auto_fuse_enabled {
        return AutoFusionDecision::Hold {
            reason: "Auto fusion is off",
        };
    }
    if !input.session_armed {
        return AutoFusionDecision::Hold {
            reason: "Fusion must be started once in this session first",
        };
    }
    if !input.wallet_open {
        return AutoFusionDecision::Hold {
            reason: "No wallet open",
        };
    }
    if input.policy.p2p_fusion_enabled && !input.tor_ready {
        return AutoFusionDecision::Hold {
            reason: "Tor is not ready for P2P fusion",
        };
    }
    AutoFusionDecision::Run {
        mode: input.policy.mode(),
    }
}

// ---------------------------------------------------------------------------
// Timing
//
// Every constant below is carried over unchanged from the engine this replaces,
// which took them from Electron Cash. They are load-bearing: shortening the
// cooldown spends fees faster, and lengthening the rendezvous window stops
// independent clients meeting.
// ---------------------------------------------------------------------------

/// After a paid success. Short, so Auto keeps cycling the way Electron Cash
/// does — its plugin re-queues as soon as a fusion thread exits.
///
/// Not a confirmation wait. Unconfirmed fusion outputs are eligible
/// immediately; this only covers the wallet seeing the new outpoints before the
/// next round. Never multi-minute, never "wait for one confirmation".
pub const AUTO_FUSION_COOLDOWN_MS: u64 = 20_000;

/// After a failed, cancelled or empty-pool attempt, where no fee was spent.
pub const AUTO_FUSION_RETRY_MS: u64 = 10_000;

/// Every coin is already at its rounds-per-coin depth, or the wallet holds no
/// BCH. Idle hard rather than thrash: wake on wallet activity that leaves a
/// coin below depth, not on the clock.
pub const AUTO_FUSION_DEPTH_MET_IDLE_MS: u64 = 30 * 60_000;

/// A shared UTC rendezvous for P2P, like the server's JOIN epochs. Auto only
/// *enters* gather during the open part of a slot, so independent clients meet
/// without coordinating.
pub const AUTO_RENDEZVOUS_PERIOD_MS: u64 = 90_000;
/// The opening portion of each slot, during which new gathers may start.
pub const AUTO_RENDEZVOUS_OPEN_MS: u64 = 35_000;

/// Electron Cash checks Auto workers on roughly a five second loop.
pub const SERVER_AUTO_POLL_MS: u64 = 5_000;

/// Milliseconds until the next open rendezvous, or zero if one is open.
pub const fn ms_until_auto_rendezvous_open(now_ms: u64) -> u64 {
    let into = now_ms % AUTO_RENDEZVOUS_PERIOD_MS;
    if into < AUTO_RENDEZVOUS_OPEN_MS {
        0
    } else {
        AUTO_RENDEZVOUS_PERIOD_MS - into
    }
}

pub const fn is_auto_rendezvous_open(now_ms: u64) -> bool {
    now_ms % AUTO_RENDEZVOUS_PERIOD_MS < AUTO_RENDEZVOUS_OPEN_MS
}

/// Server Auto has no client-side rendezvous gate: Electron Cash joins pools as
/// soon as a worker is free and lets the server coordinate participants.
pub const fn ms_until_server_auto_start() -> u64 {
    0
}

/// Would this failure be retried quickly rather than slept on?
///
/// These are the "nobody else was there" and "could not reach it" cases, where
/// no fee was spent and the next attempt may well succeed. Anything unmatched
/// falls back to the ordinary retry, so a new message is never silently treated
/// as harmless.
pub fn is_auto_transient_failure(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    const LITERALS: &[&str] = &[
        "no other wallets",
        "no other players",
        "no peers",
        "could not agree",
        "could not connect",
        "connection refused",
        "actively refused",
        "connection was aborted",
        "os error 10061",
        "os error 10053",
        "never reported pool",
        "no fusion server",
        "not ready for",
        "route is unavailable",
        "tor is disabled",
        "tor is not ready",
        "fusion server address",
        "too few remaining",
        "receive failed",
        "fresh peers",
        "at least three",
        "at least four",
    ];
    if LITERALS.iter().any(|needle| text.contains(needle)) {
        return true;
    }
    // "timed out waiting" / "timeout waiting", which the original matched with
    // an optional space.
    if (text.contains("timed out waiting") || text.contains("timeout waiting"))
        || (text.contains("only ") && text.contains(" wallet"))
        || text.contains("need ")
    {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/// Why the driver is waiting rather than running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FusionWaitReason {
    /// A paid round just finished.
    Cooldown,
    /// The last attempt failed without spending a fee.
    Retry,
    /// Waiting for the shared rendezvous slot to open (P2P).
    Rendezvous,
    /// Every coin is at depth; nothing to do until the wallet changes.
    DepthReached,
}

impl FusionWaitReason {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Cooldown => "Cooling down",
            Self::Retry => "Retrying shortly",
            Self::Rendezvous => "Waiting for the next round window",
            Self::DepthReached => "All coins are fully fused",
        }
    }
}

/// Where a round has got to.
///
/// Deliberately coarse. A holder wants to know whether their money is moving
/// and whether anything is wrong, not which protobuf frame is in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FusionStep {
    /// Connecting and announcing interest in a pool.
    Joining,
    /// In a pool, waiting for enough participants.
    Gathering,
    /// Blinded components exchanged, transaction being assembled.
    Assembling,
    /// Signing the shared transaction.
    Signing,
    /// A participant misbehaved; working out who.
    Blaming,
}

impl FusionStep {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Joining => "Joining",
            Self::Gathering => "Waiting for participants",
            Self::Assembling => "Building the transaction",
            Self::Signing => "Signing",
            Self::Blaming => "Resolving a failed round",
        }
    }
}

/// What the fusion service is doing, as far as a screen is concerned.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum FusionPhase {
    /// Not running, and not scheduled.
    #[default]
    Idle,
    /// Scheduled, waiting on the clock.
    Waiting {
        reason: FusionWaitReason,
        /// Wall-clock milliseconds at which the wait ends. A screen renders a
        /// countdown from this rather than being ticked by the driver.
        until_ms: u64,
    },
    /// A round is in progress.
    Running {
        mode: FusionMode,
        step: FusionStep,
        /// Known participants, when the transport reports it.
        participants: Option<u32>,
    },
    /// Stopping at the holder's request. Kept distinct from Idle because a
    /// round that is being torn down still holds coin reservations.
    Cancelling,
    /// The last round produced a transaction.
    Completed {
        txid: String,
        fused_sats: u64,
        /// Wall-clock milliseconds.
        at_ms: u64,
    },
    /// The last round did not. `transient` drives the retry cadence, and is
    /// also why the message is kept rather than flattened to a boolean.
    Failed { message: String, transient: bool },
}

/// The fusion service's state, owned by the runtime and rendered by any
/// surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusionSession {
    pub phase: FusionPhase,
    /// Armed by an explicit start in this session. Never persisted, so a
    /// restart cannot resume spending fees on its own.
    pub session_armed: bool,
    /// Rounds completed for this wallet in this session.
    pub rounds_completed: u32,
    /// Total satoshis fused in this session.
    pub fused_sats: u64,
    /// Why the driver last declined to start, when it declined.
    pub hold_reason: Option<String>,
}

impl FusionSession {
    /// Idle and unarmed. `AppState::new` is const, and a fresh session must be
    /// exactly "nothing running, nothing permitted".
    pub const fn new() -> Self {
        Self {
            phase: FusionPhase::Idle,
            session_armed: false,
            rounds_completed: 0,
            fused_sats: 0,
            hold_reason: None,
        }
    }

    /// Whether a round is occupying the wallet right now.
    ///
    /// Cancelling counts: coins are still reserved until the teardown lands.
    pub const fn is_busy(&self) -> bool {
        matches!(
            self.phase,
            FusionPhase::Running { .. } | FusionPhase::Cancelling
        )
    }

    /// Whether the driver intends to run again without further input.
    pub const fn is_scheduled(&self) -> bool {
        matches!(self.phase, FusionPhase::Waiting { .. }) || self.is_busy()
    }

    /// Revoke future rounds without pretending an active round has released coins.
    pub fn disarm(&mut self) {
        self.session_armed = false;
        self.phase = if self.is_busy() {
            FusionPhase::Cancelling
        } else {
            FusionPhase::Idle
        };
        self.hold_reason = None;
    }
}

/// What a screen shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusionViewModel {
    pub policy: AutoFusionPolicy,
    pub session: FusionSession,
    /// One line describing the current state, already resolved.
    pub status: String,
    /// Set when the holder can do something about it.
    pub hint: Option<String>,
    /// Whether an explicit start would do anything right now.
    pub can_start: bool,
    /// Whether a cancel would do anything right now.
    pub can_cancel: bool,
}

/// Render the fusion state for a surface.
pub fn fusion_view_model(
    policy: AutoFusionPolicy,
    session: &FusionSession,
    wallet_open: bool,
    tor_ready: bool,
) -> FusionViewModel {
    let decision = decide_auto_fusion(AutoFusionInputs {
        policy,
        session_armed: session.session_armed,
        wallet_open,
        tor_ready,
    });

    let status = match &session.phase {
        FusionPhase::Idle => match &decision {
            // The hold reason is the useful sentence here: "off" and "waiting
            // to be started once" look identical otherwise.
            AutoFusionDecision::Hold { reason } => (*reason).to_owned(),
            AutoFusionDecision::Run { .. } => "Ready".to_owned(),
        },
        FusionPhase::Waiting { reason, .. } => reason.label().to_owned(),
        FusionPhase::Running {
            mode,
            step,
            participants,
        } => match participants {
            Some(count) => format!("{} · {} ({count} participants)", mode.label(), step.label()),
            None => format!("{} · {}", mode.label(), step.label()),
        },
        FusionPhase::Cancelling => "Stopping".to_owned(),
        FusionPhase::Completed { fused_sats, .. } => {
            format!("Fused {fused_sats} sats")
        }
        FusionPhase::Failed { message, .. } => message.clone(),
    };

    let hint = match (&session.phase, &decision) {
        (FusionPhase::Idle, AutoFusionDecision::Hold { reason }) => Some((*reason).to_owned()),
        _ => session.hold_reason.clone(),
    };

    FusionViewModel {
        policy,
        session: session.clone(),
        status,
        hint,
        // Starting is only meaningful when the feature is on, a wallet is open
        // and nothing is already running. Arming is what an explicit start
        // does; after that the driver continues by itself.
        can_start: policy.cash_fusion_enabled && wallet_open && !session.is_busy(),
        can_cancel: session.session_armed || session.is_scheduled(),
    }
}

impl Default for AutoFusionSettings {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for FusionSession {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(cash: bool, auto: bool, p2p: bool) -> AutoFusionPolicy {
        AutoFusionPolicy {
            cash_fusion_enabled: cash,
            auto_fuse_enabled: auto,
            p2p_fusion_enabled: p2p,
        }
    }

    fn inputs(policy: AutoFusionPolicy, armed: bool, wallet: bool, tor: bool) -> AutoFusionInputs {
        AutoFusionInputs {
            policy,
            session_armed: armed,
            wallet_open: wallet,
            tor_ready: tor,
        }
    }

    /// Reopening the app must not arm a fee-spending loop.
    ///
    /// The persisted preference says the holder wants Auto Fusion. It does not
    /// say they want a round started the moment the process comes back.
    #[test]
    fn a_persisted_preference_is_not_permission_to_spend() {
        let decision = decide_auto_fusion(inputs(policy(true, true, false), false, true, true));
        assert_eq!(
            decision,
            AutoFusionDecision::Hold {
                reason: "Fusion must be started once in this session first",
            }
        );
        // Armed, and the same preference now runs.
        assert!(decide_auto_fusion(inputs(policy(true, true, false), true, true, true)).is_run());
    }

    #[test]
    fn the_master_switch_outranks_everything() {
        assert_eq!(
            decide_auto_fusion(inputs(policy(false, true, false), true, true, true)),
            AutoFusionDecision::Hold {
                reason: "CashFusion is off"
            }
        );
    }

    #[test]
    fn auto_off_holds_even_when_armed() {
        assert_eq!(
            decide_auto_fusion(inputs(policy(true, false, false), true, true, true)),
            AutoFusionDecision::Hold {
                reason: "Auto fusion is off"
            }
        );
    }

    #[test]
    fn no_wallet_means_nothing_to_fuse() {
        assert_eq!(
            decide_auto_fusion(inputs(policy(true, true, false), true, false, true)),
            AutoFusionDecision::Hold {
                reason: "No wallet open"
            }
        );
    }

    /// P2P needs Tor; server fusion enforces its own transport policy.
    #[test]
    fn p2p_requires_tor_and_server_does_not() {
        assert_eq!(
            decide_auto_fusion(inputs(policy(true, true, true), true, true, false)),
            AutoFusionDecision::Hold {
                reason: "Tor is not ready for P2P fusion"
            }
        );
        assert_eq!(
            decide_auto_fusion(inputs(policy(true, true, true), true, true, true)),
            AutoFusionDecision::Run {
                mode: FusionMode::P2p
            }
        );
        // Server mode is unaffected by Tor readiness here.
        assert_eq!(
            decide_auto_fusion(inputs(policy(true, true, false), true, true, false)),
            AutoFusionDecision::Run {
                mode: FusionMode::Server
            }
        );
    }

    /// The two transports are mutually exclusive.
    #[test]
    fn the_policy_selects_exactly_one_transport() {
        assert_eq!(policy(true, true, true).mode(), FusionMode::P2p);
        assert_eq!(policy(true, true, false).mode(), FusionMode::Server);
    }

    /// The rendezvous window is what lets independent clients meet.
    #[test]
    fn the_rendezvous_slot_opens_and_closes_on_a_shared_clock() {
        assert!(is_auto_rendezvous_open(0));
        assert!(is_auto_rendezvous_open(AUTO_RENDEZVOUS_OPEN_MS - 1));
        assert!(!is_auto_rendezvous_open(AUTO_RENDEZVOUS_OPEN_MS));
        assert!(!is_auto_rendezvous_open(AUTO_RENDEZVOUS_PERIOD_MS - 1));
        // The next period opens again.
        assert!(is_auto_rendezvous_open(AUTO_RENDEZVOUS_PERIOD_MS));

        assert_eq!(ms_until_auto_rendezvous_open(0), 0);
        assert_eq!(
            ms_until_auto_rendezvous_open(AUTO_RENDEZVOUS_OPEN_MS),
            AUTO_RENDEZVOUS_PERIOD_MS - AUTO_RENDEZVOUS_OPEN_MS
        );
    }

    /// Transient means "no fee was spent and the next try may work".
    #[test]
    fn empty_pool_and_connect_failures_are_transient() {
        for message in [
            "No other wallets are gathering",
            "no other players joined",
            "could not agree on a transaction",
            "Could not connect to the fusion server",
            "connection refused",
            "No connection could be made because the target machine actively refused it. (os error 10061)",
            "need 3 fresh peers",
            "at least three participants",
            "timed out waiting for the pool",
            "Tor is not ready",
            "receive failed",
        ] {
            assert!(
                is_auto_transient_failure(message),
                "{message:?} should retry quickly"
            );
        }
    }

    /// Anything unrecognised falls back to the ordinary retry rather than
    /// being treated as harmless.
    #[test]
    fn an_unfamiliar_failure_is_not_assumed_transient() {
        for message in [
            "signature verification failed",
            "the wallet is locked",
            "insufficient funds",
        ] {
            assert!(!is_auto_transient_failure(message), "{message:?}");
        }
    }

    /// A cancelling round still holds coins.
    #[test]
    fn cancelling_counts_as_busy() {
        let mut session = FusionSession::default();
        assert!(!session.is_busy());
        session.phase = FusionPhase::Cancelling;
        assert!(session.is_busy());
        assert!(session.is_scheduled());
    }

    #[test]
    fn a_waiting_session_is_scheduled_but_not_busy() {
        let session = FusionSession {
            phase: FusionPhase::Waiting {
                reason: FusionWaitReason::Cooldown,
                until_ms: 1_000,
            },
            ..FusionSession::default()
        };
        assert!(session.is_scheduled());
        assert!(!session.is_busy());
    }

    /// An idle screen explains why nothing is happening.
    ///
    /// "Off" and "waiting to be started once" look identical without it.
    #[test]
    fn an_idle_session_shows_the_reason_it_is_idle() {
        let session = FusionSession::default();
        let view = fusion_view_model(policy(true, true, false), &session, true, true);
        assert_eq!(
            view.status,
            "Fusion must be started once in this session first"
        );
        assert!(view.can_start);
        assert!(!view.can_cancel);
    }

    #[test]
    fn a_running_session_reports_its_transport_and_step() {
        let session = FusionSession {
            phase: FusionPhase::Running {
                mode: FusionMode::P2p,
                step: FusionStep::Gathering,
                participants: Some(4),
            },
            session_armed: true,
            ..FusionSession::default()
        };
        let view = fusion_view_model(policy(true, true, true), &session, true, true);
        assert_eq!(
            view.status,
            "P2P · Waiting for participants (4 participants)"
        );
        assert!(view.can_cancel);
        assert!(!view.can_start, "a round is already running");
    }

    /// Without a wallet there is nothing to start.
    ///
    /// Armed here so the wallet check is the one being exercised: arming is
    /// tested earlier and deliberately outranks it, matching the order the
    /// engine this replaces used.
    #[test]
    fn no_wallet_means_no_start_control() {
        let session = FusionSession {
            session_armed: true,
            ..FusionSession::default()
        };
        let view = fusion_view_model(policy(true, true, false), &session, false, true);
        assert!(!view.can_start);
        assert_eq!(view.status, "No wallet open");
    }
}
