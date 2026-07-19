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
    /// When to submit components / signatures, relative to StartRound receipt.
    /// Defaults (via `FusionTiming::default`) match protocol.py (+5s / +20s);
    /// the integration test shrinks them so it doesn't wait 20 real seconds.
    pub timing: FusionTiming,
}

/// Covert submission timing relative to covert_T0 (StartRound receipt).
#[derive(Clone, Copy)]
pub struct FusionTiming {
    pub comps_at: Duration,
    pub sigs_at: Duration,
}
impl Default for FusionTiming {
    fn default() -> Self {
        Self { comps_at: T_START_COMPS, sigs_at: T_START_SIGS }
    }
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
    let FusionRunParams { host, port, use_ssl, tier, inputs, output_scripts, output_values, transport, timing } = params;
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
    sleep_until(covert_t0 + timing.comps_at).await;
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

    sleep_until(covert_t0 + timing.sigs_at).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fusion::schnorr::{self, compressed, scalar_reduce};
    use crate::fusion::session::calc_round_hash as srv_round_hash;
    use crate::fusion::pedersen::random_nonce;
    use k256::ProjectivePoint;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    enum Covert {
        Component(Vec<u8>),
        Signature(u32, Vec<u8>),
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
    ) -> Result<String, String> {
        // Round secrets the server knows.
        let x = random_nonce(); // round private key
        let round_pubkey = compressed(&(ProjectivePoint::GENERATOR * x)).to_vec();
        let ks: Vec<_> = (0..num_components).map(|_| random_nonce()).collect();
        let blind_nonce_points: Vec<Vec<u8>> =
            ks.iter().map(|k| compressed(&(ProjectivePoint::GENERATOR * *k)).to_vec()).collect();
        let server_time = 1_700_000_000u64;

        // Covert collector: accept connections, read one CovertMessage each, ack OK,
        // and forward to the main task.
        let (tx, mut rx) = mpsc::channel::<Covert>(64);
        let covert_task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = covert_listener.accept().await else { break };
                let raw = match recv_frame(&mut sock).await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let ok = pb::CovertResponse { msg: Some(pb::covert_response::Msg::Ok(pb::Ok {})) };
                let _ = send_frame(&mut sock, &ok.encode_to_vec()).await;
                let m = pb::CovertMessage::decode(raw.as_slice()).unwrap();
                match m.msg {
                    Some(pb::covert_message::Msg::Component(c)) => {
                        if tx.send(Covert::Component(c.component)).await.is_err() { break }
                    }
                    Some(pb::covert_message::Msg::Signature(s)) => {
                        if tx.send(Covert::Signature(s.which_input, s.txsignature)).await.is_err() { break }
                    }
                    _ => {}
                }
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
                max_excess_fee: 1_000_000,
                donation_address: None,
            })),
        };
        send_frame(&mut main, &hello.encode_to_vec()).await?;

        // JoinPools -> FusionBegin
        let _ = recv_frame(&mut main).await?;
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

        // StartRound
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
        let cm = pb::ClientMessage::decode(raw.as_slice()).unwrap();
        let pc = match cm.msg {
            Some(pb::client_message::Msg::Playercommit(p)) => p,
            _ => return Err("expected PlayerCommit".into()),
        };
        let all_commitments = pc.initial_commitments.clone();
        let mut scalars = Vec::new();
        for (e_bytes, k) in pc.blind_sig_requests.iter().zip(&ks) {
            let e = scalar_reduce(e_bytes.as_slice().try_into().unwrap());
            let s = *k + e * x;
            scalars.push(s.to_bytes().to_vec());
        }
        let bsr = pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Blindsigresponses(pb::BlindSigResponses { scalars })),
        };
        send_frame(&mut main, &bsr.encode_to_vec()).await?;

        // AllCommitments
        let ac = pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Allcommitments(pb::AllCommitments {
                initial_commitments: all_commitments.clone(),
            })),
        };
        send_frame(&mut main, &ac.encode_to_vec()).await?;

        // Collect the covert components.
        let mut all_components = Vec::new();
        while all_components.len() < num_components {
            match rx.recv().await {
                Some(Covert::Component(c)) => all_components.push(c),
                Some(_) => {}
                None => return Err("covert channel closed early".into()),
            }
        }

        // ShareCovertComponents with the session hash the client will recompute.
        let initial_hash = calc_initial_hash(tier, b"127.0.0.1", covert_port as u32, false, server_time);
        let session_hash = srv_round_hash(&initial_hash, &round_pubkey, server_time, &all_commitments, &all_components);
        let scc = pb::ServerMessage {
            msg: Some(pb::server_message::Msg::Sharecovertcomponents(pb::ShareCovertComponents {
                components: all_components.clone(),
                skip_signatures: Some(false),
                session_hash: Some(session_hash.to_vec()),
            })),
        };
        send_frame(&mut main, &scc.encode_to_vec()).await?;

        // Collect the covert signatures (one per input) and echo them back.
        let ftx = FusionTx::from_components(&all_components, &session_hash)?;
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

        covert_task.abort();
        Ok(hexify(&session_hash))
    }

    #[test]
    fn full_round_against_a_mock_server_over_plain_tcp() {
        // End-to-end: run_fusion drives a complete round against the mock server
        // above, over non-SSL TCP. Passing means every stage lines up — hello,
        // join, blind-sig finalize, covert submit, session-hash match, tx build +
        // sign, and result assembly.
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let main_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let covert_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let main_port = main_l.local_addr().unwrap().port();
            let covert_port = covert_l.local_addr().unwrap().port();

            let num_components = 3usize; // 1 input + 1 output + 1 blank
            let feerate = 1000u64;
            let tier = 90_000u64;

            let server = tokio::spawn(mock_server(main_l, covert_l, num_components, feerate, tier, covert_port));

            // A real input key so the P2PKH scriptCode + signature are consistent.
            let priv_k = random_nonce();
            let pubkey = schnorr::pubkey_compressed(priv_k).to_vec();
            let mut privkey = [0u8; 32];
            privkey.copy_from_slice(&priv_k.to_bytes());

            // 1 output: a P2PKH script (tier-sized).
            let out_script = {
                let mut s = vec![0x76, 0xa9, 0x14];
                s.extend_from_slice(&[7u8; 20]);
                s.extend_from_slice(&[0x88, 0xac]);
                s
            };

            let params = FusionRunParams {
                host: "127.0.0.1",
                port: main_port,
                use_ssl: false, // <-- plain TCP path
                tier,
                inputs: vec![FusionInputKey {
                    prev_txid: "cd".repeat(32),
                    prev_index: 0,
                    pubkey,
                    value: 100_000,
                    privkey,
                }],
                output_scripts: vec![out_script],
                output_values: vec![90_000],
                transport: Transport::Direct,
                timing: FusionTiming {
                    comps_at: Duration::from_millis(50),
                    sigs_at: Duration::from_millis(150),
                },
            };

            let outcome = run_fusion(params).await.expect("run_fusion should not error");
            server.await.unwrap().expect("mock server ok");

            assert!(outcome.ok, "fusion should succeed: {}", outcome.message);
            assert!(outcome.txid.is_some());
            let tx_hex = outcome.tx_hex.expect("tx hex");
            assert!(tx_hex.starts_with("01000000"), "version 1 tx");
            // OP_RETURN session marker present in the assembled tx.
            assert!(tx_hex.contains(&hexify(b"FUZ\x00")), "FUSE_ID marker in tx");
        });
    }
}
