//! Agreeing on a round: proposal, ACK, shrink and start
//! (`nostr/fusionRendezvous.ts`).
//!
//! The elected coordinator proposes the gathered set, every listed peer ACKs,
//! and the round starts only on the full set. If some never ACK, the ACKed
//! remainder may re-propose itself once if it is still at least
//! [`MIN_SAFE_PLAYERS`]. If the elected coordinator never proposes, it is a
//! stored announcement's ghost: drop it and re-elect.
//!
//! Partial relay views mean two peers can each legitimately coordinate. Both
//! then hold both sets and run the same election over their union, which is
//! what makes them converge on one round.

use super::io::{earliest, Action, Clock, Out, Timer};
use super::knobs::{MAX_PLAYERS, MIN_SAFE_PLAYERS, PROPOSAL_TIMEOUT_MS, RENDEZVOUS_RESEND_MS};
use super::pool::elect_coordinator;
use super::wire::{Body, PoolNetwork, RoundMessage};
use super::{hex, random_bytes};

/// How many silent coordinators are dropped before giving up.
const MAX_COORDINATOR_FAILOVERS: u32 = 8;
/// Pause between attempts so peers failing over the same ghost resubscribe
/// before the next proposal.
const ATTEMPT_PAUSE_MS: u64 = 150;

pub const LATE_JOINER_HINT: &str = "Other wallets may have already formed a round without you \
     (you were late or Tor was slow). Auto will retry shortly; \
     Manual Start can try again when peers are online.";

/// The round agreed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Negotiated {
    pub session: String,
    pub coordinator: String,
    pub participants: Vec<String>,
    pub network: PoolNetwork,
    pub tier: u64,
    pub epoch: u64,
}

fn is_round_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Distinct lowercase keys, sorted, capped at the round size
/// (`canonicalParticipants`).
pub fn canonical(candidates: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = candidates
        .iter()
        .filter(|key| is_round_key(key))
        .cloned()
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys.truncate(MAX_PLAYERS);
    keys
}

/// Whether `from`'s set outranks `mine`: the election over their union picks
/// `from` (`outranks`).
fn outranks(from: &str, theirs: &[String], mine: &[String]) -> bool {
    let union: Vec<String> = mine.iter().chain(theirs).cloned().collect();
    elect_coordinator(&canonical(&union)).as_deref() == Some(from)
}

struct Proposal {
    session: String,
    participants: Vec<String>,
}

struct Coordinating {
    session: String,
    participants: Vec<String>,
    others: Vec<String>,
    acks: std::collections::BTreeSet<String>,
    settle_passed: bool,
    starting: bool,
    yielded: Option<(String, Proposal)>,
    repropose: Option<Timer>,
    settle: Option<Timer>,
    ack_wait: Option<Timer>,
}

struct Participating {
    expected: String,
    accepted: Option<(String, Proposal)>,
    shrink_remaining: Option<Vec<String>>,
    ack_resend: Option<Timer>,
    proposal_wait: Option<Timer>,
    give_up: Option<Timer>,
}

enum Mode {
    Coordinator(Coordinating),
    Participant(Participating),
    /// Between attempts.
    Paused(Option<Timer>),
}

/// Why an attempt ended without a round.
enum Ended {
    /// Re-propose the exact ACKed remainder.
    Shrink(Vec<String>),
    Failed(String),
}

/// The rendezvous for one gathered group.
pub struct Rendezvous {
    me: String,
    network: PoolNetwork,
    tier: u64,
    epoch: u64,
    candidates: Vec<String>,
    deadline_ms: u64,
    attempt: u32,
    mode: Mode,
    outcome: Option<Result<Negotiated, String>>,
    out: Out,
}

impl Rendezvous {
    /// Start agreeing on `candidates` (the gathered group, self included)
    /// within `timeout_ms`.
    pub fn start(
        me: &str,
        candidates: &[String],
        network: PoolNetwork,
        tier: u64,
        epoch: u64,
        timeout_ms: u64,
        clock: Clock,
    ) -> Self {
        let mut all = candidates.to_vec();
        all.push(me.to_owned());
        let mut rendezvous = Self {
            me: me.to_owned(),
            network,
            tier,
            epoch,
            candidates: canonical(&all),
            deadline_ms: clock.ms + timeout_ms,
            attempt: 0,
            mode: Mode::Paused(None),
            outcome: None,
            out: Out::default(),
        };
        if !is_round_key(me) {
            rendezvous.outcome = Some(Err("invalid local Fusion round pubkey".into()));
        } else {
            rendezvous.begin_attempt(clock);
        }
        rendezvous
    }

    /// The agreed round, or why there is none, once decided.
    pub fn outcome(&self) -> Option<&Result<Negotiated, String>> {
        self.outcome.as_ref()
    }

    /// When to call [`Rendezvous::tick`] next.
    pub fn next_deadline(&self) -> Option<u64> {
        if self.outcome.is_some() {
            return None;
        }
        match &self.mode {
            Mode::Coordinator(state) => {
                earliest([&state.repropose, &state.settle, &state.ack_wait])
            }
            Mode::Participant(state) => {
                earliest([&state.ack_resend, &state.proposal_wait, &state.give_up])
            }
            Mode::Paused(timer) => earliest([timer]),
        }
    }

    pub fn take_actions(&mut self) -> Vec<Action> {
        self.out.take()
    }

    fn begin_attempt(&mut self, clock: Clock) {
        if self.candidates.len() < MIN_SAFE_PLAYERS {
            self.outcome = Some(Err(format!(
                "P2P Fusion needs at least {MIN_SAFE_PLAYERS} fresh peers (CashFusion-style anonymity floor)."
            )));
            return;
        }
        let Some(coordinator) = elect_coordinator(&self.candidates) else {
            self.outcome = Some(Err("P2P Fusion coordinator election failed.".into()));
            return;
        };
        let remaining = self.deadline_ms.saturating_sub(clock.ms);
        if remaining == 0 {
            self.outcome = Some(Err(format!(
                "Round agreement timed out with {} candidate(s). {LATE_JOINER_HINT}",
                self.candidates.len()
            )));
            return;
        }
        if coordinator == self.me {
            self.coordinate(remaining, clock);
        } else {
            self.mode = Mode::Participant(Participating {
                expected: coordinator,
                accepted: None,
                shrink_remaining: None,
                ack_resend: None,
                proposal_wait: Some(Timer::once(clock.ms + PROPOSAL_TIMEOUT_MS.min(remaining))),
                give_up: Some(Timer::once(clock.ms + remaining)),
            });
        }
    }

    fn coordinate(&mut self, timeout_ms: u64, clock: Clock) {
        let session = hex(&random_bytes::<32>());
        let participants = self.candidates.clone();
        let others: Vec<String> = participants
            .iter()
            .filter(|key| **key != self.me)
            .cloned()
            .collect();
        let settle_ms = 5_000.min(1_000.max(timeout_ms * 6 / 10));
        let ack_wait_ms = if timeout_ms <= 200 {
            timeout_ms
        } else {
            1_000.max(timeout_ms.saturating_sub(12_000.min(2_000.max(timeout_ms / 4))))
        };
        let mut acks = std::collections::BTreeSet::new();
        acks.insert(self.me.clone());
        let state = Coordinating {
            session,
            participants,
            others,
            acks,
            settle_passed: false,
            starting: false,
            yielded: None,
            repropose: Some(Timer::repeat(clock, RENDEZVOUS_RESEND_MS, None)),
            settle: Some(Timer::once(clock.ms + settle_ms)),
            ack_wait: Some(Timer::once(clock.ms + ack_wait_ms)),
        };
        self.mode = Mode::Coordinator(state);
        self.publish_proposal(clock);
    }

    fn publish_proposal(&mut self, clock: Clock) {
        let Mode::Coordinator(state) = &self.mode else {
            return;
        };
        for peer in &state.others {
            self.out.send(
                peer,
                &state.session,
                Body::RoundProposal {
                    network: self.network,
                    tier: self.tier,
                    epoch: self.epoch,
                    participants: state.participants.clone(),
                },
                clock,
            );
        }
    }

    fn ack(&mut self, to: &str, session: &str, clock: Clock) {
        let body = Body::RoundAck {
            network: self.network,
            tier: self.tier,
            epoch: self.epoch,
        };
        self.out.send(to, session, body, clock);
    }

    fn succeed(&mut self, session: String, coordinator: String, participants: Vec<String>) {
        self.outcome = Some(Ok(Negotiated {
            session,
            coordinator,
            participants,
            network: self.network,
            tier: self.tier,
            epoch: self.epoch,
        }));
    }

    /// An attempt ended. Shrink and silent-coordinator failover start the
    /// next one; anything else is the outcome.
    fn end_attempt(&mut self, ended: Ended, clock: Clock) {
        let was_participant_of = match &self.mode {
            Mode::Participant(state) => Some(state.expected.clone()),
            _ => None,
        };
        match ended {
            Ended::Shrink(remaining) => {
                self.candidates = remaining;
            }
            Ended::Failed(message) => {
                let silent =
                    was_participant_of.is_some() && message.contains("round start timed out");
                if !silent || self.attempt >= MAX_COORDINATOR_FAILOVERS {
                    let message = if (message.contains("round start timed out")
                        || message.contains("round acknowledgments timed out"))
                        && !message.contains("smaller round")
                    {
                        format!("{message}. {LATE_JOINER_HINT}")
                    } else {
                        message
                    };
                    self.outcome = Some(Err(message));
                    return;
                }
                let ghost = was_participant_of.expect("silent implies participant");
                self.candidates.retain(|key| *key != ghost);
            }
        }
        self.attempt += 1;
        self.mode = Mode::Paused(Some(Timer::once(clock.ms + ATTEMPT_PAUSE_MS)));
    }

    /// A proposal this peer may take: right network and tier, a canonical set
    /// that includes it, and proposed by that set's elected coordinator
    /// (`validProposal`). The epoch is informational on the rolling pool.
    fn valid_proposal(&self, from: &str, message: &RoundMessage) -> Option<Proposal> {
        let Body::RoundProposal {
            network,
            tier,
            participants,
            ..
        } = &message.body
        else {
            return None;
        };
        let set = canonical(participants);
        let valid = is_round_key(from)
            && is_round_key(&message.session)
            && *network == self.network
            && *tier == self.tier
            && set.len() >= MIN_SAFE_PLAYERS
            && set == *participants
            && set.contains(&self.me)
            && elect_coordinator(&set).as_deref() == Some(from);
        valid.then(|| Proposal {
            session: message.session.clone(),
            participants: set,
        })
    }

    fn same_binding(&self, message: &RoundMessage) -> bool {
        match &message.body {
            Body::RoundAck { network, tier, .. }
            | Body::RoundStart { network, tier, .. }
            | Body::RoundShrink { network, tier, .. } => {
                *network == self.network && *tier == self.tier
            }
            _ => false,
        }
    }

    /// Feed one parsed round message from round key `from`.
    pub fn on_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        if self.outcome.is_some() {
            return;
        }
        match &self.mode {
            Mode::Coordinator(_) => self.coordinator_message(from, message, clock),
            Mode::Participant(_) => self.participant_message(from, message, clock),
            Mode::Paused(_) => {}
        }
    }

    fn coordinator_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        let proposal = self.valid_proposal(from, message);
        let Mode::Coordinator(state) = &mut self.mode else {
            return;
        };
        if let Some(proposal) = proposal {
            let beats_ours = outranks(from, &proposal.participants, &state.participants);
            let beats_yielded = state.yielded.as_ref().is_none_or(|(_, yielded)| {
                outranks(from, &proposal.participants, &yielded.participants)
            });
            let already = state
                .yielded
                .as_ref()
                .is_some_and(|(coordinator, _)| coordinator == from);
            if !already && beats_ours && beats_yielded {
                let session = proposal.session.clone();
                state.yielded = Some((from.to_owned(), proposal));
                state.settle = None;
                self.ack(from, &session, clock);
                return;
            }
        }
        let same_binding = self.same_binding(message);
        let Mode::Coordinator(state) = &mut self.mode else {
            return;
        };
        if let Some((coordinator, yielded)) = &state.yielded {
            if coordinator == from && message.session == yielded.session {
                match &message.body {
                    Body::Abort { reason } => {
                        let reason = format!("fusion round aborted: {reason}");
                        self.end_attempt(Ended::Failed(reason), clock);
                        return;
                    }
                    Body::RoundStart { participants, .. }
                        if same_binding && participants.contains(&self.me) =>
                    {
                        let (session, participants) =
                            (message.session.clone(), participants.clone());
                        self.succeed(session, from.to_owned(), participants);
                        return;
                    }
                    _ => {}
                }
            }
            return;
        }
        if matches!(message.body, Body::RoundAck { .. })
            && message.session == state.session
            && same_binding
            && state.others.iter().any(|key| key == from)
        {
            state.acks.insert(from.to_owned());
            if state.settle_passed {
                self.start_own_round(clock);
            }
        }
    }

    fn start_own_round(&mut self, clock: Clock) {
        let Mode::Coordinator(state) = &mut self.mode else {
            return;
        };
        if state.yielded.is_some() || state.starting {
            return;
        }
        let finals: Vec<String> = state.acks.iter().cloned().collect();
        // The proposed set is the round: full ACK or nothing.
        if finals != state.participants {
            return;
        }
        state.starting = true;
        let session = state.session.clone();
        for peer in finals.iter().filter(|key| **key != self.me) {
            self.out.send(
                peer,
                &session,
                Body::RoundStart {
                    network: self.network,
                    tier: self.tier,
                    epoch: self.epoch,
                    participants: finals.clone(),
                },
                clock,
            );
        }
        let me = self.me.clone();
        self.succeed(session, me, finals);
    }

    fn participant_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        let proposal = self.valid_proposal(from, message);
        let same_binding = self.same_binding(message);
        let candidates = self.candidates.clone();
        let me = self.me.clone();
        let Mode::Participant(state) = &mut self.mode else {
            return;
        };
        let current = state
            .accepted
            .as_ref()
            .map(|(coordinator, _)| coordinator.clone())
            .unwrap_or_else(|| state.expected.clone());
        match &message.body {
            Body::Abort { reason }
                if from == current
                    && state
                        .accepted
                        .as_ref()
                        .is_none_or(|(_, proposal)| proposal.session == message.session) =>
            {
                let reason = format!("fusion round aborted: {reason}");
                self.end_attempt(Ended::Failed(reason), clock);
                return;
            }
            Body::RoundShrink { remaining, .. } if from == current && same_binding => {
                let remaining = canonical(remaining);
                let previous = state
                    .accepted
                    .as_ref()
                    .map(|(_, proposal)| proposal.participants.clone())
                    .unwrap_or(candidates);
                if remaining.len() >= MIN_SAFE_PLAYERS
                    && remaining.len() < previous.len()
                    && remaining.contains(&me)
                    && remaining.iter().all(|key| previous.contains(key))
                {
                    let next = elect_coordinator(&remaining);
                    if next.as_deref() == Some(me.as_str()) {
                        // The reduced set elects us: re-enter as coordinator.
                        self.end_attempt(Ended::Shrink(remaining), clock);
                        return;
                    }
                    state.expected = next.unwrap_or_else(|| state.expected.clone());
                    state.shrink_remaining = Some(remaining);
                    state.accepted = None;
                    state.ack_resend = None;
                }
                return;
            }
            _ => {}
        }
        if let Some(proposal) = proposal {
            if state
                .accepted
                .as_ref()
                .is_some_and(|(coordinator, _)| coordinator == from)
            {
                return;
            }
            if state
                .shrink_remaining
                .as_ref()
                .is_some_and(|remaining| *remaining != proposal.participants)
            {
                return;
            }
            if state.accepted.is_none()
                && from != state.expected
                && !outranks(from, &proposal.participants, &self.candidates)
            {
                return;
            }
            if state.accepted.as_ref().is_some_and(|(_, accepted)| {
                !outranks(from, &proposal.participants, &accepted.participants)
            }) {
                return;
            }
            let session = proposal.session.clone();
            state.accepted = Some((from.to_owned(), proposal));
            state.ack_resend = Some(Timer::repeat(clock, RENDEZVOUS_RESEND_MS, None));
            self.ack(from, &session, clock);
            return;
        }
        if let Body::RoundStart { participants, .. } = &message.body {
            if let Some((coordinator, accepted)) = &state.accepted {
                if coordinator == from
                    && message.session == accepted.session
                    && same_binding
                    && participants.contains(&me)
                {
                    let (session, participants) = (message.session.clone(), participants.clone());
                    self.succeed(session, from.to_owned(), participants);
                }
            }
        }
    }

    /// Fire due timers.
    pub fn tick(&mut self, clock: Clock) {
        if self.outcome.is_some() {
            return;
        }
        match &mut self.mode {
            Mode::Paused(timer) => {
                if Timer::fire(timer, clock.ms) {
                    self.begin_attempt(clock);
                }
            }
            Mode::Coordinator(state) => {
                let repropose = Timer::fire(&mut state.repropose, clock.ms)
                    && !state.starting
                    && state.yielded.is_none();
                let settle = Timer::fire(&mut state.settle, clock.ms);
                let ack_wait = Timer::fire(&mut state.ack_wait, clock.ms);
                if repropose {
                    self.publish_proposal(clock);
                }
                if settle {
                    if let Mode::Coordinator(state) = &mut self.mode {
                        state.settle_passed = true;
                    }
                    self.start_own_round(clock);
                }
                if ack_wait && self.outcome.is_none() {
                    self.ack_wait_expired(clock);
                }
            }
            Mode::Participant(state) => {
                if Timer::fire(&mut state.ack_resend, clock.ms) {
                    if let Some((coordinator, proposal)) = &state.accepted {
                        let (to, session) = (coordinator.clone(), proposal.session.clone());
                        self.ack(&to, &session, clock);
                    }
                }
                let Mode::Participant(state) = &mut self.mode else {
                    return;
                };
                let proposal_missed = Timer::fire(&mut state.proposal_wait, clock.ms)
                    && state.accepted.is_none()
                    && state.shrink_remaining.is_none();
                let gave_up = Timer::fire(&mut state.give_up, clock.ms);
                if proposal_missed || gave_up {
                    self.end_attempt(Ended::Failed("round start timed out".into()), clock);
                }
            }
        }
    }

    fn ack_wait_expired(&mut self, clock: Clock) {
        let Mode::Coordinator(state) = &mut self.mode else {
            return;
        };
        if state.starting || state.yielded.is_some() || state.acks.len() == state.participants.len()
        {
            return;
        }
        let remaining: Vec<String> = state.acks.iter().cloned().collect();
        let proposed = state.participants.len();
        if remaining.len() >= MIN_SAFE_PLAYERS
            && remaining.len() < proposed
            && remaining.contains(&self.me)
        {
            // One shrink to the exact ACKed set; the missing peers are told
            // to retry and the remainder re-elects.
            let session = state.session.clone();
            let missing: Vec<String> = state
                .participants
                .iter()
                .filter(|key| !state.acks.contains(*key))
                .cloned()
                .collect();
            for peer in remaining.iter().filter(|key| **key != self.me) {
                self.out.send(
                    peer,
                    &session,
                    Body::RoundShrink {
                        network: self.network,
                        tier: self.tier,
                        epoch: self.epoch,
                        remaining: remaining.clone(),
                    },
                    clock,
                );
            }
            for peer in &missing {
                self.out.send(
                    peer,
                    &session,
                    Body::Abort {
                        reason: format!(
                            "Not in the ACKed set ({}/{proposed}) — Auto will retry.",
                            remaining.len()
                        ),
                    },
                    clock,
                );
            }
            self.end_attempt(Ended::Shrink(remaining), clock);
            return;
        }
        let reason = format!(
            "round acknowledgments timed out (only {}/{proposed} answered). Need ≥{MIN_SAFE_PLAYERS} to shrink; Auto will retry.",
            state.acks.len()
        );
        self.abort(&reason, clock);
        self.end_attempt(Ended::Failed(reason), clock);
    }

    /// Tell the peers of the current attempt that it is over.
    fn abort(&mut self, reason: &str, clock: Clock) {
        let Mode::Coordinator(state) = &self.mode else {
            return;
        };
        let (session, targets) = match &state.yielded {
            Some((coordinator, proposal)) => (proposal.session.clone(), vec![coordinator.clone()]),
            None => (state.session.clone(), state.others.clone()),
        };
        let reason: String = reason
            .chars()
            .take(super::wire::MAX_ABORT_REASON_CHARS)
            .collect();
        for peer in targets {
            self.out.send(
                &peer,
                &session,
                Body::Abort {
                    reason: reason.clone(),
                },
                clock,
            );
        }
    }

    /// The holder cancelled: tell the other side and stop.
    pub fn cancel(&mut self, clock: Clock) {
        if self.outcome.is_some() {
            return;
        }
        self.abort("cancelled", clock);
        self.outcome = Some(Err("fusion round aborted: cancelled".into()));
    }
}
