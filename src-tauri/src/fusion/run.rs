// CashFusion round — Phase 1.7: the run_fusion orchestration engine.
//
// Ties every primitive (1.1–1.6) into the real round sequence against a live
// fusion server, following Electron Cash run_round:
//   hello -> join -> wait FusionBegin -> StartRound -> PlayerCommit ->
//   BlindSigResponses -> finalize sigs -> covert-submit components ->
//   AllCommitments -> ShareCovertComponents -> verify session_hash ->
//   build tx + sign our inputs -> covert-submit signatures -> FusionResult ->
//   assemble the fully-signed tx.
//
// !! NOT UNIT-TESTABLE !! A fusion round is multi-party (needs >=2 players in the
// same tier) and timing-sensitive (covert windows), so correctness can only be
// confirmed against a live server with another participant. Treat this as a
// first cut pending that live validation — the covert timing in particular
// (connection warmup, submit windows) will likely need tuning against a real
// server. Every wire-level piece it CALLS is already tested (1.1–1.6).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use prost::Message;
use tokio::io::{AsyncRead, AsyncWrite};

use super::blame;
use super::components::{build_round_commit, FusionInput, FusionOutput, RoundCommit};
use super::covert::{build_covert_signature, CovertPool, CovertSchedule};
use super::electrum_input::{self, ElectrumEndpoint, InputLookup};
use super::round_cancel::CancelFlag;
use super::schnorr;
use super::server_plan::{
    validate_and_index_plans, validate_hello_match, validate_server_hello, ExpectedHello,
    FusionTierPlan,
};
use super::session::{build_covert_component, calc_initial_hash, calc_round_hash};
use super::tx::FusionTx;
use super::{connect_stream, pb, recv_frame, send_frame, Transport, VERSION};

// Timing relative to covert_T0 (StartRound receipt), from protocol.py.
const T_START_COMPS: Duration = Duration::from_secs(5);
const T_START_SIGS: Duration = Duration::from_secs(20);
const T_END_COMPS: Duration = Duration::from_secs(15);
const T_END_SIGS: Duration = Duration::from_secs(30);
const T_EXPECTING_CONCLUSION: Duration = Duration::from_secs(35);
const COVERT_CONNECT_WINDOW: Duration = Duration::from_secs(15);
const COVERT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const COVERT_SUBMIT_WINDOW: Duration = Duration::from_secs(5);
const COVERT_SUBMIT_TIMEOUT: Duration = Duration::from_secs(3);
const COVERT_CONNECT_SPARES: usize = 6;
/// How long to wait in the pool for a tier to reach its start threshold.
const JOIN_WAIT: Duration = Duration::from_secs(120);
const BLAME_PROOFS_WAIT: Duration = Duration::from_secs(6);
const BLAME_RESTART_WAIT: Duration = Duration::from_secs(16);
const RESTARTED_ROUND_WAIT: Duration = Duration::from_secs(15);

/// One input the wallet contributes, with the key needed to sign it.
pub struct FusionInputKey {
    pub prev_txid: String, // display hex (big-endian)
    pub prev_index: u32,
    pub pubkey: Vec<u8>, // compressed
    pub value: u64,
    pub privkey: [u8; 32],
}

pub struct FusionRunParams<'a> {
    pub host: &'a str,
    pub port: u16,
    pub use_ssl: bool,
    pub tier_plans: Vec<FusionTierPlan>,
    pub inputs: Vec<FusionInputKey>,
    /// Persisted fresh P2PKH scripts sized for the largest feasible tier plan.
    pub output_scripts: Vec<Vec<u8>>,
    /// Transport for BOTH the main and covert connections. Must be Tor for a
    /// remote server (covert unlinkability depends on it).
    pub transport: Transport<'a>,
    /// Wallet-configured Electrum endpoint used only to validate peer inputs
    /// during blame. It is never supplied by the Fusion server.
    pub lookup_endpoint: ElectrumEndpoint,
    /// Independent privacy policy for the lookup endpoint. Remote lookups must
    /// use Tor even when the Fusion server itself is local.
    pub lookup_transport: Transport<'a>,
    /// When to submit components / signatures, relative to StartRound receipt.
    /// Defaults (via `FusionTiming::default`) match protocol.py (+5s / +20s);
    /// the integration test shrinks them so it doesn't wait 20 real seconds.
    pub timing: FusionTiming,
    pub cancel: CancelFlag,
    /// Required snapshot from the renderer's read-only status probe.
    pub expected_hello: ExpectedHello,
}

/// Covert submission timing relative to covert_T0 (StartRound receipt).
#[derive(Clone, Copy)]
pub struct FusionTiming {
    pub warmup_expected: Duration,
    pub warmup_slop: Duration,
    pub connect_window: Duration,
    pub connect_timeout: Duration,
    pub submit_window: Duration,
    pub submit_timeout: Duration,
    pub connect_spares: usize,
    pub comps_at: Duration,
    pub comps_deadline: Duration,
    pub sigs_at: Duration,
    pub sigs_deadline: Duration,
    pub conclusion_at: Duration,
}
impl Default for FusionTiming {
    fn default() -> Self {
        Self {
            warmup_expected: Duration::from_secs(30),
            warmup_slop: Duration::from_secs(3),
            connect_window: COVERT_CONNECT_WINDOW,
            connect_timeout: COVERT_CONNECT_TIMEOUT,
            submit_window: COVERT_SUBMIT_WINDOW,
            submit_timeout: COVERT_SUBMIT_TIMEOUT,
            connect_spares: COVERT_CONNECT_SPARES,
            comps_at: T_START_COMPS,
            comps_deadline: T_END_COMPS,
            sigs_at: T_START_SIGS,
            sigs_deadline: T_END_SIGS,
            conclusion_at: T_EXPECTING_CONCLUSION,
        }
    }
}

#[derive(serde::Serialize)]
pub struct FusionOutcome {
    pub ok: bool,
    /// The round engine only assembles and validates the signed transaction.
    /// It does not independently observe network broadcast or wallet state.
    pub broadcast_verified: bool,
    pub txid: Option<String>,
    pub tx_hex: Option<String>,
    pub message: String,
}

fn scalar_from_privkey(b: &[u8; 32]) -> Result<Scalar, String> {
    Option::<Scalar>::from(Scalar::from_repr((*b).into()))
        .ok_or_else(|| "invalid private key (>= curve order)".into())
}

fn hexify(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn recv_server<S>(stream: &mut S) -> Result<pb::server_message::Msg, String>
where
    S: AsyncRead + Unpin,
{
    let raw = recv_frame(stream).await?;
    pb::ServerMessage::decode(raw.as_slice())
        .map_err(|e| format!("decode server message: {e}"))?
        .msg
        .ok_or_else(|| "empty server message".into())
}

async fn cancellable<T, F>(cancel: &CancelFlag, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("fusion round cancelled".into()),
        result = future => result,
    }
}

async fn recv_server_before<S>(
    stream: &mut S,
    cancel: &CancelFlag,
    deadline: Instant,
    label: &str,
) -> Result<pb::server_message::Msg, String>
where
    S: AsyncRead + Unpin,
{
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(format!("timed out waiting for {label}"));
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("fusion round cancelled".into()),
        result = tokio::time::timeout(remaining, recv_server(stream)) => {
            result
                .map_err(|_| format!("timed out waiting for {label}"))?
        }
    }
}

fn validate_server_time(server_time: u64) -> Result<(), String> {
    let local = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "local system clock is before the Unix epoch")?
        .as_secs();
    if local.abs_diff(server_time) > 5 {
        Err("CashFusion server clock differs by more than 5 seconds".into())
    } else {
        Ok(())
    }
}

fn validate_warmup(
    fusion_begin_at: Instant,
    start_round_at: Instant,
    timing: FusionTiming,
) -> Result<(), String> {
    let elapsed = start_round_at.saturating_duration_since(fusion_begin_at);
    let minimum = timing.warmup_expected.saturating_sub(timing.warmup_slop);
    let maximum = timing.warmup_expected.saturating_add(timing.warmup_slop);
    if elapsed < minimum || elapsed > maximum {
        Err(format!(
            "CashFusion warmup timing is outside the privacy window ({elapsed:?})"
        ))
    } else {
        Ok(())
    }
}

fn display_txid_to_wire(txid: &str) -> Result<[u8; 32], String> {
    if txid.len() != 64 {
        return Err("prev_txid must be 32 bytes".into());
    }

    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let offset = index * 2;
        *byte = u8::from_str_radix(&txid[offset..offset + 2], 16)
            .map_err(|_| "bad prev_txid hex".to_string())?;
    }
    bytes.reverse();
    Ok(bytes)
}

fn input_matches_component(
    input: &FusionInputKey,
    component: &pb::InputComponent,
) -> Result<bool, String> {
    Ok(
        component.prev_txid == display_txid_to_wire(&input.prev_txid)?
            && component.prev_index == input.prev_index
            && component.pubkey == input.pubkey
            && component.amount == input.value,
    )
}

/// Refuse to sign until the transaction assembled from the server's shared
/// components includes every exact input and output this wallet committed to.
/// This is intentionally independent of public-key matching: a matching key on
/// a different outpoint or amount is not our input and must never be signed.
fn verify_shared_transaction(
    all_components: &[Vec<u8>],
    inputs: &[FusionInputKey],
    output_scripts: &[Vec<u8>],
    output_values: &[u64],
) -> Result<(), String> {
    if output_scripts.len() != output_values.len() {
        return Err("output script/value length mismatch".into());
    }

    let mut shared_inputs: Vec<pb::InputComponent> = Vec::new();
    let mut shared_outputs: Vec<pb::OutputComponent> = Vec::new();
    let mut seen_outpoints = HashSet::<([u8; 32], u32)>::new();
    let mut total_input_value = 0u64;
    let mut total_output_value = 0u64;

    for (index, serialized) in all_components.iter().enumerate() {
        let component = pb::Component::decode(serialized.as_slice())
            .map_err(|error| format!("component {index} decode: {error}"))?;
        match component.component {
            Some(pb::component::Component::Input(input)) => {
                let prev_txid: [u8; 32] = input
                    .prev_txid
                    .as_slice()
                    .try_into()
                    .map_err(|_| format!("component {index}: bad prevout length"))?;
                if !seen_outpoints.insert((prev_txid, input.prev_index)) {
                    return Err("shared transaction contains a duplicate input".into());
                }
                total_input_value = total_input_value
                    .checked_add(input.amount)
                    .ok_or("shared transaction input value overflow")?;
                shared_inputs.push(input);
            }
            Some(pb::component::Component::Output(output)) => {
                total_output_value = total_output_value
                    .checked_add(output.amount)
                    .ok_or("shared transaction output value overflow")?;
                shared_outputs.push(output);
            }
            Some(pb::component::Component::Blank(_)) => {}
            None => return Err(format!("component {index}: empty")),
        }
    }

    if total_output_value > total_input_value {
        return Err("shared transaction inflates value".into());
    }

    let mut matched_inputs = vec![false; shared_inputs.len()];
    for input in inputs {
        let mut matched = None;
        for (index, shared) in shared_inputs.iter().enumerate() {
            if !matched_inputs[index] && input_matches_component(input, shared)? {
                matched = Some(index);
                break;
            }
        }
        let Some(index) = matched else {
            return Err("shared transaction omits one of this wallet's inputs".into());
        };
        matched_inputs[index] = true;
    }

    let mut matched_outputs = vec![false; shared_outputs.len()];
    for (script, value) in output_scripts.iter().zip(output_values) {
        let mut matched = None;
        for (index, shared) in shared_outputs.iter().enumerate() {
            if !matched_outputs[index] && shared.scriptpubkey == *script && shared.amount == *value
            {
                matched = Some(index);
                break;
            }
        }
        let Some(index) = matched else {
            return Err("shared transaction omits one of this wallet's outputs".into());
        };
        matched_outputs[index] = true;
    }

    Ok(())
}

/// Return shared-index -> private slot for every item this wallet committed.
/// Duplicate or missing material is rejected before any transaction signature
/// is produced.
fn map_owned_items(
    owned: &[Vec<u8>],
    shared: &[Vec<u8>],
    label: &str,
) -> Result<HashMap<usize, usize>, String> {
    if shared.iter().collect::<HashSet<_>>().len() != shared.len() {
        return Err(format!("shared {label} list contains duplicates"));
    }

    let mut used_shared = HashSet::new();
    let mut mapping = HashMap::with_capacity(owned.len());
    for (slot, item) in owned.iter().enumerate() {
        let shared_index = shared
            .iter()
            .enumerate()
            .find_map(|(index, candidate)| {
                (!used_shared.contains(&index) && candidate == item).then_some(index)
            })
            .ok_or_else(|| format!("server omitted one of this wallet's {label}"))?;
        used_shared.insert(shared_index);
        mapping.insert(shared_index, slot);
    }
    Ok(mapping)
}

fn global_indices_in_local_order(
    mapping: &HashMap<usize, usize>,
    expected_count: usize,
    label: &str,
) -> Result<Vec<usize>, String> {
    if mapping.len() != expected_count {
        return Err(format!("owned {label} mapping count mismatch"));
    }
    let mut ordered = vec![None; expected_count];
    for (&global_index, &local_index) in mapping {
        let slot = ordered
            .get_mut(local_index)
            .ok_or_else(|| format!("owned {label} local index out of range"))?;
        if slot.replace(global_index).is_some() {
            return Err(format!("duplicate owned {label} local index"));
        }
    }
    ordered
        .into_iter()
        .map(|index| index.ok_or_else(|| format!("missing owned {label} mapping")))
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn run_blame_phase<S>(
    main: &mut S,
    cancel: &CancelFlag,
    round_commit: &RoundCommit,
    all_commitments: &[Vec<u8>],
    all_components: &[Vec<u8>],
    my_commitment_indices: &[usize],
    my_component_indices: &[usize],
    bad_components: &[u32],
    component_feerate: u64,
    lookup_endpoint: &ElectrumEndpoint,
    lookup_transport: Transport<'_>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let my_proofs = blame::build_my_proofs_list(
        round_commit,
        all_commitments,
        my_commitment_indices,
        my_component_indices,
    )
    .map_err(|error| format!("could not build blame proofs: {error}"))?;
    let message = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Myproofslist(my_proofs)),
    };
    cancellable(cancel, send_frame(main, &message.encode_to_vec())).await?;

    let their_proofs = match recv_server_before(
        main,
        cancel,
        Instant::now() + BLAME_PROOFS_WAIT,
        "TheirProofsList",
    )
    .await?
    {
        pb::server_message::Msg::Theirproofslist(proofs) => proofs,
        pb::server_message::Msg::Error(error) => {
            return Err(format!(
                "server error during blame proofs: {}",
                error.message.unwrap_or_default()
            ))
        }
        _ => return Err("expected TheirProofsList".into()),
    };

    let mut review = blame::review_relayed_proofs(
        round_commit,
        &their_proofs,
        all_commitments,
        all_components,
        bad_components,
        component_feerate,
    )
    .map_err(|error| format!("could not validate relayed blame proofs: {error}"))?;

    for required in &review.inputs_requiring_blockchain_lookup {
        match electrum_input::verify_input(
            lookup_endpoint,
            lookup_transport,
            &required.input,
        )
        .await
        {
            Ok(InputLookup::Match) => {}
            Ok(InputLookup::Mismatch(reason)) => {
                review.blames.blames.push(
                    required
                        .blockchain_mismatch_blame(reason)
                        .map_err(|error| format!("could not construct input blame: {error}"))?,
                );
            }
            Err(error) => {
                // Infrastructure ambiguity is not evidence against a peer.
                // Abort this attempt without an accusation and rejoin later.
                return Err(format!(
                    "could not independently verify a peer Fusion input: {error}"
                ));
            }
        }
    }

    let blames = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Blames(review.blames)),
    };
    cancellable(cancel, send_frame(main, &blames.encode_to_vec())).await?;

    match recv_server_before(
        main,
        cancel,
        Instant::now() + BLAME_RESTART_WAIT,
        "RestartRound",
    )
    .await?
    {
        pb::server_message::Msg::Restartround(_) => Ok(()),
        pb::server_message::Msg::Error(error) => Err(format!(
            "server rejected blame: {}",
            error.message.unwrap_or_default()
        )),
        _ => Err("expected RestartRound after blame".into()),
    }
}

/// A FusionResult is only usable if every server-relayed signature verifies
/// against the exact shared transaction assembled above. Length checks alone
/// would let a malicious or broken relay produce an unusable transaction while
/// the wallet reported a completed round.
fn verify_transaction_signatures(tx: &FusionTx, signatures: &[Vec<u8>]) -> Result<(), String> {
    if signatures.len() != tx.num_inputs() {
        return Err("server returned wrong number of signatures".into());
    }

    for (index, signature) in signatures.iter().enumerate() {
        let signature: &[u8; 64] = signature
            .as_slice()
            .try_into()
            .map_err(|_| "server relayed a bad-length signature".to_string())?;
        let pubkey = tx
            .input_pubkey(index)
            .ok_or("transaction input is missing a public key")?;
        let sighash = tx.sighash(index)?;
        if !schnorr::verify(pubkey, signature, &sighash) {
            return Err("server relayed an invalid transaction signature".into());
        }
    }

    Ok(())
}

/// Run one full fusion round. Returns the assembled tx (hex + txid) on success;
/// the server also broadcasts it. On a round restart/failure the outcome's `ok`
/// is false with a message.
pub async fn run_fusion(params: FusionRunParams<'_>) -> Result<FusionOutcome, String> {
    let FusionRunParams {
        host,
        port,
        use_ssl,
        tier_plans,
        inputs,
        output_scripts: all_output_scripts,
        transport,
        lookup_endpoint,
        lookup_transport,
        timing,
        cancel,
        expected_hello,
    } = params;
    if inputs.is_empty() {
        return Err("no inputs to fuse".into());
    }
    cancel.check()?;

    // --- Main connection: hello -> join ---
    let mut main = cancellable(&cancel, connect_stream(host, port, use_ssl, transport)).await?;

    let hello = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Clienthello(pb::ClientHello {
            version: VERSION.to_vec(),
            genesis_hash: None,
        })),
    };
    cancellable(&cancel, send_frame(&mut main, &hello.encode_to_vec())).await?;

    let live_hello = match cancellable(&cancel, recv_server(&mut main)).await? {
        pb::server_message::Msg::Serverhello(h) => {
            validate_server_hello(&h)?;
            validate_hello_match(&h, &expected_hello)?;
            h
        }
        pb::server_message::Msg::Error(e) => {
            return Err(format!(
                "server rejected hello: {}",
                e.message.unwrap_or_default()
            ))
        }
        _ => return Err("expected ServerHello".into()),
    };
    let input_pubkeys = inputs
        .iter()
        .map(|input| input.pubkey.clone())
        .collect::<Vec<_>>();
    let input_values = inputs.iter().map(|input| input.value).collect::<Vec<_>>();
    let indexed_plans = validate_and_index_plans(
        &live_hello,
        &input_pubkeys,
        &input_values,
        &all_output_scripts,
        &tier_plans,
    )?;
    let num_components = usize::try_from(live_hello.num_components)
        .map_err(|_| "server component count does not fit this platform")?;
    let feerate = live_hello.component_feerate;
    let registered_tiers = indexed_plans.keys().copied().collect::<Vec<_>>();

    let join = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Joinpools(pb::JoinPools {
            tiers: registered_tiers,
            tags: vec![],
        })),
    };
    cancellable(&cancel, send_frame(&mut main, &join.encode_to_vec())).await?;

    // --- Wait for one of the registered tiers to start (FusionBegin) ---
    let (begin, fusion_begin_at) = {
        let deadline = Instant::now() + JOIN_WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(FusionOutcome {
                    ok: false,
                    broadcast_verified: false,
                    txid: None,
                    tx_hex: None,
                    message: "no other players joined this tier in time".into(),
                });
            }
            let message = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("fusion round cancelled".into()),
                result = tokio::time::timeout(remaining, recv_server(&mut main)) => result,
            };
            match message {
                Err(_) => continue,
                Ok(msg) => match msg? {
                    pb::server_message::Msg::Tierstatusupdate(_) => continue,
                    pb::server_message::Msg::Fusionbegin(b) => {
                        break (b, Instant::now());
                    }
                    pb::server_message::Msg::Error(e) => {
                        return Err(format!(
                            "server error while queued: {}",
                            e.message.unwrap_or_default()
                        ))
                    }
                    _ => continue,
                },
            }
        }
    };

    validate_server_time(begin.server_time)?;
    let selected_plan = indexed_plans
        .get(&begin.tier)
        .cloned()
        .ok_or_else(|| "server began a tier the wallet did not register".to_string())?;
    let output_scripts = all_output_scripts[..selected_plan.output_values.len()].to_vec();
    let output_values = selected_plan.output_values.clone();
    let covert_domain = String::from_utf8(begin.covert_domain.clone())
        .map_err(|_| "server returned a non-ASCII covert domain")?;
    if !covert_domain.is_ascii() || covert_domain.is_empty() {
        return Err("server returned an invalid covert domain".into());
    }
    let covert_port =
        u16::try_from(begin.covert_port).map_err(|_| "server returned an invalid covert port")?;
    if covert_port == 0 {
        return Err("server returned an invalid covert port".into());
    }
    let covert_ssl = begin.covert_ssl.unwrap_or(false);
    let initial_hash = calc_initial_hash(
        begin.tier,
        &begin.covert_domain,
        begin.covert_port,
        covert_ssl,
        begin.server_time,
    );
    let mut last_hash = initial_hash;
    let covert_schedule = CovertSchedule::start(
        &covert_domain,
        covert_port,
        covert_ssl,
        transport,
        num_components,
        timing.connect_spares,
        fusion_begin_at,
        timing.connect_window,
        timing.submit_window,
        timing.connect_timeout,
        &cancel,
    );
    let mut pending_covert_schedule = Some(covert_schedule);
    let mut covert_pool: Option<CovertPool> = None;
    let mut first_round = true;

    loop {
    // --- StartRound (repeated on the same main/covert connections after blame) ---
    let start_deadline = if first_round {
        fusion_begin_at + timing.warmup_expected + timing.warmup_slop + Duration::from_secs(1)
    } else {
        Instant::now() + RESTARTED_ROUND_WAIT
    };
    let start = match tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("fusion round cancelled".into()),
        result = tokio::time::timeout(
            start_deadline.saturating_duration_since(Instant::now()),
            recv_server(&mut main),
        ) => result,
    } {
        Ok(m) => match m? {
            pb::server_message::Msg::Startround(s) => s,
            pb::server_message::Msg::Error(e) => {
                return Err(format!(
                    "server error at start: {}",
                    e.message.unwrap_or_default()
                ))
            }
            _ => return Err("expected StartRound".into()),
        },
        Err(_) => return Err("timed out waiting for StartRound".into()),
    };
    let covert_t0 = Instant::now();
    validate_server_time(start.server_time)?;
    if first_round {
        validate_warmup(fusion_begin_at, covert_t0, timing)?;
        first_round = false;
    }
    let round_pubkey = start.round_pubkey.clone();
    let round_time = start.server_time;

    // Final cancellation point before committing keys and amounts.
    cancel.check()?;

    // --- Build + send PlayerCommit ---
    let fusion_inputs: Vec<FusionInput> = inputs
        .iter()
        .map(|i| FusionInput {
            prev_txid: i.prev_txid.clone(),
            prev_index: i.prev_index,
            pubkey: i.pubkey.clone(),
            value: i.value,
        })
        .collect();
    let fusion_outputs: Vec<FusionOutput> = output_scripts
        .iter()
        .zip(&output_values)
        .map(|(s, v)| FusionOutput {
            scriptpubkey: s.clone(),
            value: *v,
        })
        .collect();

    let rechecked_plans = validate_and_index_plans(
        &live_hello,
        &input_pubkeys,
        &input_values,
        &all_output_scripts,
        &tier_plans,
    )?;
    if rechecked_plans.get(&begin.tier) != Some(&selected_plan) {
        return Err("selected tier plan changed before PlayerCommit".into());
    }

    let rc = build_round_commit(
        &fusion_inputs,
        &fusion_outputs,
        num_components,
        feerate,
        &round_pubkey,
        &start.blind_nonce_points,
    )?;
    if rc.excess_fee != selected_plan.excess_fee {
        return Err("selected tier excess fee changed before PlayerCommit".into());
    }

    let commit = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Playercommit(
            rc.player_commit.clone(),
        )),
    };
    cancellable(&cancel, send_frame(&mut main, &commit.encode_to_vec())).await?;

    // --- BlindSigResponses -> finalize each into a component signature ---
    let components_start = covert_t0 + timing.comps_at;
    let scalars = match recv_server_before(
        &mut main,
        &cancel,
        components_start,
        "BlindSigResponses",
    )
    .await?
    {
        pb::server_message::Msg::Blindsigresponses(r) => r.scalars,
        pb::server_message::Msg::Error(e) => {
            return Err(format!(
                "server error at blind sigs: {}",
                e.message.unwrap_or_default()
            ))
        }
        _ => return Err("expected BlindSigResponses".into()),
    };
    if scalars.len() != rc.requests.len() {
        return Err("blind sig response count mismatch".into());
    }
    let mut blind_sigs: Vec<[u8; 64]> = Vec::with_capacity(scalars.len());
    for (req, s) in rc.requests.iter().zip(&scalars) {
        let sb: [u8; 32] = s
            .as_slice()
            .try_into()
            .map_err(|_| "blind sig scalar not 32 bytes")?;
        blind_sigs.push(req.finalize(&sb, true)?);
    }

    // Last low-impact cancellation point before component disclosure.
    cancel.check()?;
    if covert_pool.is_none() {
        let schedule = pending_covert_schedule
            .take()
            .ok_or_else(|| "covert connection schedule was already consumed".to_string())?;
        covert_pool = Some(schedule.finish(components_start, &cancel).await?);
    }
    let pool = covert_pool
        .as_mut()
        .ok_or_else(|| "covert connection pool is unavailable".to_string())?;
    if pool.slot_count() != rc.components_sorted.len() {
        return Err("covert slot count does not match the committed components".into());
    }

    // --- Covert component submission ---
    let component_messages = rc
        .components_sorted
        .iter()
        .zip(&blind_sigs)
        .map(|(component, signature)| {
            Some(build_covert_component(&round_pubkey, signature, component))
        })
        .collect::<Vec<_>>();

    // Download the shared material while the randomized covert submissions run.
    let submit_components = pool.submit_phase(
        components_start,
        covert_t0 + timing.comps_deadline,
        timing.submit_timeout,
        component_messages,
        &cancel,
    );
    let receive_shared = async {
        let shared_deadline = covert_t0 + timing.sigs_at;
        let all_commitments = match recv_server_before(
            &mut main,
            &cancel,
            shared_deadline,
            "AllCommitments",
        )
        .await?
        {
            pb::server_message::Msg::Allcommitments(message) => message.initial_commitments,
            pb::server_message::Msg::Error(error) => {
                return Err(format!(
                    "server error at all-commitments: {}",
                    error.message.unwrap_or_default()
                ))
            }
            _ => return Err("expected AllCommitments".into()),
        };
        let shared =
            match recv_server_before(&mut main, &cancel, shared_deadline, "ShareCovertComponents")
                .await?
            {
                pb::server_message::Msg::Sharecovertcomponents(message) => message,
                pb::server_message::Msg::Error(error) => {
                    return Err(format!(
                        "server error at share-components: {}",
                        error.message.unwrap_or_default()
                    ))
                }
                _ => return Err("expected ShareCovertComponents".into()),
            };
        Ok::<_, String>((
            all_commitments,
            shared.components,
            shared.session_hash,
            shared.skip_signatures.unwrap_or(false),
        ))
    };
    let ((), (all_commitments, all_components, declared_hash, skip_signatures)) =
        tokio::try_join!(submit_components, receive_shared)?;

    let own_commitment_mapping = map_owned_items(
        &rc.player_commit.initial_commitments,
        &all_commitments,
        "commitments",
    )?;
    let my_commitment_indices = global_indices_in_local_order(
        &own_commitment_mapping,
        rc.player_commit.initial_commitments.len(),
        "commitments",
    )?;
    let own_component_slots =
        map_owned_items(&rc.components_sorted, &all_components, "components")?;
    let my_component_indices = global_indices_in_local_order(
        &own_component_slots,
        rc.components_sorted.len(),
        "components",
    )?;

    // --- Verify the session hash (anti-spy) ---
    let session_hash = calc_round_hash(
        &last_hash,
        &round_pubkey,
        round_time,
        &all_commitments,
        &all_components,
    );
    if let Some(declared) = declared_hash {
        if declared.as_slice() != session_hash.as_slice() {
            return Err("session hash mismatch — server told players different things".into());
        }
    } else if !skip_signatures {
        return Err("server omitted the CashFusion session hash".into());
    }
    // CashFusion chains every accepted round transcript, including failed
    // rounds, into the transcript used after RestartRound.
    last_hash = session_hash;

    if skip_signatures {
        run_blame_phase(
            &mut main,
            &cancel,
            &rc,
            &all_commitments,
            &all_components,
            &my_commitment_indices,
            &my_component_indices,
            &[],
            feerate,
            &lookup_endpoint,
            lookup_transport,
        )
        .await?;
        continue;
    }

    cancel.check()?;
    let signing_plans = validate_and_index_plans(
        &live_hello,
        &input_pubkeys,
        &input_values,
        &all_output_scripts,
        &tier_plans,
    )?;
    if signing_plans.get(&begin.tier) != Some(&selected_plan) {
        return Err("selected tier plan changed before signing".into());
    }

    // --- Verify the shared transaction, then sign ONLY our exact inputs ---
    verify_shared_transaction(&all_components, &inputs, &output_scripts, &output_values)?;
    let ftx = FusionTx::from_components(&all_components, &session_hash)?;
    let mut signature_messages = vec![None; pool.slot_count()];
    let mut signed_inputs = 0usize;
    for input_index in 0..ftx.num_inputs() {
        let component_index = ftx
            .input_component_index(input_index)
            .ok_or("missing component index")?;
        let component = pb::Component::decode(all_components[component_index].as_slice())
            .map_err(|error| format!("component decode: {error}"))?;
        let shared_input = match component.component {
            Some(pb::component::Component::Input(input)) => input,
            _ => continue,
        };
        let mut own_input = None;
        for input in &inputs {
            if input_matches_component(input, &shared_input)? {
                own_input = Some(input);
                break;
            }
        }
        let Some(input_key) = own_input else {
            continue;
        };

        let sighash = ftx.sighash(input_index)?;
        let secret = scalar_from_privkey(&input_key.privkey)?;
        let signature = schnorr::sign(secret, &sighash);
        let slot = *own_component_slots
            .get(&component_index)
            .ok_or("wallet input is missing its covert component slot")?;
        if signature_messages[slot].is_some() {
            return Err("multiple transaction signatures mapped to one covert slot".into());
        }
        signature_messages[slot] = Some(build_covert_signature(
            &round_pubkey,
            input_index as u32,
            &signature,
        ));
        signed_inputs += 1;
    }
    if signed_inputs != inputs.len() {
        return Err("not every wallet input received a transaction signature".into());
    }

    let signatures_start = covert_t0 + timing.sigs_at;
    if Instant::now() > signatures_start {
        return Err("shared transaction verification missed the signature window".into());
    }
    cancel.check()?;

    // Point of no return: once a valid signature can reach the server, the
    // transaction may be broadcast. Resolve the outcome even if the UI asks to
    // cancel later, so wallet completion tracking cannot be skipped.
    let irreversible = CancelFlag::new();
    let submit_signatures = pool.submit_phase(
        signatures_start,
        covert_t0 + timing.sigs_deadline,
        timing.submit_timeout,
        signature_messages,
        &irreversible,
    );
    let receive_result = recv_server_before(
        &mut main,
        &irreversible,
        covert_t0 + timing.conclusion_at,
        "FusionResult",
    );
    let ((), result_message) = tokio::try_join!(submit_signatures, receive_result)?;

    // --- FusionResult ---
    let result = match result_message {
        pb::server_message::Msg::Fusionresult(r) => r,
        pb::server_message::Msg::Restartround(_) => {
            return Err("server sent RestartRound before the blame exchange".into())
        }
        pb::server_message::Msg::Error(e) => {
            return Err(format!(
                "server error at result: {}",
                e.message.unwrap_or_default()
            ))
        }
        _ => return Err("expected FusionResult".into()),
    };

    if !result.ok {
        if result
            .bad_components
            .iter()
            .any(|bad| my_component_indices.contains(&(*bad as usize)))
        {
            return Err("server identified one of this wallet's valid components as bad".into());
        }
        run_blame_phase(
            &mut main,
            &cancel,
            &rc,
            &all_commitments,
            &all_components,
            &my_commitment_indices,
            &my_component_indices,
            &result.bad_components,
            feerate,
            &lookup_endpoint,
            lookup_transport,
        )
        .await?;
        continue;
    }

    // Assemble the fully-signed tx from all players' signatures.
    let sigs: Vec<Vec<u8>> = result.txsignatures;
    verify_transaction_signatures(&ftx, &sigs)?;
    let tx_hex = hexify(&ftx.serialize(&sigs)?);
    let txid = ftx.txid(&sigs)?;

    return Ok(FusionOutcome {
        ok: true,
        broadcast_verified: false,
        txid: Some(txid),
        tx_hex: Some(tx_hex),
        message: "fully signed transaction assembled; broadcast is not independently verified"
            .into(),
    });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fusion::pedersen::random_nonce;
    use crate::fusion::schnorr::{self, compressed, scalar_reduce};
    use crate::fusion::session::calc_round_hash as srv_round_hash;
    use k256::ProjectivePoint;
    use prost::Message;
    use std::collections::HashSet;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    enum Covert {
        Component(usize, Vec<u8>),
        Signature(u32, Vec<u8>),
    }

    fn test_input_key(
        prev_txid: u8,
        prev_index: u32,
        pubkey: Vec<u8>,
        value: u64,
    ) -> FusionInputKey {
        FusionInputKey {
            prev_txid: format!("{prev_txid:02x}").repeat(32),
            prev_index,
            pubkey,
            value,
            privkey: [1u8; 32],
        }
    }

    fn input_component(prev_txid: u8, prev_index: u32, pubkey: Vec<u8>, value: u64) -> Vec<u8> {
        pb::Component {
            salt_commitment: vec![0u8; 32],
            component: Some(pb::component::Component::Input(pb::InputComponent {
                prev_txid: vec![prev_txid; 32],
                prev_index,
                pubkey,
                amount: value,
            })),
        }
        .encode_to_vec()
    }

    fn output_component(scriptpubkey: Vec<u8>, amount: u64) -> Vec<u8> {
        pb::Component {
            salt_commitment: vec![0u8; 32],
            component: Some(pb::component::Component::Output(pb::OutputComponent {
                scriptpubkey,
                amount,
            })),
        }
        .encode_to_vec()
    }

    #[test]
    fn rejects_shared_transaction_missing_one_of_our_outputs() {
        let pubkey = vec![0x02; 33];
        let own_input = test_input_key(0xaa, 3, pubkey.clone(), 100_000);
        let own_output = vec![0x76, 0xa9, 0x14, 0x07, 0x88, 0xac];
        let shared = vec![
            input_component(0xaa, 3, pubkey, 100_000),
            output_component(vec![0x76, 0xa9, 0x14, 0x08, 0x88, 0xac], 90_000),
        ];

        let error =
            verify_shared_transaction(&shared, &[own_input], &[own_output], &[90_000]).unwrap_err();

        assert!(error.contains("omits one of this wallet's outputs"));
    }

    #[test]
    fn rejects_shared_transaction_that_substitutes_our_outpoint() {
        let pubkey = vec![0x02; 33];
        let own_input = test_input_key(0xaa, 3, pubkey.clone(), 100_000);
        let own_output = vec![0x76, 0xa9, 0x14, 0x07, 0x88, 0xac];
        let shared = vec![
            input_component(0xaa, 4, pubkey, 100_000),
            output_component(own_output.clone(), 90_000),
        ];

        let error =
            verify_shared_transaction(&shared, &[own_input], &[own_output], &[90_000]).unwrap_err();

        assert!(error.contains("omits one of this wallet's inputs"));
    }

    #[test]
    fn rejects_shared_transaction_that_creates_value_or_reuses_an_input() {
        let pubkey = vec![0x02; 33];
        let own_input = test_input_key(0xaa, 3, pubkey.clone(), 100_000);
        let own_output = vec![0x76, 0xa9, 0x14, 0x07, 0x88, 0xac];
        let inflated = vec![
            input_component(0xaa, 3, pubkey.clone(), 100_000),
            output_component(own_output.clone(), 90_000),
            output_component(vec![0x76, 0xa9, 0x14, 0x08, 0x88, 0xac], 10_001),
        ];
        let duplicate = vec![
            input_component(0xaa, 3, pubkey.clone(), 100_000),
            input_component(0xaa, 3, pubkey, 100_000),
            output_component(own_output.clone(), 90_000),
        ];

        let inflated_error =
            verify_shared_transaction(&inflated, &[own_input], &[own_output.clone()], &[90_000])
                .unwrap_err();
        let duplicate_error = verify_shared_transaction(
            &duplicate,
            &[test_input_key(0xaa, 3, vec![0x02; 33], 100_000)],
            &[own_output],
            &[90_000],
        )
        .unwrap_err();

        assert!(inflated_error.contains("inflates value"));
        assert!(duplicate_error.contains("duplicate input"));
    }

    #[test]
    fn rejects_an_invalid_final_transaction_signature() {
        let private_key = random_nonce();
        let pubkey = schnorr::pubkey_compressed(private_key).to_vec();
        let components = vec![
            input_component(0xaa, 3, pubkey, 100_000),
            output_component(vec![0x76, 0xa9, 0x14, 0x07, 0x88, 0xac], 90_000),
        ];
        let tx = FusionTx::from_components(&components, &[7u8; 32]).unwrap();
        let valid_signature = schnorr::sign(private_key, &tx.sighash(0).unwrap()).to_vec();

        verify_transaction_signatures(&tx, &[valid_signature]).unwrap();

        let error = verify_transaction_signatures(&tx, &[vec![0u8; 64]]).unwrap_err();
        assert!(error.contains("invalid transaction signature"));
    }

    // A minimal but complete mock CashFusion server for ONE player, over plain
    // TCP (no TLS, no Tor) — which also proves the non-SSL path works end to end.
    // It plays every server step so run_fusion's whole flow is exercised.
    async fn mock_server(
        main_listener: TcpListener,
        covert_listener: TcpListener,
        num_components: usize,
        feerate: u64,
        tier: u64,
        covert_port: u16,
        restart_once: bool,
    ) -> Result<String, String> {
        let server_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Covert collector: accept connections, read one CovertMessage each, ack OK,
        // and forward to the main task.
        let (tx, mut rx) = mpsc::channel::<Covert>(64);
        let covert_task = tokio::spawn(async move {
            let mut connection_id = 0usize;
            loop {
                let Ok((mut sock, _)) = covert_listener.accept().await else {
                    break;
                };
                let this_connection_id = connection_id;
                connection_id += 1;
                let tx = tx.clone();
                tokio::spawn(async move {
                    loop {
                        let raw = match recv_frame(&mut sock).await {
                            Ok(raw) => raw,
                            Err(_) => break,
                        };
                        let message = match pb::CovertMessage::decode(raw.as_slice()) {
                            Ok(message) => message,
                            Err(_) => break,
                        };
                        let observed = match message.msg {
                            Some(pb::covert_message::Msg::Component(component)) => {
                                Some(Covert::Component(
                                    this_connection_id,
                                    component.component,
                                ))
                            }
                            Some(pb::covert_message::Msg::Signature(signature)) => Some(
                                Covert::Signature(signature.which_input, signature.txsignature),
                            ),
                            Some(pb::covert_message::Msg::Ping(_)) => None,
                            None => break,
                        };
                        if let Some(observed) = observed {
                            let ok = pb::CovertResponse {
                                msg: Some(pb::covert_response::Msg::Ok(pb::Ok {})),
                            };
                            if send_frame(&mut sock, &ok.encode_to_vec()).await.is_err()
                                || tx.send(observed).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                });
            }
        });

        let (mut main, _) = main_listener.accept().await.map_err(|e| e.to_string())?;

        // ClientHello -> ServerHello
        let _ = recv_frame(&mut main).await?;
        let hello = pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Serverhello(pb::ServerHello {
                tiers: vec![tier],
                num_components: num_components as u32,
                component_feerate: feerate,
                min_excess_fee: 0,
                max_excess_fee: 10_000,
                donation_address: None,
            })),
        };
        send_frame(&mut main, &hello.encode_to_vec()).await?;

        // JoinPools -> FusionBegin
        let join = pb::ClientMessage::decode(recv_frame(&mut main).await?.as_slice())
            .map_err(|error| format!("decode JoinPools: {error}"))?;
        match join.msg {
            Some(pb::client_message::Msg::Joinpools(join)) if join.tiers == vec![tier] => {}
            _ => return Err("expected all feasible tiers in JoinPools".into()),
        }
        let begin = pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Fusionbegin(pb::FusionBegin {
                tier,
                covert_domain: b"127.0.0.1".to_vec(),
                covert_port: covert_port as u32,
                covert_ssl: Some(false),
                server_time,
            })),
        };
        send_frame(&mut main, &begin.encode_to_vec()).await?;

        let initial_hash =
            calc_initial_hash(tier, b"127.0.0.1", covert_port as u32, false, server_time);
        let mut last_hash = initial_hash;
        let round_count = if restart_once { 2 } else { 1 };
        let mut first_round_connections = None;
        let mut final_session_hash = [0u8; 32];

        for round_index in 0..round_count {
            // Every attempt gets fresh round keys, while the accepted main
            // socket and covert connection pool remain unchanged.
            let x = random_nonce();
            let round_pubkey = compressed(&(ProjectivePoint::GENERATOR * x)).to_vec();
            let ks: Vec<_> = (0..num_components).map(|_| random_nonce()).collect();
            let blind_nonce_points: Vec<Vec<u8>> = ks
                .iter()
                .map(|k| compressed(&(ProjectivePoint::GENERATOR * *k)).to_vec())
                .collect();

            let start = pb::ServerMessage {
                msg: Some(pb::server_message::Msg::Startround(pb::StartRound {
                    round_pubkey: round_pubkey.clone(),
                    blind_nonce_points: blind_nonce_points.clone(),
                    server_time,
                })),
            };
            send_frame(&mut main, &start.encode_to_vec()).await?;

            // PlayerCommit -> BlindSigResponses (s_i = k_i + e_i*x)
            let raw = recv_frame(&mut main).await?;
            let cm = pb::ClientMessage::decode(raw.as_slice())
                .map_err(|error| format!("decode PlayerCommit: {error}"))?;
            let pc = match cm.msg {
                Some(pb::client_message::Msg::Playercommit(p)) => p,
                _ => return Err("expected PlayerCommit".into()),
            };
            let mut scalars = Vec::new();
            for (e_bytes, k) in pc.blind_sig_requests.iter().zip(&ks) {
                let e = scalar_reduce(e_bytes.as_slice().try_into().unwrap());
                let s = *k + e * x;
                scalars.push(s.to_bytes().to_vec());
            }
            let bsr = pb::ServerMessage {
                msg: Some(pb::server_message::Msg::Blindsigresponses(
                    pb::BlindSigResponses { scalars },
                )),
            };
            send_frame(&mut main, &bsr.encode_to_vec()).await?;

            let mut all_commitments = pc.initial_commitments.clone();
            let peer_component = if restart_once {
                // Blame proof routing requires at least one non-owned,
                // structurally valid destination commitment.
                let peer = build_round_commit(
                    &[],
                    &[],
                    1,
                    feerate,
                    &round_pubkey,
                    &blind_nonce_points[..1],
                )?;
                all_commitments.push(peer.player_commit.initial_commitments[0].clone());
                Some(peer.components_sorted[0].clone())
            } else {
                None
            };
            let ac = pb::ServerMessage {
                msg: Some(pb::server_message::Msg::Allcommitments(
                    pb::AllCommitments {
                        initial_commitments: all_commitments.clone(),
                    },
                )),
            };
            send_frame(&mut main, &ac.encode_to_vec()).await?;

            // Collect one component from every live slot and remember which
            // covert sockets delivered them.
            let mut all_components = Vec::new();
            let mut component_connections = HashSet::new();
            while all_components.len() < num_components {
                match rx.recv().await {
                    Some(Covert::Component(connection_id, component)) => {
                        component_connections.insert(connection_id);
                        all_components.push(component);
                    }
                    Some(_) => {}
                    None => return Err("covert channel closed early".into()),
                }
            }
            if component_connections.len() != num_components {
                return Err("components did not use one distinct covert socket per slot".into());
            }
            if let Some(first) = &first_round_connections {
                if first != &component_connections {
                    return Err("restarted round did not reuse the covert connection pool".into());
                }
            } else {
                first_round_connections = Some(component_connections);
            }
            if let Some(peer_component) = peer_component {
                all_components.push(peer_component);
            }

            final_session_hash = srv_round_hash(
                &last_hash,
                &round_pubkey,
                server_time,
                &all_commitments,
                &all_components,
            );
            last_hash = final_session_hash;
            let skip_signatures = restart_once && round_index == 0;
            let scc = pb::ServerMessage {
                msg: Some(pb::server_message::Msg::Sharecovertcomponents(
                    pb::ShareCovertComponents {
                        components: all_components.clone(),
                        skip_signatures: Some(skip_signatures),
                        session_hash: Some(final_session_hash.to_vec()),
                    },
                )),
            };
            send_frame(&mut main, &scc.encode_to_vec()).await?;

            if skip_signatures {
                let message = pb::ClientMessage::decode(recv_frame(&mut main).await?.as_slice())
                    .map_err(|error| format!("decode MyProofsList: {error}"))?;
                match message.msg {
                    Some(pb::client_message::Msg::Myproofslist(proofs))
                        if proofs.encrypted_proofs.len() == num_components
                            && proofs.random_number.len() == 32 => {}
                    _ => return Err("expected complete MyProofsList".into()),
                }
                let theirs = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Theirproofslist(
                        pb::TheirProofsList { proofs: vec![] },
                    )),
                };
                send_frame(&mut main, &theirs.encode_to_vec()).await?;

                let message = pb::ClientMessage::decode(recv_frame(&mut main).await?.as_slice())
                    .map_err(|error| format!("decode Blames: {error}"))?;
                match message.msg {
                    Some(pb::client_message::Msg::Blames(blames)) if blames.blames.is_empty() => {}
                    _ => return Err("expected empty Blames after empty TheirProofsList".into()),
                }
                let restart = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Restartround(pb::RestartRound {})),
                };
                send_frame(&mut main, &restart.encode_to_vec()).await?;
                continue;
            }

            // Collect the covert signatures (one per input) and echo them back.
            let ftx = FusionTx::from_components(&all_components, &final_session_hash)?;
            let mut sigs: Vec<Vec<u8>> = vec![Vec::new(); ftx.num_inputs()];
            let mut got = 0;
            while got < ftx.num_inputs() {
                match rx.recv().await {
                    Some(Covert::Signature(idx, sig)) => {
                        sigs[idx as usize] = sig;
                        got += 1;
                    }
                    Some(_) => {}
                    None => return Err("covert channel closed before sigs".into()),
                }
            }

            let result = pb::ServerMessage {
                msg: Some(pb::server_message::Msg::Fusionresult(pb::FusionResult {
                    ok: true,
                    txsignatures: sigs,
                    bad_components: vec![],
                })),
            };
            send_frame(&mut main, &result.encode_to_vec()).await?;
        }

        covert_task.abort();
        Ok(hexify(&final_session_hash))
    }

    #[test]
    fn full_round_against_a_mock_server_over_plain_tcp() {
        // End-to-end: run_fusion drives a complete round against the mock server
        // above, over non-SSL TCP. Passing means every stage lines up — hello,
        // join, blind-sig finalize, covert submit, session-hash match, tx build +
        // sign, and result assembly.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let main_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let covert_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let main_port = main_l.local_addr().unwrap().port();
            let covert_port = covert_l.local_addr().unwrap().port();

            let num_components = 17usize; // 1 input + 10 outputs + 6 blanks
            let feerate = 1000u64;
            let tier = 90_000u64;

            let server = tokio::spawn(mock_server(
                main_l,
                covert_l,
                num_components,
                feerate,
                tier,
                covert_port,
                false,
            ));

            // A real input key so the P2PKH scriptCode + signature are consistent.
            let priv_k = random_nonce();
            let pubkey = schnorr::pubkey_compressed(priv_k).to_vec();
            let mut privkey = [0u8; 32];
            privkey.copy_from_slice(&priv_k.to_bytes());

            let output_scripts = (0..10)
                .map(|seed| {
                    let mut script = vec![0x76, 0xa9, 0x14];
                    script.extend_from_slice(&[seed; 20]);
                    script.extend_from_slice(&[0x88, 0xac]);
                    script
                })
                .collect::<Vec<_>>();
            // 200,000 in - 141 input fee - 340 output fees - 10 excess.
            let output_values = vec![
                19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_950,
            ];

            let params = FusionRunParams {
                host: "127.0.0.1",
                port: main_port,
                use_ssl: false, // <-- plain TCP path
                tier_plans: vec![FusionTierPlan {
                    tier,
                    output_values,
                    excess_fee: 10,
                }],
                inputs: vec![FusionInputKey {
                    prev_txid: "cd".repeat(32),
                    prev_index: 0,
                    pubkey,
                    value: 200_000,
                    privkey,
                }],
                output_scripts,
                transport: Transport::Direct,
                lookup_endpoint: ElectrumEndpoint {
                    host: "127.0.0.1".into(),
                    port: 1,
                    use_ssl: false,
                },
                lookup_transport: Transport::Direct,
                timing: FusionTiming {
                    warmup_expected: Duration::ZERO,
                    warmup_slop: Duration::from_millis(250),
                    connect_window: Duration::ZERO,
                    connect_timeout: Duration::from_secs(2),
                    submit_window: Duration::from_millis(20),
                    submit_timeout: Duration::from_millis(500),
                    connect_spares: 2,
                    comps_at: Duration::from_millis(200),
                    comps_deadline: Duration::from_millis(700),
                    sigs_at: Duration::from_millis(900),
                    sigs_deadline: Duration::from_millis(1_400),
                    conclusion_at: Duration::from_secs(2),
                },
                cancel: CancelFlag::new(),
                expected_hello: ExpectedHello {
                    tiers: vec![tier],
                    num_components: num_components as u32,
                    component_feerate: feerate,
                    min_excess_fee: 0,
                    max_excess_fee: 10_000,
                },
            };

            let outcome = run_fusion(params)
                .await
                .expect("run_fusion should not error");
            server.await.unwrap().expect("mock server ok");

            assert!(outcome.ok, "fusion should succeed: {}", outcome.message);
            assert!(
                !outcome.broadcast_verified,
                "assembling a signed transaction is not proof that it reached the network"
            );
            assert!(outcome.txid.is_some());
            let tx_hex = outcome.tx_hex.expect("tx hex");
            assert!(tx_hex.starts_with("01000000"), "version 1 tx");
            // OP_RETURN session marker present in the assembled tx.
            assert!(tx_hex.contains(&hexify(b"FUZ\x00")), "FUSE_ID marker in tx");
        });
    }

    #[test]
    fn skip_signatures_blame_restart_reuses_main_and_covert_connections() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let main_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let covert_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let main_port = main_l.local_addr().unwrap().port();
            let covert_port = covert_l.local_addr().unwrap().port();

            let num_components = 17usize;
            let feerate = 1000u64;
            let tier = 90_000u64;
            let server = tokio::spawn(mock_server(
                main_l,
                covert_l,
                num_components,
                feerate,
                tier,
                covert_port,
                true,
            ));

            let priv_k = random_nonce();
            let pubkey = schnorr::pubkey_compressed(priv_k).to_vec();
            let mut privkey = [0u8; 32];
            privkey.copy_from_slice(&priv_k.to_bytes());
            let output_scripts = (0..10)
                .map(|seed| {
                    let mut script = vec![0x76, 0xa9, 0x14];
                    script.extend_from_slice(&[seed; 20]);
                    script.extend_from_slice(&[0x88, 0xac]);
                    script
                })
                .collect::<Vec<_>>();

            let outcome = run_fusion(FusionRunParams {
                host: "127.0.0.1",
                port: main_port,
                use_ssl: false,
                tier_plans: vec![FusionTierPlan {
                    tier,
                    output_values: vec![
                        19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951, 19_951,
                        19_950,
                    ],
                    excess_fee: 10,
                }],
                inputs: vec![FusionInputKey {
                    prev_txid: "cd".repeat(32),
                    prev_index: 0,
                    pubkey,
                    value: 200_000,
                    privkey,
                }],
                output_scripts,
                transport: Transport::Direct,
                lookup_endpoint: ElectrumEndpoint {
                    host: "127.0.0.1".into(),
                    port: 1,
                    use_ssl: false,
                },
                lookup_transport: Transport::Direct,
                timing: FusionTiming {
                    warmup_expected: Duration::ZERO,
                    warmup_slop: Duration::from_millis(250),
                    connect_window: Duration::ZERO,
                    connect_timeout: Duration::from_secs(2),
                    submit_window: Duration::from_millis(20),
                    submit_timeout: Duration::from_millis(500),
                    connect_spares: 2,
                    comps_at: Duration::from_millis(200),
                    comps_deadline: Duration::from_millis(700),
                    sigs_at: Duration::from_millis(900),
                    sigs_deadline: Duration::from_millis(1_400),
                    conclusion_at: Duration::from_secs(2),
                },
                cancel: CancelFlag::new(),
                expected_hello: ExpectedHello {
                    tiers: vec![tier],
                    num_components: num_components as u32,
                    component_feerate: feerate,
                    min_excess_fee: 0,
                    max_excess_fee: 10_000,
                },
            })
            .await
            .expect("blame restart should remain on the live Fusion session");
            server.await.unwrap().expect("mock server transcript");

            assert!(
                outcome.ok,
                "fresh round after blame restart should succeed: {}",
                outcome.message
            );
            assert!(outcome.txid.is_some());
            assert!(outcome.tx_hex.is_some());
        });
    }
}
