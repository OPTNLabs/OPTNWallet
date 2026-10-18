//! The round itself, as coordinator or participant (`nostr/fusionSession.ts`
//! `runFusionRound`, `runCoordinator`, `runParticipant`).
//!
//! 1. The coordinator publishes its blind-issuer parameters; each peer asks
//!    for one credential per component with Pedersen commitments that prove
//!    its balance, and the coordinator answers only inside the peer's slots.
//! 2. Inputs arrive anonymously with their credentials. Outputs travel the
//!    onion through every peer but the coordinator, shuffled at each hop;
//!    the last peeler reveals them, credentials attached, to the coordinator.
//! 3. The coordinator assembles the canonical CoinJoin; every peer rebuilds
//!    and checks it, then signs only its own inputs, anonymously.
//! 4. The coordinator verifies every signature, broadcasts, and sends the
//!    final transaction, which every peer checks and rebroadcasts.
//!
//! A peer never signs a transaction that drops or shortens one of its outputs
//! or pays an unreasonable fee, whatever the coordinator does.

use std::collections::{HashMap, HashSet, VecDeque};

use super::assemble::{assemble, finalize, verify_final, verify_safety, Assembled, Contribution};
use super::blame::{
    abort_reason, verify as verify_blame, BlameEvidence, BlameReport, VerifyContext,
};
use super::credentials::{
    input_credential_hash, peer_slot_base, plan_credentials, total_slots, verify_output_batch,
    verify_schnorr_hex, CredentialPlan, Issuer, CREDENTIAL_SLOTS_PER_PEER,
    MAX_OUTPUT_CREDENTIALS_PER_PEER,
};
use super::io::{earliest, Action, Clock, Out, Timer};
use super::knobs::{CREDENTIAL_WAIT_MS, MIN_SAFE_PLAYERS};
use super::onion;
use super::pool::elect_coordinator;
use super::timing::{
    missing_outputs_wait_ms, ASSEMBLED_RESEND_MS, CREDENTIAL_PARAMS_RESEND_MAX,
    CREDENTIAL_PARAMS_RESEND_MS, ONION_DECLARE_RESEND_MAX, ONION_DECLARE_RESEND_MS,
    ONION_OUTPUT_RESEND_MAX, ONION_OUTPUT_RESEND_MS, PEER_BROADCAST_JITTER_MS,
    PEER_TIMEOUT_MARGIN_MS, SIG_RESEND_MS,
};
use super::wire::{
    AuthorizedOutput, Body, InputRef, InputSig, OutputRef, PoolNetwork, RoundMessage,
};
use super::{fee_for_bytes, jitter_ms, secure_shuffle};

/// Signs this wallet's own inputs of an approved template. Production passes
/// the native `p2p_sign` boundary, which repeats the safety checks itself.
pub type Signer = Box<dyn FnMut(&Assembled) -> Result<Vec<InputSig>, String> + Send>;

/// Everything a round needs.
pub struct RoundParams {
    /// This attempt's x-only round key.
    pub my_pubkey: String,
    /// Its secret, for peeling onion layers.
    pub round_secret: [u8; 32],
    pub participants: Vec<String>,
    pub session: String,
    /// The round's network and tier. The v4 credential binds the component
    /// alone, so the round itself does not read them; the host does.
    pub network: PoolNetwork,
    pub tier: u64,
    pub feerate: u64,
    pub contribution: Contribution,
    pub signer: Signer,
    pub timeout_ms: u64,
    /// Delay between successive component sends.
    pub jitter_ms: (u64, u64),
}

/// A fused round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundResult {
    pub txid: String,
    pub tx_hex: String,
}

/// Something to do later: a jittered send or a step that follows one.
enum Item {
    Send {
        to: String,
        body: Body,
    },
    /// The first peeler injects its own onions locally.
    FeedOwnOnions(Vec<String>),
    ArmDeclareResend,
    ArmInjectResend,
    /// Coordinator: its own onions are out, so it counts as ready.
    MarkSelfReady,
    /// Participant: everything is sent; tell the coordinator.
    ComponentsReady,
}

struct Scheduled {
    due: u64,
    item: Item,
}

/// What both roles share.
struct Common {
    me: String,
    secret: [u8; 32],
    participants: Vec<String>,
    session: String,
    feerate: u64,
    contribution: Contribution,
    signer: Signer,
    jitter: (u64, u64),
    coordinator: String,
    /// Every participant but the coordinator, sorted: the peel order.
    mix_order: Vec<String>,
    seen_nonces: HashSet<String>,
    queue: VecDeque<Scheduled>,
    out: Out,
    outcome: Option<Result<RoundResult, String>>,
    round_timer: Option<Timer>,
}

impl Common {
    fn send(&mut self, to: &str, body: Body, clock: Clock) {
        let session = self.session.clone();
        self.out.send(to, &session, body, clock);
    }

    fn schedule(&mut self, due: u64, item: Item) {
        self.queue.push_back(Scheduled { due, item });
    }

    fn jitter(&self) -> u64 {
        jitter_ms(self.jitter)
    }

    /// Wrap each output in the onion for every peeler.
    fn onion_payloads(&self, outputs: &[AuthorizedOutput]) -> Result<Vec<String>, String> {
        if self.mix_order.len() < 2 {
            return Err("onion mix-net requires ≥2 peelers (need ≥3 participants)".into());
        }
        outputs
            .iter()
            .map(|output| {
                let payload = onion::encode_authorized_output(output)?;
                Ok(onion::to_base64(&onion::wrap(&payload, &self.mix_order)?))
            })
            .collect()
    }

    /// The signing gate, then this wallet's signatures
    /// (`assembleVerifySign`).
    fn assemble_verify_sign(
        &mut self,
        inputs: &[InputRef],
        outputs: &[OutputRef],
    ) -> Result<(Assembled, Vec<InputSig>), String> {
        let tx = assemble([(inputs, outputs)])?;
        let safety = verify_safety(&tx, &self.contribution, self.feerate);
        if !safety.ok {
            return Err(format!(
                "refusing to sign: {}",
                safety.reason.unwrap_or_default()
            ));
        }
        let sigs = (self.signer)(&tx)?;
        if sigs.len() != self.contribution.inputs.len() {
            return Err("refusing to sign: a private key is missing for my input".into());
        }
        Ok((tx, sigs))
    }

    /// Verify a blame report against this round.
    fn verified_blame(&self, from: &str, message: &RoundMessage) -> Option<BlameReport> {
        let Body::Blame {
            accused,
            code,
            evidence,
        } = &message.body
        else {
            return None;
        };
        if !self.participants.iter().any(|key| key == from) {
            return None;
        }
        let report = BlameReport {
            session: message.session.clone(),
            accused: accused.clone(),
            code: *code,
            evidence: (**evidence).clone(),
        };
        let ctx = VerifyContext {
            session: &self.session,
            participants: &self.participants,
            feerate: Some(self.feerate),
        };
        verify_blame(&report, &ctx).ok().map(|()| report)
    }

    /// Accept a message once: right session, unseen nonce.
    fn admit(&mut self, message: &RoundMessage) -> bool {
        self.outcome.is_none()
            && message.session == self.session
            && self.seen_nonces.insert(message.nonce.clone())
    }

    /// Items whose time has come, in order.
    fn due_items(&mut self, now: u64) -> Vec<Item> {
        let mut due = Vec::new();
        while self.queue.front().is_some_and(|entry| entry.due <= now) {
            due.push(self.queue.pop_front().expect("checked").item);
        }
        due
    }
}

/// The participant role.
struct Participant {
    c: Common,
    my_index: Option<usize>,
    plan: Option<CredentialPlan>,
    params_received: bool,
    response_received: bool,
    params_wait: Option<Timer>,
    response_wait: Option<Timer>,
    signed: bool,
    approved: Option<Assembled>,
    declared: HashMap<String, u32>,
    collected: Vec<String>,
    seen_payloads: HashSet<String>,
    batch_done: bool,
    injects: Vec<String>,
    forwarded: Option<(String, Vec<String>)>,
    signatures: Vec<InputSig>,
    declare_resend: Option<Timer>,
    inject_resend: Option<Timer>,
    forward_resend: Option<Timer>,
    sig_resend: Option<Timer>,
}

/// The coordinator role.
struct Coordinator {
    c: Common,
    others: Vec<String>,
    issuer: Issuer,
    own_outputs: Vec<AuthorizedOutput>,
    own_injects: Vec<String>,
    credentialed_inputs: HashSet<String>,
    anonymous_inputs: Vec<InputRef>,
    credentialed_peers: HashSet<String>,
    input_quota: HashMap<String, u32>,
    output_quota: HashMap<String, u32>,
    ready: HashSet<String>,
    output_batches: Vec<Vec<AuthorizedOutput>>,
    nullifiers: HashSet<String>,
    signatures: HashMap<String, InputSig>,
    assembled: Option<Assembled>,
    finalized: Option<(String, String)>,
    broadcast_started: bool,
    params_resend: Option<Timer>,
    declare_resend: Option<Timer>,
    inject_resend: Option<Timer>,
    assembled_resend: Option<Timer>,
    missing_outputs: Option<Timer>,
}

/// One round in progress.
pub enum Round {
    Coordinator(Box<CoordinatorRound>),
    Participant(Box<ParticipantRound>),
}

pub struct CoordinatorRound(Coordinator);
pub struct ParticipantRound(Participant);

impl Round {
    /// Start a round on an agreed participant set (`runFusionRound`).
    pub fn start(params: RoundParams, clock: Clock) -> Result<Self, String> {
        let mut participants = params.participants.clone();
        participants.sort_unstable();
        participants.dedup();
        if participants.len() < MIN_SAFE_PLAYERS || !participants.contains(&params.my_pubkey) {
            return Err(format!(
                "invalid Fusion participant set (need ≥{MIN_SAFE_PLAYERS} peers for onion P2P fusion)"
            ));
        }
        let coordinator =
            elect_coordinator(&participants).ok_or("Fusion coordinator election failed")?;
        // Keep the caller's order: slot bases sort it themselves.
        let participants: Vec<String> = {
            let mut seen = HashSet::new();
            params
                .participants
                .iter()
                .filter(|key| seen.insert((*key).clone()))
                .cloned()
                .collect()
        };
        let mut mix_order: Vec<String> = participants
            .iter()
            .filter(|key| **key != coordinator)
            .cloned()
            .collect();
        mix_order.sort_unstable();
        let is_coordinator = coordinator == params.my_pubkey;
        let timeout = if is_coordinator {
            params.timeout_ms
        } else {
            params.timeout_ms + PEER_TIMEOUT_MARGIN_MS
        };
        let common = Common {
            me: params.my_pubkey,
            secret: params.round_secret,
            participants,
            session: params.session,
            feerate: params.feerate,
            contribution: params.contribution,
            signer: params.signer,
            jitter: params.jitter_ms,
            coordinator,
            mix_order,
            seen_nonces: HashSet::new(),
            queue: VecDeque::new(),
            out: Out::default(),
            outcome: None,
            round_timer: Some(Timer::once(clock.ms + timeout)),
        };
        if is_coordinator {
            Ok(Round::Coordinator(Box::new(CoordinatorRound(
                Coordinator::start(common, clock)?,
            ))))
        } else {
            Ok(Round::Participant(Box::new(ParticipantRound(
                Participant::start(common, clock),
            ))))
        }
    }

    fn common(&self) -> &Common {
        match self {
            Round::Coordinator(round) => &round.0.c,
            Round::Participant(round) => &round.0.c,
        }
    }

    pub fn is_coordinator(&self) -> bool {
        matches!(self, Round::Coordinator(_))
    }

    pub fn coordinator(&self) -> &str {
        &self.common().coordinator
    }

    pub fn outcome(&self) -> Option<&Result<RoundResult, String>> {
        self.common().outcome.as_ref()
    }

    pub fn take_actions(&mut self) -> Vec<Action> {
        match self {
            Round::Coordinator(round) => round.0.c.out.take(),
            Round::Participant(round) => round.0.c.out.take(),
        }
    }

    /// When to call [`Round::tick`] next.
    pub fn next_deadline(&self) -> Option<u64> {
        if self.outcome().is_some() {
            return None;
        }
        let queued = self.common().queue.front().map(|entry| entry.due);
        let timers = match self {
            Round::Coordinator(round) => {
                let state = &round.0;
                earliest([
                    &state.c.round_timer,
                    &state.params_resend,
                    &state.declare_resend,
                    &state.inject_resend,
                    &state.assembled_resend,
                    &state.missing_outputs,
                ])
            }
            Round::Participant(round) => {
                let state = &round.0;
                earliest([
                    &state.c.round_timer,
                    &state.params_wait,
                    &state.response_wait,
                    &state.declare_resend,
                    &state.inject_resend,
                    &state.forward_resend,
                    &state.sig_resend,
                ])
            }
        };
        [queued, timers].into_iter().flatten().min()
    }

    /// Feed one parsed message from Nostr key `from` (a throwaway key for
    /// anonymous components).
    pub fn on_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        match self {
            Round::Coordinator(round) => round.0.on_message(from, message, clock),
            Round::Participant(round) => round.0.on_message(from, message, clock),
        }
    }

    /// A message from `from` that did not parse.
    pub fn on_protocol_error(&mut self, from: &str, error: &str, clock: Clock) {
        match self {
            Round::Coordinator(round) => {
                if round.0.others.iter().any(|key| key == from) {
                    round.0.fail(error.to_owned(), true, false, clock);
                }
            }
            Round::Participant(round) => {
                if round.0.c.coordinator == from {
                    round.0.fail(error.to_owned(), true, clock);
                }
            }
        }
    }

    /// Coordinator: the outcome of [`Action::Broadcast`].
    pub fn on_broadcast(&mut self, result: Result<String, String>, clock: Clock) {
        if let Round::Coordinator(round) = self {
            round.0.on_broadcast(result, clock);
        }
    }

    pub fn tick(&mut self, clock: Clock) {
        match self {
            Round::Coordinator(round) => round.0.tick(clock),
            Round::Participant(round) => round.0.tick(clock),
        }
    }

    /// The holder cancelled.
    pub fn cancel(&mut self, clock: Clock) {
        match self {
            Round::Coordinator(round) => {
                round
                    .0
                    .fail("fusion round aborted: cancelled".into(), true, false, clock)
            }
            Round::Participant(round) => {
                round
                    .0
                    .fail("fusion round aborted: cancelled".into(), true, clock)
            }
        }
    }
}

// ── Participant ────────────────────────────────────────────────────────────

impl Participant {
    fn start(c: Common, clock: Clock) -> Self {
        let my_index = c.mix_order.iter().position(|key| *key == c.me);
        let mut participant = Self {
            c,
            my_index,
            plan: None,
            params_received: false,
            response_received: false,
            params_wait: Some(Timer::once(clock.ms + CREDENTIAL_WAIT_MS)),
            response_wait: None,
            signed: false,
            approved: None,
            declared: HashMap::new(),
            collected: Vec::new(),
            seen_payloads: HashSet::new(),
            batch_done: false,
            injects: Vec::new(),
            forwarded: None,
            signatures: Vec::new(),
            declare_resend: None,
            inject_resend: None,
            forward_resend: None,
            sig_resend: None,
        };
        participant.c.out.phase(2);
        participant
            .c
            .out
            .status("Waiting for coordinator credentials (other wallets must have agreed)…");
        participant
    }

    fn fail(&mut self, error: String, notify: bool, clock: Clock) {
        if self.c.outcome.is_some() {
            return;
        }
        self.c.out.status(format!("Round failed: {error}"));
        if notify {
            let coordinator = self.c.coordinator.clone();
            let reason: String = error
                .chars()
                .take(super::wire::MAX_ABORT_REASON_CHARS)
                .collect();
            self.c.send(&coordinator, Body::Abort { reason }, clock);
        }
        self.c.outcome = Some(Err(error));
        self.c.queue.clear();
    }

    fn on_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        if !self.c.admit(message) {
            return;
        }
        match &message.body {
            // Attributable: a peeler needs every peer's count first.
            Body::OnionDeclare { output_count } => {
                if self.c.participants.iter().any(|key| key == from) {
                    self.declared.insert(from.to_owned(), *output_count);
                    self.process_onions(clock);
                }
                return;
            }
            // Anonymous by design: `from` is a throwaway key.
            Body::OnionOutput { onion, .. } => {
                self.take_onion(onion.clone(), clock);
                return;
            }
            Body::Blame { .. } => {
                if let Some(report) = self.c.verified_blame(from, message) {
                    let reason = abort_reason(report.code);
                    self.c.out.actions.push(Action::Blame(report));
                    self.fail(reason, false, clock);
                }
                return;
            }
            _ => {}
        }
        if from != self.c.coordinator {
            return;
        }
        match &message.body {
            Body::Abort { reason } => {
                // A generic abort never names anyone: a coordinator that
                // dropped an honest signature must not be able to demand
                // openings and frame its owner.
                self.fail(format!("fusion round aborted: {reason}"), false, clock);
            }
            Body::CredentialParams {
                round_pubkey,
                blind_nonce_points,
            } if !self.params_received => {
                self.params_received = true;
                self.params_wait = None;
                let (round_pubkey, points) = (round_pubkey.clone(), blind_nonce_points.clone());
                if let Err(error) = self.request_credentials(&round_pubkey, &points, clock) {
                    self.fail(error, true, clock);
                }
            }
            Body::CredentialResponse { responses }
                if self.plan.is_some() && !self.response_received =>
            {
                self.response_received = true;
                self.response_wait = None;
                let responses: HashMap<u32, String> = responses
                    .iter()
                    .map(|slot| (slot.index, slot.s.clone()))
                    .collect();
                if let Err(error) = self.register(&responses, clock) {
                    self.fail(error, true, clock);
                }
            }
            Body::Assembled { inputs, outputs } if !self.signed => {
                self.signed = true;
                let (inputs, outputs) = (inputs.clone(), outputs.clone());
                self.c.out.phase(5);
                self.c
                    .out
                    .status("Assembled tx received — signing our inputs…");
                match self.c.assemble_verify_sign(&inputs, &outputs) {
                    Ok((tx, sigs)) => {
                        self.approved = Some(tx);
                        self.signatures = sigs;
                        self.c.out.phase(6);
                        self.send_signatures(clock);
                        self.sig_resend = Some(Timer::repeat(clock, SIG_RESEND_MS, None));
                    }
                    Err(error) => self.fail(error, true, clock),
                }
            }
            Body::Final { txid, tx_hex } => {
                let Some(approved) = self.approved.as_ref().filter(|_| self.signed) else {
                    self.fail(
                        "received final transaction before verification".into(),
                        true,
                        clock,
                    );
                    return;
                };
                match verify_final(approved, tx_hex, txid) {
                    Ok(txid) => {
                        self.c.out.phase(7);
                        self.c.out.status("Final tx verified — broadcasting…");
                        // Any peer can save a round whose coordinator lost
                        // its connection; the jitter spreads the copies.
                        self.c.out.actions.push(Action::Rebroadcast {
                            tx_hex: tx_hex.clone(),
                            after_ms: jitter_ms(PEER_BROADCAST_JITTER_MS),
                        });
                        self.c.out.status(format!(
                            "Round complete — txid {}… (broadcasting)",
                            &txid[..12]
                        ));
                        self.c.outcome = Some(Ok(RoundResult {
                            txid,
                            tx_hex: tx_hex.clone(),
                        }));
                        self.c.queue.clear();
                    }
                    Err(error) => self.fail(error, true, clock),
                }
            }
            _ => {}
        }
    }

    fn request_credentials(
        &mut self,
        round_pubkey: &str,
        points: &[String],
        clock: Clock,
    ) -> Result<(), String> {
        let plan = plan_credentials(
            &self.c.contribution,
            &self.c.participants,
            &self.c.me,
            round_pubkey,
            points,
            self.c.feerate,
        )?;
        self.c
            .out
            .status("Requesting blind credentials from coordinator…");
        let coordinator = self.c.coordinator.clone();
        let body = Body::CredentialRequest {
            requests: plan.requests.clone(),
            amount_commitments: plan.amount_commitments.clone(),
            component_commitments: plan.component_commitments.clone(),
            pedersen_total_nonce: plan.pedersen_total_nonce.clone(),
            excess_fee: plan.excess_fee,
            input_count: self.c.contribution.inputs.len() as u32,
            output_count: self.c.contribution.outputs.len() as u32,
        };
        self.c.send(&coordinator, body, clock);
        self.plan = Some(plan);
        self.response_wait = Some(Timer::once(clock.ms + CREDENTIAL_WAIT_MS));
        Ok(())
    }

    /// Unblind the credentials, then queue inputs, the onion and readiness.
    fn register(&mut self, responses: &HashMap<u32, String>, clock: Clock) -> Result<(), String> {
        let plan = self.plan.as_ref().expect("checked by caller");
        let credentials = plan
            .requests
            .iter()
            .zip(&plan.pending)
            .map(|(request, pending)| {
                let s = responses.get(&request.index).ok_or_else(|| {
                    format!("missing credential response for slot {}", request.index)
                })?;
                pending.finalize(s)
            })
            .collect::<Result<Vec<String>, String>>()?;
        let inputs = self.c.contribution.inputs.clone();
        let outputs: Vec<AuthorizedOutput> = self
            .c
            .contribution
            .outputs
            .iter()
            .enumerate()
            .map(|(i, output)| AuthorizedOutput {
                script: output.script.clone(),
                value: output.value,
                credential_serial: plan.output_serials[i].clone(),
                credential_sig: credentials[inputs.len() + i].clone(),
                salt_commitment: plan.output_salt_commitments[i].clone(),
            })
            .collect();
        let salts = plan.input_salt_commitments.clone();
        self.c
            .out
            .status(format!("Registering {} input(s)…", inputs.len()));
        let coordinator = self.c.coordinator.clone();
        let mut at = clock.ms;
        for (i, input) in inputs.iter().enumerate() {
            self.c.schedule(
                at,
                Item::Send {
                    to: coordinator.clone(),
                    body: Body::Inputs {
                        inputs: vec![input.clone()],
                        credential_sigs: vec![credentials[i].clone()],
                        salt_commitments: vec![salts[i].clone()],
                    },
                },
            );
            at += self.c.jitter();
        }
        self.injects = self.c.onion_payloads(&outputs)?;
        let me = self.c.me.clone();
        self.declared.insert(me.clone(), outputs.len() as u32);
        for peeler in self.c.mix_order.clone().iter().filter(|key| **key != me) {
            self.c.schedule(
                at,
                Item::Send {
                    to: peeler.clone(),
                    body: Body::OnionDeclare {
                        output_count: outputs.len() as u32,
                    },
                },
            );
        }
        self.c.schedule(at, Item::ArmDeclareResend);
        let first = self.c.mix_order[0].clone();
        if first == me {
            self.c
                .schedule(at, Item::FeedOwnOnions(self.injects.clone()));
        } else {
            for onion in self.injects.clone() {
                self.c.schedule(
                    at,
                    Item::Send {
                        to: first.clone(),
                        body: Body::OnionOutput {
                            onion,
                            mix_order: self.c.mix_order.clone(),
                        },
                    },
                );
                at += self.c.jitter();
            }
            self.c.schedule(at, Item::ArmInjectResend);
        }
        self.c.schedule(at, Item::ComponentsReady);
        self.c.out.phase(3);
        self.run_queue(clock);
        Ok(())
    }

    fn send_signatures(&mut self, clock: Clock) {
        let coordinator = self.c.coordinator.clone();
        let sigs = self.signatures.clone();
        self.c.send(&coordinator, Body::Signature { sigs }, clock);
    }

    fn take_onion(&mut self, onion: String, clock: Clock) {
        if self.c.outcome.is_some() || self.batch_done || !self.seen_payloads.insert(onion.clone())
        {
            return;
        }
        self.collected.push(onion);
        self.process_onions(clock);
    }

    /// The hop total: every participant's declared count, once all have
    /// declared a legal one.
    fn expected_onions(&self) -> Option<usize> {
        if self.declared.len() < self.c.participants.len() {
            return None;
        }
        self.c.participants.iter().try_fold(0usize, |sum, peer| {
            let count = *self.declared.get(peer)? as usize;
            (1..=MAX_OUTPUT_CREDENTIALS_PER_PEER)
                .contains(&count)
                .then_some(sum + count)
        })
    }

    /// Peel this hop's batch once it is complete, shuffle, and pass it on —
    /// or, as the last peeler, reveal the outputs to the coordinator.
    fn process_onions(&mut self, clock: Clock) {
        if self.c.outcome.is_some() || self.batch_done {
            return;
        }
        let Some(my_index) = self.my_index else {
            return;
        };
        let Some(expected) = self.expected_onions() else {
            return;
        };
        if self.collected.len() < expected {
            return;
        }
        let batch: Vec<String> = self.collected.drain(..expected).collect();
        let mut peeled: Vec<Vec<u8>> = batch
            .iter()
            .filter_map(|blob| onion::from_base64(blob).ok())
            .filter_map(|blob| onion::peel(&blob, &self.c.secret).ok())
            .collect();
        if peeled.len() != batch.len() {
            let error = format!(
                "onion peel incomplete ({}/{} layers)",
                peeled.len(),
                batch.len()
            );
            self.fail(error, true, clock);
            return;
        }
        secure_shuffle(&mut peeled);
        let coordinator = self.c.coordinator.clone();
        if my_index + 1 >= self.c.mix_order.len() {
            let outputs = peeled
                .iter()
                .map(|inner| onion::decode_authorized_output(&onion::unpad(inner)))
                .collect::<Result<Vec<_>, String>>();
            match outputs {
                Ok(outputs) if !outputs.is_empty() => {
                    self.c.send(&coordinator, Body::Outputs { outputs }, clock);
                    self.c
                        .out
                        .status("Onion peel done — revealed outputs to coordinator…");
                }
                Ok(_) => {
                    self.fail("onion peel produced no valid outputs".into(), true, clock);
                    return;
                }
                Err(error) => {
                    self.fail(error, true, clock);
                    return;
                }
            }
        } else {
            let next = self.c.mix_order[my_index + 1].clone();
            let payloads: Vec<String> =
                peeled.iter().map(|inner| onion::to_base64(inner)).collect();
            self.forward(&next, &payloads, clock);
            self.forwarded = Some((next, payloads));
            // A relay ACK proves storage, not delivery; retry the shuffled
            // batch a bounded number of times.
            self.forward_resend = Some(Timer::repeat(
                clock,
                ONION_OUTPUT_RESEND_MS,
                Some(ONION_OUTPUT_RESEND_MAX),
            ));
            self.c.out.status(format!(
                "Onion peel hop {} done — forwarded to next peeler…",
                my_index + 1
            ));
        }
        self.batch_done = true;
        self.declare_resend = None;
        self.inject_resend = None;
    }

    fn forward(&mut self, next: &str, payloads: &[String], clock: Clock) {
        for onion in payloads {
            let body = Body::OnionOutput {
                onion: onion.clone(),
                mix_order: self.c.mix_order.clone(),
            };
            self.c.send(next, body, clock);
        }
    }

    fn run_queue(&mut self, clock: Clock) {
        for item in self.c.due_items(clock.ms) {
            if self.c.outcome.is_some() {
                return;
            }
            match item {
                Item::Send { to, body } => self.c.send(&to, body, clock),
                Item::FeedOwnOnions(onions) => {
                    for onion in onions {
                        self.take_onion(onion, clock);
                    }
                }
                Item::ArmDeclareResend => {
                    self.declare_resend = (!self.batch_done).then(|| {
                        Timer::repeat(
                            clock,
                            ONION_DECLARE_RESEND_MS,
                            Some(ONION_DECLARE_RESEND_MAX),
                        )
                    });
                }
                Item::ArmInjectResend => {
                    self.inject_resend = (!self.batch_done && !self.signed).then(|| {
                        Timer::repeat(clock, ONION_OUTPUT_RESEND_MS, Some(ONION_OUTPUT_RESEND_MAX))
                    });
                }
                Item::ComponentsReady => {
                    let coordinator = self.c.coordinator.clone();
                    self.c.send(&coordinator, Body::ComponentsReady {}, clock);
                }
                Item::MarkSelfReady => {}
            }
        }
    }

    fn tick(&mut self, clock: Clock) {
        if self.c.outcome.is_some() {
            return;
        }
        self.run_queue(clock);
        let now = clock.ms;
        if Timer::fire(&mut self.c.round_timer, now) {
            self.fail(
                "fusion round timed out (after assemble/sign this usually means signatures or final gift-wrap never arrived over Tor)".into(),
                true,
                clock,
            );
            return;
        }
        if Timer::fire(&mut self.params_wait, now) {
            self.fail(
                format!(
                    "Timed out waiting for coordinator credentials (after {}s). Coordinator credential_params may have been dropped on Tor.",
                    CREDENTIAL_WAIT_MS / 1_000
                ),
                true,
                clock,
            );
            return;
        }
        if Timer::fire(&mut self.response_wait, now) {
            self.fail(
                format!(
                    "Timed out waiting for credential response (after {}s). Coordinator may not have received our credential_request over Tor.",
                    CREDENTIAL_WAIT_MS / 1_000
                ),
                true,
                clock,
            );
            return;
        }
        if Timer::fire(&mut self.declare_resend, now) && !self.batch_done {
            let me = self.c.me.clone();
            let count = self.c.contribution.outputs.len() as u32;
            for peeler in self.c.mix_order.clone().iter().filter(|key| **key != me) {
                self.c.send(
                    peeler,
                    Body::OnionDeclare {
                        output_count: count,
                    },
                    clock,
                );
            }
        }
        if Timer::fire(&mut self.inject_resend, now) && !self.batch_done && !self.signed {
            let first = self.c.mix_order[0].clone();
            for onion in self.injects.clone() {
                let body = Body::OnionOutput {
                    onion,
                    mix_order: self.c.mix_order.clone(),
                };
                self.c.send(&first, body, clock);
            }
        }
        if Timer::fire(&mut self.forward_resend, now) && !self.signed {
            if let Some((next, payloads)) = self.forwarded.clone() {
                self.forward(&next, &payloads, clock);
            }
        }
        if Timer::fire(&mut self.sig_resend, now) {
            self.send_signatures(clock);
        }
    }
}

// ── Coordinator ────────────────────────────────────────────────────────────

impl Coordinator {
    fn start(c: Common, clock: Clock) -> Result<Self, String> {
        if c.mix_order.len() < 2 {
            return Err("onion mix-net requires ≥2 peelers (need ≥3 participants)".into());
        }
        let mut issuer = Issuer::create(total_slots(c.participants.len()))?;
        // The coordinator issues its own credentials through the same path.
        let plan = plan_credentials(
            &c.contribution,
            &c.participants,
            &c.me,
            &issuer.pubkey_hex,
            &issuer.r_points_hex,
            c.feerate,
        )?;
        let credentials = plan
            .requests
            .iter()
            .zip(&plan.pending)
            .map(|(request, pending)| pending.finalize(&issuer.sign(request.index, &request.e)?))
            .collect::<Result<Vec<String>, String>>()?;
        if !super::credentials::pedersen_balance_holds(
            &plan.amount_commitments,
            plan.excess_fee,
            &plan.pedersen_total_nonce,
        ) {
            return Err("coordinator pedersen self-check failed".into());
        }
        let inputs = c.contribution.inputs.len();
        let own_outputs: Vec<AuthorizedOutput> = c
            .contribution
            .outputs
            .iter()
            .enumerate()
            .map(|(i, output)| AuthorizedOutput {
                script: output.script.clone(),
                value: output.value,
                credential_serial: plan.output_serials[i].clone(),
                credential_sig: credentials[inputs + i].clone(),
                salt_commitment: plan.output_salt_commitments[i].clone(),
            })
            .collect();
        let others: Vec<String> = c
            .participants
            .iter()
            .filter(|key| **key != c.me)
            .cloned()
            .collect();
        let me = c.me.clone();
        let mut coordinator = Self {
            credentialed_inputs: c.contribution.inputs.iter().map(InputRef::key).collect(),
            credentialed_peers: HashSet::from([me.clone()]),
            input_quota: HashMap::from([(me.clone(), inputs as u32)]),
            output_quota: HashMap::from([(me, c.contribution.outputs.len() as u32)]),
            own_injects: Vec::new(),
            others,
            issuer,
            own_outputs,
            anonymous_inputs: Vec::new(),
            ready: HashSet::new(),
            output_batches: Vec::new(),
            nullifiers: HashSet::new(),
            signatures: HashMap::new(),
            assembled: None,
            finalized: None,
            broadcast_started: false,
            params_resend: Some(Timer::repeat(
                clock,
                CREDENTIAL_PARAMS_RESEND_MS,
                Some(CREDENTIAL_PARAMS_RESEND_MAX),
            )),
            declare_resend: Some(Timer::repeat(
                clock,
                ONION_DECLARE_RESEND_MS,
                Some(ONION_DECLARE_RESEND_MAX),
            )),
            inject_resend: None,
            assembled_resend: None,
            missing_outputs: None,
            c,
        };
        coordinator.c.out.phase(2);
        coordinator.c.out.status(format!(
            "Coordinator: publishing credentials to {} peer(s)…",
            coordinator.others.len()
        ));
        coordinator.send_params(false, clock);
        coordinator.send_declare(clock);
        coordinator.own_injects = coordinator.c.onion_payloads(&coordinator.own_outputs)?;
        let first = coordinator.c.mix_order[0].clone();
        let mut at = clock.ms;
        for onion in coordinator.own_injects.clone() {
            let body = Body::OnionOutput {
                onion,
                mix_order: coordinator.c.mix_order.clone(),
            };
            coordinator.c.schedule(
                at,
                Item::Send {
                    to: first.clone(),
                    body,
                },
            );
            at += coordinator.c.jitter();
        }
        coordinator.c.schedule(at, Item::ArmInjectResend);
        coordinator.c.schedule(at, Item::MarkSelfReady);
        coordinator.run_queue(clock);
        Ok(coordinator)
    }

    /// Publish the issuer parameters, to everyone or only to peers that have
    /// not asked for credentials yet: Tor often drops the first delivery.
    fn send_params(&mut self, only_pending: bool, clock: Clock) {
        let targets: Vec<String> = self
            .others
            .iter()
            .filter(|peer| !only_pending || !self.credentialed_peers.contains(*peer))
            .cloned()
            .collect();
        for peer in targets {
            let body = Body::CredentialParams {
                round_pubkey: self.issuer.pubkey_hex.clone(),
                blind_nonce_points: self.issuer.r_points_hex.clone(),
            };
            self.c.send(&peer, body, clock);
        }
    }

    fn send_declare(&mut self, clock: Clock) {
        let count = self.own_outputs.len() as u32;
        for peeler in self.c.mix_order.clone() {
            self.c.send(
                &peeler,
                Body::OnionDeclare {
                    output_count: count,
                },
                clock,
            );
        }
    }

    fn fail(&mut self, error: String, notify: bool, force: bool, clock: Clock) {
        if self.c.outcome.is_some() || (self.broadcast_started && !force) {
            return;
        }
        self.c.out.status(format!("Round failed: {error}"));
        if notify {
            let reason: String = error
                .chars()
                .take(super::wire::MAX_ABORT_REASON_CHARS)
                .collect();
            for peer in self.others.clone() {
                self.c.send(
                    &peer,
                    Body::Abort {
                        reason: reason.clone(),
                    },
                    clock,
                );
            }
        }
        self.c.outcome = Some(Err(error));
        self.c.queue.clear();
    }

    /// A provable fault: send the verifiable report, then abort. Never for
    /// timeouts or missing messages.
    fn blame_and_fail(&mut self, accused: &str, evidence: BlameEvidence, clock: Clock) {
        if self.c.outcome.is_some() {
            return;
        }
        let code = evidence.code();
        let report = BlameReport {
            session: self.c.session.clone(),
            accused: accused.to_owned(),
            code,
            evidence,
        };
        let check = verify_blame(
            &report,
            &VerifyContext {
                session: &self.c.session,
                participants: &self.c.participants,
                feerate: Some(self.c.feerate),
            },
        );
        if let Err(reason) = check {
            self.fail(
                format!("internal blame failed verification: {reason}"),
                true,
                false,
                clock,
            );
            return;
        }
        let reason = abort_reason(code);
        self.c.out.status(reason.clone());
        for peer in self.others.clone() {
            let body = Body::Blame {
                accused: report.accused.clone(),
                code,
                evidence: Box::new(report.evidence.clone()),
            };
            self.c.send(&peer, body, clock);
        }
        for peer in self.others.clone() {
            self.c.send(
                &peer,
                Body::Abort {
                    reason: reason.clone(),
                },
                clock,
            );
        }
        self.c.out.actions.push(Action::Blame(report));
        self.c.outcome = Some(Err(reason));
        self.c.queue.clear();
    }

    fn expected_inputs(&self) -> usize {
        self.input_quota.values().map(|&count| count as usize).sum()
    }

    fn input_pool(&self) -> Vec<InputRef> {
        self.c
            .contribution
            .inputs
            .iter()
            .chain(&self.anonymous_inputs)
            .cloned()
            .collect()
    }

    fn output_pool(&self) -> Vec<OutputRef> {
        self.output_batches
            .iter()
            .flatten()
            .map(AuthorizedOutput::output)
            .collect()
    }

    fn on_message(&mut self, from: &str, message: &RoundMessage, clock: Clock) {
        if !self.c.admit(message) {
            return;
        }
        let from_peer = self.others.iter().any(|key| key == from);
        match &message.body {
            Body::CredentialRequest { .. } if from_peer => {
                if let Err(error) = self.handle_credential_request(from, &message.body, clock) {
                    self.fail(error, true, false, clock);
                }
            }
            Body::ComponentsReady {} if from_peer => {
                self.ready.insert(from.to_owned());
                if self.ready.len() == self.c.participants.len() {
                    self.arm_missing_outputs(clock);
                }
                self.try_assemble(clock);
            }
            Body::Abort { reason } if from_peer => {
                self.fail(
                    format!("fusion round aborted: {reason}"),
                    true,
                    false,
                    clock,
                );
            }
            Body::Blame { .. } => {
                if let Some(report) = self.c.verified_blame(from, message) {
                    let reason = abort_reason(report.code);
                    self.c.out.actions.push(Action::Blame(report));
                    self.fail(reason, false, false, clock);
                }
            }
            // No sender check: inputs come under a throwaway key, and the
            // blind credential is the admission proof.
            Body::Inputs {
                inputs,
                credential_sigs,
                salt_commitments,
            } => match self.accept_inputs(inputs, credential_sigs, salt_commitments) {
                Ok(()) => self.try_assemble(clock),
                Err(error) => self.fail(error, true, false, clock),
            },
            Body::Outputs { outputs } if self.assembled.is_none() => {
                let expected: usize = self
                    .output_quota
                    .values()
                    .map(|&count| count as usize)
                    .sum();
                if self.c.participants.iter().any(|key| key == from)
                    || self.output_quota.len() != self.c.participants.len()
                    || !self.output_batches.is_empty()
                    || outputs.len() != expected
                {
                    self.fail(
                        "unauthorized output batch count or sender".into(),
                        true,
                        false,
                        clock,
                    );
                    return;
                }
                match verify_output_batch(outputs, expected, &self.issuer.pubkey_hex) {
                    Err(reason) => self.fail(reason, true, false, clock),
                    Ok(serials) => {
                        // Atomic: a replayed serial rejects the whole batch.
                        if serials
                            .iter()
                            .any(|serial| self.nullifiers.contains(serial))
                        {
                            self.fail(
                                "replayed output credential nullifier".into(),
                                true,
                                false,
                                clock,
                            );
                            return;
                        }
                        self.nullifiers.extend(serials);
                        self.output_batches.push(outputs.clone());
                        self.try_assemble(clock);
                    }
                }
            }
            // Signatures are anonymous too: each is checked against an
            // assembled input, never against "this peer's set".
            Body::Signature { sigs } => {
                let Some(assembled) = &self.assembled else {
                    return;
                };
                let wanted: HashSet<String> = assembled.inputs.iter().map(InputRef::key).collect();
                let received: HashSet<String> = sigs.iter().map(InputSig::key).collect();
                if received.len() != sigs.len() || !received.is_subset(&wanted) {
                    return;
                }
                for sig in sigs {
                    self.signatures.insert(sig.key(), sig.clone());
                }
                self.try_finalize(clock);
            }
            _ => {}
        }
    }

    fn handle_credential_request(
        &mut self,
        from: &str,
        body: &Body,
        clock: Clock,
    ) -> Result<(), String> {
        let Body::CredentialRequest {
            requests,
            amount_commitments,
            component_commitments,
            pedersen_total_nonce,
            excess_fee,
            input_count,
            output_count,
        } = body
        else {
            return Ok(());
        };
        if self.credentialed_peers.contains(from) {
            return Err(format!("duplicate credential request from {from}"));
        }
        if requests.len() != (*input_count + *output_count) as usize
            || amount_commitments.len() != requests.len()
            || component_commitments.len() != requests.len()
        {
            return Err("credential component counts do not match commitments".into());
        }
        if !super::credentials::pedersen_balance_holds(
            amount_commitments,
            *excess_fee,
            pedersen_total_nonce,
        ) {
            self.blame_and_fail(
                from,
                BlameEvidence::PedersenUnbalanced {
                    amount_commitments: amount_commitments.clone(),
                    pedersen_total_nonce: pedersen_total_nonce.clone(),
                    excess_fee: *excess_fee,
                },
                clock,
            );
            return Ok(());
        }
        let base =
            peer_slot_base(&self.c.participants, from).ok_or("peer not in participant set")?;
        let slots: Vec<u64> = requests
            .iter()
            .map(|request| u64::from(request.index))
            .collect();
        if requests.iter().any(|request| {
            (request.index as usize) < base
                || request.index as usize >= base + CREDENTIAL_SLOTS_PER_PEER
        }) {
            self.blame_and_fail(
                from,
                BlameEvidence::CredentialSlotOob {
                    slots,
                    participants: self.c.participants.clone(),
                },
                clock,
            );
            return Ok(());
        }
        let responses = requests
            .iter()
            .map(|request| {
                Ok(super::wire::SlotResponse {
                    index: request.index,
                    s: self.issuer.sign(request.index, &request.e)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        self.credentialed_peers.insert(from.to_owned());
        self.input_quota.insert(from.to_owned(), *input_count);
        self.output_quota.insert(from.to_owned(), *output_count);
        self.c
            .send(from, Body::CredentialResponse { responses }, clock);
        Ok(())
    }

    /// Accept credentialed inputs without knowing who sent them
    /// (`acceptInputs`).
    fn accept_inputs(
        &mut self,
        inputs: &[InputRef],
        sigs: &[String],
        salts: &[String],
    ) -> Result<(), String> {
        if inputs.len() != sigs.len() || inputs.len() != salts.len() {
            return Err("input/credential/salt count mismatch".into());
        }
        if self.input_pool().len() + inputs.len() > self.expected_inputs() {
            return Err("input credential quota exceeded".into());
        }
        for ((input, sig), salt) in inputs.iter().zip(sigs).zip(salts) {
            let message = input_credential_hash(input, salt)
                .map_err(|_| "invalid input credential".to_string())?;
            if !verify_schnorr_hex(&self.issuer.pubkey_hex, sig, &message) {
                return Err("invalid input credential".into());
            }
        }
        for input in inputs {
            if !self.credentialed_inputs.insert(input.key()) {
                return Err("duplicate outpoint in round".into());
            }
        }
        self.anonymous_inputs.extend(inputs.iter().cloned());
        Ok(())
    }

    /// Wait for a balanced pool, not just any output: partial or duplicate
    /// peels used to pass and then fail assembly (`outputsReady`).
    fn outputs_ready(&self) -> bool {
        let pool = self.output_pool();
        let inputs = self.input_pool();
        if pool.is_empty() || inputs.is_empty() || inputs.len() != self.expected_inputs() {
            return false;
        }
        let total_in: u64 = inputs.iter().map(|input| input.value).sum();
        let total_out: u64 = pool.iter().map(|output| output.value).sum();
        let Some(fee) = total_in.checked_sub(total_out) else {
            return false;
        };
        let rough = fee_for_bytes(
            10 + inputs.len() as u64 * 150 + pool.len() as u64 * 40,
            self.c.feerate,
        ) * 3;
        fee <= rough.max(50_000)
    }

    fn arm_missing_outputs(&mut self, clock: Clock) {
        if self.missing_outputs.is_none() && self.c.outcome.is_none() && self.assembled.is_none() {
            self.missing_outputs = Some(Timer::once(
                clock.ms + missing_outputs_wait_ms(self.c.mix_order.len()),
            ));
        }
    }

    fn try_assemble(&mut self, clock: Clock) {
        if self.c.outcome.is_some()
            || self.assembled.is_some()
            || self.ready.len() != self.c.participants.len()
        {
            return;
        }
        if !self.outputs_ready() {
            self.arm_missing_outputs(clock);
            return;
        }
        let inputs = self.input_pool();
        if self.input_quota.len() != self.c.participants.len()
            || inputs.len() != self.expected_inputs()
            || inputs
                .iter()
                .any(|input| !self.credentialed_inputs.contains(&input.key()))
        {
            return;
        }
        let outputs = self.output_pool();
        let draft = match assemble([(&inputs[..], &outputs[..])]) {
            Ok(draft) => draft,
            Err(error) => {
                self.fail(error, true, false, clock);
                return;
            }
        };
        let fee = i128::from(draft.total_in()) - i128::from(draft.total_out());
        let required = draft.minimum_fee(self.c.feerate);
        if fee < 0 || fee > i128::from(required * 3) {
            self.fail(
                format!(
                    "refusing to assemble: fee {fee} outside [0, {}] (in={} out={}). Incomplete output pool or mis-planned values.",
                    required * 3,
                    draft.total_in(),
                    draft.total_out()
                ),
                true,
                false,
                clock,
            );
            return;
        }
        self.missing_outputs = None;
        self.c.out.phase(5);
        self.c
            .out
            .status("Assembling CoinJoin — signing our inputs…");
        let (tx, own) = match self.c.assemble_verify_sign(&draft.inputs, &draft.outputs) {
            Ok(signed) => signed,
            Err(error) => {
                self.fail(error, true, false, clock);
                return;
            }
        };
        self.c.out.phase(6);
        for sig in own {
            self.signatures.insert(sig.key(), sig);
        }
        self.assembled = Some(tx);
        self.send_assembled(clock);
        self.assembled_resend = Some(Timer::repeat(clock, ASSEMBLED_RESEND_MS, None));
        self.c.out.status(format!(
            "Published assembled tx — waiting for {} signature set(s)…",
            self.others.len()
        ));
        self.try_finalize(clock);
    }

    fn send_assembled(&mut self, clock: Clock) {
        let Some(assembled) = self.assembled.clone() else {
            return;
        };
        for peer in self.others.clone() {
            let body = Body::Assembled {
                inputs: assembled.inputs.clone(),
                outputs: assembled.outputs.clone(),
            };
            self.c.send(&peer, body, clock);
        }
    }

    /// Every assembled input signed: verify it all, then broadcast
    /// (`tryFinalize`).
    fn try_finalize(&mut self, clock: Clock) {
        let Some(assembled) = self.assembled.clone() else {
            return;
        };
        if self.c.outcome.is_some()
            || self.finalized.is_some()
            || self.signatures.len() != assembled.inputs.len()
        {
            return;
        }
        self.assembled_resend = None;
        self.c
            .out
            .status("All signatures in — finalizing and broadcasting…");
        let sigs: Vec<InputSig> = self.signatures.values().cloned().collect();
        // Execute every collected signature against the approved template
        // before any network sees the transaction.
        let checked = finalize(&assembled, &sigs).and_then(|(tx_hex, txid)| {
            verify_final(&assembled, &tx_hex, &txid).map(|_| (tx_hex, txid))
        });
        match checked {
            Ok((tx_hex, txid)) => {
                self.finalized = Some((tx_hex.clone(), txid.clone()));
                self.broadcast_started = true;
                self.c.out.phase(7);
                self.c.out.actions.push(Action::Broadcast { tx_hex, txid });
            }
            Err(error) => self.fail(error, true, true, clock),
        }
    }

    fn on_broadcast(&mut self, result: Result<String, String>, clock: Clock) {
        let Some((tx_hex, txid)) = self.finalized.clone() else {
            return;
        };
        if self.c.outcome.is_some() {
            return;
        }
        match result {
            Ok(id) if id.to_ascii_lowercase() == txid => {
                for peer in self.others.clone() {
                    let body = Body::Final {
                        txid: txid.clone(),
                        tx_hex: tx_hex.clone(),
                    };
                    self.c.send(&peer, body, clock);
                }
                self.c.out.status(format!(
                    "Fused ✓ — txid {}… (confirming on wallet)",
                    &txid[..16]
                ));
                self.c.outcome = Some(Ok(RoundResult { txid, tx_hex }));
                self.c.queue.clear();
            }
            Ok(_) => self.fail(
                "broadcast returned a different transaction id".into(),
                true,
                true,
                clock,
            ),
            Err(error) => self.fail(error, true, true, clock),
        }
    }

    fn run_queue(&mut self, clock: Clock) {
        for item in self.c.due_items(clock.ms) {
            if self.c.outcome.is_some() {
                return;
            }
            match item {
                Item::Send { to, body } => self.c.send(&to, body, clock),
                Item::ArmInjectResend => {
                    self.inject_resend = self.assembled.is_none().then(|| {
                        Timer::repeat(clock, ONION_OUTPUT_RESEND_MS, Some(ONION_OUTPUT_RESEND_MAX))
                    });
                }
                Item::MarkSelfReady => {
                    let me = self.c.me.clone();
                    self.ready.insert(me);
                    if self.ready.len() == self.c.participants.len() {
                        self.arm_missing_outputs(clock);
                    }
                    self.try_assemble(clock);
                }
                Item::FeedOwnOnions(_) | Item::ArmDeclareResend | Item::ComponentsReady => {}
            }
        }
    }

    fn tick(&mut self, clock: Clock) {
        if self.c.outcome.is_some() {
            return;
        }
        self.run_queue(clock);
        let now = clock.ms;
        if Timer::fire(&mut self.c.round_timer, now) {
            let reason = format!(
                "fusion round timed out (coord: inputs signed {}/{}, assembled={}). Usually missing peer signatures or final over Tor.",
                self.signatures.len(),
                self.assembled.as_ref().map_or(0, |tx| tx.inputs.len()),
                self.assembled.is_some()
            );
            self.fail(reason, true, false, clock);
            return;
        }
        if Timer::fire(&mut self.missing_outputs, now)
            && self.assembled.is_none()
            && self.ready.len() == self.c.participants.len()
            && !self.outputs_ready()
        {
            let reason = format!(
                "All {} peers marked ready but outputs never arrived (batches={}, peelers={}). Onion peel stalled over Tor.",
                self.c.participants.len(),
                self.output_batches.len(),
                self.c.mix_order.len()
            );
            self.fail(reason, true, false, clock);
            return;
        }
        if Timer::fire(&mut self.params_resend, now) {
            if self
                .others
                .iter()
                .all(|peer| self.credentialed_peers.contains(peer))
            {
                self.params_resend = None;
            } else {
                self.send_params(true, clock);
            }
        }
        if Timer::fire(&mut self.declare_resend, now) && self.assembled.is_none() {
            self.send_declare(clock);
        }
        if Timer::fire(&mut self.inject_resend, now) && self.assembled.is_none() {
            let first = self.c.mix_order[0].clone();
            for onion in self.own_injects.clone() {
                let body = Body::OnionOutput {
                    onion,
                    mix_order: self.c.mix_order.clone(),
                };
                self.c.send(&first, body, clock);
            }
        }
        if Timer::fire(&mut self.assembled_resend, now) && self.finalized.is_none() {
            self.send_assembled(clock);
        }
    }
}
