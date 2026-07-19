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

use std::time::{Duration, Instant};

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use prost::Message;
use tokio::io::AsyncRead;

use super::components::{build_round_commit, FusionInput, FusionOutput};
use super::covert::{build_covert_signature, CovertConnection};
use super::schnorr;
use super::session::{build_covert_component, calc_initial_hash, calc_round_hash};
use super::tx::FusionTx;
use super::{connect_stream, pb, recv_frame, send_frame, Transport, VERSION};

// Timing relative to covert_T0 (StartRound receipt), from protocol.py.
const T_START_COMPS: Duration = Duration::from_secs(5);
const T_START_SIGS: Duration = Duration::from_secs(20);
/// How long to wait in the pool for a tier to reach its start threshold.
const JOIN_WAIT: Duration = Duration::from_secs(120);
/// Bound on waiting for StartRound after FusionBegin.
const START_ROUND_WAIT: Duration = Duration::from_secs(30);

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
    pub tier: u64,
    pub inputs: Vec<FusionInputKey>,
    /// Fresh output scriptpubkeys (HD/RPA) and their values (tier-sized minus fees).
    pub output_scripts: Vec<Vec<u8>>,
    pub output_values: Vec<u64>,
    /// Transport for BOTH the main and covert connections. Must be Tor for a
    /// remote server (covert unlinkability depends on it).
    pub transport: Transport<'a>,
}

#[derive(serde::Serialize)]
pub struct FusionOutcome {
    pub ok: bool,
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

/// Run one full fusion round. Returns the assembled tx (hex + txid) on success;
/// the server also broadcasts it. On a round restart/failure the outcome's `ok`
/// is false with a message.
pub async fn run_fusion(params: FusionRunParams<'_>) -> Result<FusionOutcome, String> {
    let FusionRunParams { host, port, use_ssl, tier, inputs, output_scripts, output_values, transport } = params;
    if inputs.is_empty() {
        return Err("no inputs to fuse".into());
    }
    if output_scripts.len() != output_values.len() {
        return Err("output script/value length mismatch".into());
    }

    // --- Main connection: hello -> join ---
    let mut main = connect_stream(host, port, use_ssl, transport).await?;

    let hello = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Clienthello(pb::ClientHello {
            version: VERSION.to_vec(),
            genesis_hash: None,
        })),
    };
    send_frame(&mut main, &hello.encode_to_vec()).await?;

    let (num_components, feerate) = match recv_server(&mut main).await? {
        pb::server_message::Msg::Serverhello(h) => (h.num_components as usize, h.component_feerate),
        pb::server_message::Msg::Error(e) => {
            return Err(format!("server rejected hello: {}", e.message.unwrap_or_default()))
        }
        _ => return Err("expected ServerHello".into()),
    };

    let join = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Joinpools(pb::JoinPools { tiers: vec![tier], tags: vec![] })),
    };
    send_frame(&mut main, &join.encode_to_vec()).await?;

    // --- Wait for the tier to start (FusionBegin) ---
    let begin = {
        let deadline = Instant::now() + JOIN_WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(FusionOutcome {
                    ok: false,
                    txid: None,
                    tx_hex: None,
                    message: "no other players joined this tier in time".into(),
                });
            }
            match tokio::time::timeout(remaining, recv_server(&mut main)).await {
                Err(_) => continue,
                Ok(msg) => match msg? {
                    pb::server_message::Msg::Tierstatusupdate(_) => continue,
                    pb::server_message::Msg::Fusionbegin(b) => break b,
                    pb::server_message::Msg::Error(e) => {
                        return Err(format!("server error while queued: {}", e.message.unwrap_or_default()))
                    }
                    _ => continue,
                },
            }
        }
    };

    let covert_domain = String::from_utf8_lossy(&begin.covert_domain).into_owned();
    let covert_port = begin.covert_port as u16;
    let covert_ssl = begin.covert_ssl.unwrap_or(false);
    let initial_hash =
        calc_initial_hash(begin.tier, &begin.covert_domain, begin.covert_port, covert_ssl, begin.server_time);

    // --- StartRound ---
    let start = match tokio::time::timeout(START_ROUND_WAIT, recv_server(&mut main)).await {
        Ok(m) => match m? {
            pb::server_message::Msg::Startround(s) => s,
            pb::server_message::Msg::Error(e) => {
                return Err(format!("server error at start: {}", e.message.unwrap_or_default()))
            }
            _ => return Err("expected StartRound".into()),
        },
        Err(_) => return Err("timed out waiting for StartRound".into()),
    };
    let covert_t0 = Instant::now();
    let round_pubkey = start.round_pubkey.clone();
    let round_time = start.server_time;

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
        .map(|(s, v)| FusionOutput { scriptpubkey: s.clone(), value: *v })
        .collect();

    let rc = build_round_commit(
        &fusion_inputs,
        &fusion_outputs,
        num_components,
        feerate,
        &round_pubkey,
        &start.blind_nonce_points,
    )?;

    let commit = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Playercommit(rc.player_commit.clone())),
    };
    send_frame(&mut main, &commit.encode_to_vec()).await?;

    // --- BlindSigResponses -> finalize each into a component signature ---
    let scalars = match recv_server(&mut main).await? {
        pb::server_message::Msg::Blindsigresponses(r) => r.scalars,
        pb::server_message::Msg::Error(e) => {
            return Err(format!("server error at blind sigs: {}", e.message.unwrap_or_default()))
        }
        _ => return Err("expected BlindSigResponses".into()),
    };
    if scalars.len() != rc.requests.len() {
        return Err("blind sig response count mismatch".into());
    }
    let mut blind_sigs: Vec<[u8; 64]> = Vec::with_capacity(scalars.len());
    for (req, s) in rc.requests.iter().zip(&scalars) {
        let sb: [u8; 32] = s.as_slice().try_into().map_err(|_| "blind sig scalar not 32 bytes")?;
        blind_sigs.push(req.finalize(&sb, true)?);
    }

    // --- Covert component submission ---
    // Open one covert connection per component (own Tor circuit), then submit.
    let mut conns = Vec::with_capacity(rc.components_sorted.len());
    for _ in 0..rc.components_sorted.len() {
        conns.push(CovertConnection::open(&covert_domain, covert_port, covert_ssl, transport).await?);
    }
    sleep_until(covert_t0 + T_START_COMPS).await;
    let mut submit_tasks = Vec::new();
    for ((conn, comp), sig) in conns.into_iter().zip(&rc.components_sorted).zip(&blind_sigs) {
        let msg = build_covert_component(&round_pubkey, sig, comp);
        submit_tasks.push(tokio::spawn(async move {
            let mut conn = conn;
            conn.submit(&msg).await
        }));
    }
    for t in submit_tasks {
        t.await.map_err(|e| format!("covert submit task: {e}"))??;
    }

    // --- AllCommitments then ShareCovertComponents ---
    let all_commitments = match recv_server(&mut main).await? {
        pb::server_message::Msg::Allcommitments(a) => a.initial_commitments,
        pb::server_message::Msg::Error(e) => {
            return Err(format!("server error at all-commitments: {}", e.message.unwrap_or_default()))
        }
        _ => return Err("expected AllCommitments".into()),
    };
    let (all_components, declared_hash, skip_signatures) = match recv_server(&mut main).await? {
        pb::server_message::Msg::Sharecovertcomponents(s) => {
            (s.components, s.session_hash, s.skip_signatures.unwrap_or(false))
        }
        pb::server_message::Msg::Error(e) => {
            return Err(format!("server error at share-components: {}", e.message.unwrap_or_default()))
        }
        _ => return Err("expected ShareCovertComponents".into()),
    };

    // --- Verify the session hash (anti-spy) ---
    let session_hash = calc_round_hash(&initial_hash, &round_pubkey, round_time, &all_commitments, &all_components);
    if let Some(declared) = declared_hash {
        if declared != session_hash {
            return Err("session hash mismatch — server told players different things".into());
        }
    }

    if skip_signatures {
        return Ok(FusionOutcome { ok: false, txid: None, tx_hex: None, message: "server skipped signatures (a component was rejected); round will restart".into() });
    }

    // --- Build the tx and sign OUR inputs ---
    let ftx = FusionTx::from_components(&all_components, &session_hash)?;
    // For each tx input, if its component's pubkey is one of ours, sign it.
    let mut submit_sig_tasks = Vec::new();
    for i in 0..ftx.num_inputs() {
        let cidx = ftx.input_component_index(i).ok_or("missing component index")?;
        let comp = &all_components[cidx];
        // Is this our input? Match the component's pubkey to one of our inputs.
        let comp_msg = pb::Component::decode(comp.as_slice()).map_err(|e| format!("component decode: {e}"))?;
        let inp_pubkey = match comp_msg.component {
            Some(pb::component::Component::Input(inp)) => inp.pubkey,
            _ => continue,
        };
        let Some(inkey) = inputs.iter().find(|k| k.pubkey == inp_pubkey) else { continue };

        let sighash = ftx.sighash(i)?;
        let sk = scalar_from_privkey(&inkey.privkey)?;
        let sig = schnorr::sign(sk, &sighash);
        let covert_msg = build_covert_signature(&round_pubkey, i as u32, &sig);
        let conn = CovertConnection::open(&covert_domain, covert_port, covert_ssl, transport).await?;
        submit_sig_tasks.push(tokio::spawn(async move {
            let mut conn = conn;
            conn.submit(&covert_msg).await
        }));
    }

    sleep_until(covert_t0 + T_START_SIGS).await;
    for t in submit_sig_tasks {
        t.await.map_err(|e| format!("covert sig task: {e}"))??;
    }

    // --- FusionResult ---
    let result = match recv_server(&mut main).await? {
        pb::server_message::Msg::Fusionresult(r) => r,
        pb::server_message::Msg::Restartround(_) => {
            return Ok(FusionOutcome { ok: false, txid: None, tx_hex: None, message: "round restarted (a player misbehaved)".into() })
        }
        pb::server_message::Msg::Error(e) => {
            return Err(format!("server error at result: {}", e.message.unwrap_or_default()))
        }
        _ => return Err("expected FusionResult".into()),
    };

    if !result.ok {
        return Ok(FusionOutcome { ok: false, txid: None, tx_hex: None, message: "fusion failed; blame phase would follow".into() });
    }

    // Assemble the fully-signed tx from all players' signatures.
    if result.txsignatures.len() != ftx.num_inputs() {
        return Err("server returned wrong number of signatures".into());
    }
    let sigs: Vec<Vec<u8>> = result.txsignatures;
    for s in &sigs {
        if s.len() != 64 {
            return Err("server relayed a bad-length signature".into());
        }
    }
    let tx_hex = hexify(&ftx.serialize(&sigs)?);
    let txid = ftx.txid(&sigs)?;

    Ok(FusionOutcome { ok: true, txid: Some(txid), tx_hex: Some(tx_hex), message: "fusion complete".into() })
}

async fn sleep_until(t: Instant) {
    let now = Instant::now();
    if t > now {
        tokio::time::sleep(t - now).await;
    }
}
