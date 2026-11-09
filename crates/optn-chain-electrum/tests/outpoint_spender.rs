use optn_chain_electrum::{ElectrumBackend, ElectrumConfig, ElectrumTransport};
use optn_core::{header_hash::sha256d, tx};
use optn_runtime::chain::{Capability, Endpoint, EndpointKind, Evidence, SourceId};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainOperation, ChainPayload,
    ChainRequest, ObservedTransaction,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout, Instant};

// Deliberately asymmetric: reversing an input hash must not accidentally match.
const TARGET: [u8; 32] = *b"0123456789abcdef0123456789ABCDEF";
const VOUT: u32 = 7;
/// The parent most fixtures spend. No server knows it, so a walk back from a
/// candidate asks for it once and is told it does not exist.
const FUNDING: [u8; 32] = [9; 32];
const SCRIPT: &[u8] = &[0x51];
const UNSPENT: usize = 0;
const HISTORY: usize = 1;
const MEMPOOL: usize = 2;
const METHODS: [&str; 3] = [
    "blockchain.scripthash.listunspent",
    "blockchain.scripthash.get_history",
    "blockchain.scripthash.get_mempool",
];

#[derive(Default)]
struct Mock {
    lists: [Vec<Value>; 3],
    transactions: BTreeMap<String, Value>,
    transaction_delay: Duration,
    reconnect_protocol: Option<&'static str>,
    allow_disconnect: bool,
    pipeline_width: usize,
    /// Close the probe connection once it is done, as a server would after an
    /// idle period, so the first request finds its parked connection dead.
    close_after_probe: bool,
}

impl Mock {
    fn add(&mut self, source: usize, raw: &[u8], height: i64) -> String {
        let hash = display_hash(sha256d(raw));
        self.transactions
            .insert(hash.clone(), json!(hex::encode(raw)));
        let mut entry = json!({"tx_hash": hash, "height": height});
        if source == UNSPENT {
            entry["tx_pos"] = json!(0);
            entry["value"] = json!(1000);
        }
        self.lists[source].push(entry);
        hash
    }
}

fn display_hash(mut hash: [u8; 32]) -> String {
    hash.reverse();
    hex::encode(hash)
}

fn transaction(inputs: &[([u8; 32], u32)], marker: u32) -> Vec<u8> {
    transaction_with_outputs(inputs, marker, SCRIPT, 1)
}

fn transaction_with_outputs(
    inputs: &[([u8; 32], u32)],
    marker: u32,
    script: &[u8],
    output_count: u64,
) -> Vec<u8> {
    let mut raw = 2u32.to_le_bytes().to_vec();
    raw.extend(tx::varint(inputs.len() as u64));
    for (txid, vout) in inputs {
        raw.extend(txid);
        raw.extend(vout.to_le_bytes());
        raw.push(0); // Empty scriptSig; fixtures test decoding, not signature validation.
        raw.extend(u32::MAX.to_le_bytes());
    }
    raw.extend(tx::varint(output_count));
    for _ in 0..output_count {
        raw.extend(1000u64.to_le_bytes());
        raw.extend(tx::varint(script.len() as u64));
        raw.extend(script);
    }
    raw.extend(marker.to_le_bytes());
    tx::decode(&raw).expect("structurally valid BCH fixture");
    raw
}

fn successor(marker: u32) -> Vec<u8> {
    transaction(&[([9; 32], 0), (TARGET, VOUT)], marker)
}

async fn query(
    mock: Mock,
    protocol: &'static str,
    from_height: Option<u32>,
) -> (Result<BackendObservation, ChainBackendError>, Vec<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, stopped) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let mut calls = Vec::new();
        let mut connections = 0;
        tokio::select! {
            _ = stopped => {},
            _ = async {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    connections += 1;
                    let negotiated = if connections > 1 {
                        mock.reconnect_protocol.unwrap_or(protocol)
                    } else {
                        protocol
                    };
                    stream.set_nodelay(true).unwrap();
                    let mut stream = BufReader::new(stream);
                    let mut line = String::new();
                    let mut pending = Vec::new();
                    loop {
                        line.clear();
                        let read = if pending.is_empty() {
                            stream.read_line(&mut line).await
                        } else {
                            timeout(Duration::from_secs(2), stream.read_line(&mut line))
                                .await.expect("candidate requests must be pipelined before replies")
                        };
                        match read {
                            Ok(0) => break,
                            Ok(_) => {},
                            Err(_) if mock.allow_disconnect => break,
                            Err(error) => panic!("mock read failed: {error}"),
                        }
                        let request: Value = serde_json::from_str(&line).unwrap();
                        calls.push(request.clone());
                        let method = request["method"].as_str().unwrap();
                        assert!(pending.is_empty() || method == "blockchain.transaction.get");
                        let mut error = Value::Null;
                        let result = match method {
                            "server.version" => json!(["outpoint-test", negotiated]),
                            "server.features" => json!({"genesis_hash": display_hash([9; 32])}),
                            "server.peers.subscribe" => json!([]),
                            "blockchain.transaction.get" => {
                                let hash = request["params"][0].as_str().unwrap();
                                assert_eq!(request["params"], json!([hash, false]));
                                if !mock.transaction_delay.is_zero() {
                                    sleep(mock.transaction_delay).await;
                                }
                                mock.transactions.get(hash).cloned().unwrap_or_else(|| {
                                    error = json!({"code": 2,
                                        "message": "No such mempool or blockchain transaction"});
                                    Value::Null
                                })
                            }
                            method if METHODS.contains(&method) => {
                                let index = METHODS.iter().position(|name| *name == method).unwrap();
                                json!(mock.lists[index])
                            }
                            other => panic!("unexpected RPC (no WalletRefresh is needed): {other}"),
                        };
                        let response = json!({"jsonrpc": "2.0", "id": request["id"],
                            "result": result, "error": error});
                        pending.push(response);
                        if method == "blockchain.transaction.get" && pending.len() < mock.pipeline_width {
                            continue;
                        }
                        // A gated batch receives no replies until every request arrives.
                        // Reverse replies also exercise request-ID binding.
                        let mut disconnected = false;
                        for response in pending.drain(..).rev() {
                            if let Err(error) = stream.get_mut()
                                .write_all(format!("{response}\n").as_bytes()).await
                            {
                                assert!(mock.allow_disconnect, "mock write failed: {error}");
                                disconnected = true;
                                break;
                            }
                        }
                        if disconnected
                            || (mock.close_after_probe && connections == 1
                                && method == "server.peers.subscribe")
                        {
                            break;
                        }
                    }
                }
            } => {},
        }
        calls
    });

    let mut config = ElectrumConfig::new(
        SourceId::new("outpoint-test"),
        Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "127.0.0.1".into(),
            port: Some(port),
        },
        ElectrumTransport::Tcp,
        [9; 32],
    );
    // Longer than the discovery deadline: a per-RPC timeout cannot mask it.
    config.request_timeout = Duration::from_secs(30);
    let result = timeout(Duration::from_secs(25), async {
        let backend = ElectrumBackend::connect(config).await.unwrap();
        assert!(backend
            .capabilities()
            .is_usable(Capability::OutpointSpenderLookup));
        assert!(backend.supports(ChainOperation::OutpointSpender));
        backend
            .execute(&ChainRequest::OutpointSpender {
                txid: TARGET,
                vout: VOUT,
                script_pubkey: SCRIPT.to_vec(),
                from_height,
            })
            .await
    })
    .await;
    let _ = stop.send(());
    let calls = server.await.expect("mock server must not fail silently");
    let result = result.expect("discovery must finish within its 20-second deadline");
    let fetched = fetches(&calls);
    assert!(
        fetched.len() <= 128,
        "global download budget: {}",
        fetched.len()
    );
    assert_eq!(
        fetched.len(),
        fetched.iter().collect::<BTreeSet<_>>().len(),
        "deduplicate transaction downloads across all three sources"
    );
    (result, calls)
}

/// Every transaction requested, including ancestors a server does not know.
fn fetches(calls: &[Value]) -> Vec<&str> {
    calls
        .iter()
        .filter(|call| call["method"] == "blockchain.transaction.get")
        .map(|call| call["params"][0].as_str().unwrap())
        .collect()
}

/// The requests for transactions other than the unknown funding parent.
fn downloads(calls: &[Value]) -> Vec<&str> {
    let funding = display_hash(FUNDING);
    fetches(calls)
        .into_iter()
        .filter(|hash| *hash != funding)
        .collect()
}

fn assert_queries(calls: &[Value], ranged: bool, from_height: Option<u32>, with_history: bool) {
    let hash = display_hash(Sha256::digest(SCRIPT).into());
    let positions: Vec<_> = METHODS
        .iter()
        .map(|method| calls.iter().position(|call| call["method"] == *method))
        .collect();
    let unspent = positions[UNSPENT].expect("missing listunspent");
    for source in [HISTORY, MEMPOOL] {
        assert_eq!(
            positions[source].is_some(),
            with_history,
            "{}",
            METHODS[source]
        );
        if let Some(position) = positions[source] {
            assert!(unspent < position);
        }
    }
    for call in calls
        .iter()
        .filter(|call| METHODS.contains(&call["method"].as_str().unwrap()))
    {
        let expected = if call["method"] == METHODS[HISTORY] && ranged {
            json!([hash, from_height.unwrap_or(0), -1])
        } else {
            json!([hash])
        };
        assert_eq!(call["params"], expected);
    }
}

fn assert_spender(
    result: Result<BackendObservation, ChainBackendError>,
    expected: Option<(&[u8], Option<u32>)>,
) {
    assert_spender_via(result, expected, &[]);
}

/// `descendants` are the walked-back transactions, nearest the spender first.
fn assert_spender_via(
    result: Result<BackendObservation, ChainBackendError>,
    expected: Option<(&[u8], Option<u32>)>,
    descendants: &[(&[u8], Option<u32>)],
) {
    let observed = |(raw, block_height): (&[u8], Option<u32>)| ObservedTransaction {
        txid: sha256d(raw),
        raw: raw.to_vec(),
        block_height,
    };
    let observation = result.expect("valid bounded discovery");
    assert_eq!(observation.evidence, Evidence::ServerAssertion);
    assert_eq!(
        observation.payload,
        ChainPayload::OutpointSpender {
            txid: TARGET,
            vout: VOUT,
            spender: expected.map(observed),
            descendants: descendants.iter().copied().map(observed).collect(),
        }
    );
}

#[tokio::test]
async fn successor_at_input_one_needs_no_wallet_refresh() {
    let raw = successor(1);
    let mut mock = Mock::default();
    mock.add(UNSPENT, &raw, 101);
    mock.add(HISTORY, &raw, 101);
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, Some((&raw, Some(101))));
    assert_queries(&calls, true, None, false);
    assert_eq!(downloads(&calls), [display_hash(sha256d(&raw))]);
}

#[tokio::test]
async fn empty_unspent_falls_back_to_history_and_mempool() {
    for (source, height) in [(HISTORY, 101), (MEMPOOL, 0), (MEMPOOL, -1)] {
        let raw = successor(1);
        let mut mock = Mock::default();
        mock.add(source, &raw, height);
        let (result, calls) = query(mock, "1.6", None).await;
        assert_spender(result, Some((&raw, (height > 0).then_some(height as u32))));
        assert_queries(&calls, true, None, true);
        assert_eq!(downloads(&calls).len(), 1);
    }
}

#[tokio::test]
async fn duplicate_candidates_across_all_sources_are_one_spender() {
    let raw = successor(1);
    let mut mock = Mock::default();
    for source in [UNSPENT, HISTORY, MEMPOOL] {
        for _ in 0..3 {
            mock.add(source, &transaction(&[([9; 32], VOUT)], 1000), 0);
        }
    }
    for source in [HISTORY, MEMPOOL] {
        for _ in 0..3 {
            mock.add(source, &raw, 0);
        }
    }
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, Some((&raw, None)));
    assert_queries(&calls, true, None, true);
    assert_eq!(downloads(&calls).len(), 2);
    // The decoy's own parent was asked for once, refused, and skipped.
    assert_eq!(fetches(&calls).len(), 3);
}

#[tokio::test]
async fn absent_or_inexact_inputs_are_unknown() {
    for include_decoys in [false, true] {
        let mut mock = Mock::default();
        if include_decoys {
            let mut reversed = TARGET;
            reversed.reverse();
            // Matching the hash in one input and index in another is insufficient.
            for (marker, inputs) in [
                vec![(TARGET, VOUT + 1)],
                vec![([9; 32], VOUT)],
                vec![(TARGET, VOUT + 1), ([9; 32], VOUT)],
                vec![(reversed, VOUT)],
            ]
            .into_iter()
            .enumerate()
            {
                let raw = transaction(&inputs, marker as u32);
                for source in [UNSPENT, HISTORY, MEMPOOL] {
                    mock.add(source, &raw, 0);
                }
            }
        }
        let (result, calls) = query(mock, "1.6", None).await;
        assert_spender(result, None);
        assert_queries(&calls, true, None, true);
        let mut reversed_hash = TARGET;
        reversed_hash.reverse();
        let reversed_hash = display_hash(reversed_hash);
        let fetched = downloads(&calls);
        assert_eq!(
            fetched
                .iter()
                .filter(|hash| **hash != reversed_hash)
                .count(),
            if include_decoys { 4 } else { 0 }
        );
        // Walking back asks for the unknown parents once each, never for the
        // outpoint's own transaction, and still reports nothing.
        assert_eq!(fetches(&calls).len(), if include_decoys { 6 } else { 0 });
        assert!(!fetches(&calls).contains(&display_hash(TARGET).as_str()));
    }
}

#[tokio::test]
async fn heuristic_downloads_only_thirty_unique_eligible_candidates_then_uses_history() {
    let mut mock = Mock::default();
    let mut eligible = BTreeSet::new();
    let mut old = BTreeSet::new();
    for marker in 0..31 {
        old.insert(mock.add(UNSPENT, &successor(marker), 99));
        let raw = transaction(&[([9; 32], VOUT)], 100 + marker);
        eligible.insert(mock.add(UNSPENT, &raw, 100));
        mock.add(UNSPENT, &raw, 100);
    }
    let raw = successor(1000);
    let expected_hash = mock.add(HISTORY, &raw, 100);
    let (result, calls) = query(mock, "1.6", Some(100)).await;
    assert_spender(result, Some((&raw, Some(100))));
    assert_queries(&calls, true, Some(100), true);
    let fetched = downloads(&calls);
    assert_eq!(
        fetched
            .iter()
            .filter(|hash| eligible.contains(**hash))
            .count(),
        30
    );
    assert!(fetched.iter().all(|hash| !old.contains(*hash)));
    assert!(fetched.contains(&expected_hash.as_str()));
    assert_eq!(fetched.len(), 31);
}

#[tokio::test]
async fn global_download_limit_is_128_without_a_match() {
    for count in [128, 129] {
        let mut mock = Mock::default();
        for marker in 0..count {
            let decoy = transaction(&[([9; 32], VOUT)], marker);
            if marker < 30 {
                mock.add(UNSPENT, &decoy, 0);
            }
            mock.add(HISTORY, &decoy, 0);
            mock.add(HISTORY, &decoy, 0);
            mock.add(MEMPOOL, &decoy, 0);
        }
        let (result, calls) = query(mock, "1.6", None).await;
        assert_spender(result, None);
        assert_queries(&calls, true, None, true);
        assert_eq!(downloads(&calls).len(), 128);
    }
}

#[tokio::test]
async fn exact_candidate_returns_after_pipelined_batch_without_downloading_large_history() {
    let raw = successor(1000);
    let mut mock = Mock {
        pipeline_width: 16,
        ..Mock::default()
    };
    let mut expected = BTreeSet::new();
    expected.insert(mock.add(UNSPENT, &raw, 0));
    for marker in 0..15 {
        expected.insert(mock.add(UNSPENT, &transaction(&[([9; 32], VOUT)], marker), 0));
    }
    for marker in 100..229 {
        mock.add(HISTORY, &transaction(&[([9; 32], VOUT)], marker), 0);
    }
    // An unobserved conflict in a later phase must not force scanning that phase.
    mock.add(HISTORY, &successor(1001), 0);
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, Some((&raw, None)));
    assert_queries(&calls, true, None, false);
    assert_eq!(
        downloads(&calls)
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>(),
        expected
    );
}

#[tokio::test]
async fn history_candidate_returns_after_first_batch_despite_more_than_128_decoys() {
    let raw = successor(1000);
    let candidate_txid = sha256d(&raw);
    let mut mock = Mock {
        pipeline_width: 64,
        ..Mock::default()
    };
    let candidate_hash = mock.add(HISTORY, &raw, 101);
    // Internal hash order puts the exact candidate in the first fetched batch.
    for decoy in (0..u32::MAX)
        .map(|marker| transaction(&[([9; 32], VOUT)], marker))
        .filter(|raw| sha256d(raw) > candidate_txid)
        .take(129)
    {
        mock.add(HISTORY, &decoy, 101);
    }
    assert_eq!(mock.lists[HISTORY].len(), 130);
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, Some((&raw, Some(101))));
    assert_queries(&calls, true, None, true);
    let fetched = downloads(&calls);
    assert_eq!(fetched.len(), 64);
    assert!(fetched.contains(&candidate_hash.as_str()));
}

#[tokio::test]
async fn raw_transactions_must_be_hash_bound_and_well_formed_in_every_source() {
    let raw = successor(1);
    let mut trailing = raw.clone();
    trailing.push(0);
    let truncated = &raw[..raw.len() - 1];
    for source in [UNSPENT, HISTORY, MEMPOOL] {
        for (advertised, response) in [
            (sha256d(&raw), json!(hex::encode(successor(2)))),
            (sha256d(&raw), json!("0")),
            (sha256d(&raw), json!("zz")),
            (sha256d(&raw), json!({"hex": hex::encode(&raw)})),
            (sha256d(truncated), json!(hex::encode(truncated))),
            (sha256d(&trailing), json!(hex::encode(&trailing))),
        ] {
            let mut mock = Mock::default();
            mock.add(source, &raw, 0);
            let hash = display_hash(advertised);
            mock.lists[source][0]["tx_hash"] = json!(hash);
            mock.transactions.insert(hash, response);
            let (result, _) = query(mock, "1.6", None).await;
            assert!(
                matches!(result, Err(ChainBackendError::InvalidResponse(_))),
                "malformed/hash-mismatched candidate from {}: {result:?}",
                METHODS[source]
            );
        }
    }
}

#[tokio::test]
async fn distinct_exact_spenders_in_the_same_fetched_batch_are_ambiguous() {
    for (first, second) in [
        (UNSPENT, UNSPENT),
        (HISTORY, HISTORY),
        (HISTORY, MEMPOOL),
        (MEMPOOL, MEMPOOL),
    ] {
        let mut mock = Mock {
            pipeline_width: 2,
            ..Mock::default()
        };
        mock.add(first, &successor(1), 0);
        mock.add(second, &successor(2), 0);
        let (result, calls) = query(mock, "1.6", None).await;
        assert!(
            matches!(result, Err(ChainBackendError::InvalidResponse(_))),
            "{result:?}"
        );
        assert_queries(&calls, true, None, first != UNSPENT);
        assert_eq!(downloads(&calls).len(), 2);
    }
}

#[tokio::test]
async fn height_filter_and_history_parameters_follow_negotiated_protocol() {
    for (protocol, ranged) in [
        ("1.4", false),
        ("1.5", false),
        ("1.5.1", true),
        ("1.6", true),
    ] {
        for (source, height) in [(HISTORY, 100), (MEMPOOL, 0), (MEMPOOL, -1)] {
            let mut mock = Mock::default();
            let old = successor(1);
            let old_hash = mock.add(UNSPENT, &old, 99);
            mock.add(HISTORY, &old, 99);
            let raw = successor(2);
            mock.add(source, &raw, height);
            let (result, calls) = query(mock, protocol, Some(100)).await;
            assert_spender(result, Some((&raw, (height > 0).then_some(height as u32))));
            assert_queries(&calls, ranged, Some(100), true);
            assert!(!downloads(&calls).contains(&old_hash.as_str()));
            assert_eq!(downloads(&calls).len(), 1);
        }
        let (result, calls) = query(Mock::default(), protocol, None).await;
        assert_spender(result, None);
        assert_queries(&calls, ranged, None, true);
    }
}

#[tokio::test]
async fn reconnect_uses_current_protocol_for_history_parameters() {
    for (initial, reconnected, ranged) in [("1.6", "1.4", false), ("1.4", "1.5.1", true)] {
        let raw = successor(1);
        let mut mock = Mock {
            reconnect_protocol: Some(reconnected),
            close_after_probe: true,
            ..Mock::default()
        };
        mock.add(HISTORY, &raw, 100);
        let (result, calls) = query(mock, initial, Some(100)).await;
        assert_spender(result, Some((&raw, Some(100))));
        assert_queries(&calls, ranged, Some(100), true);
        assert!(
            calls
                .iter()
                .filter(|call| call["method"] == "server.version")
                .count()
                >= 2
        );
    }
}

#[tokio::test]
async fn decoded_byte_budget_is_two_mib_across_both_phases() {
    // Each script fits 10 KiB. Several outputs make each transaction ~270 KiB.
    let script = vec![0x61; 9000];
    for count in [6, 20] {
        let mut mock = Mock {
            allow_disconnect: count == 20,
            ..Mock::default()
        };
        let mut sizes = BTreeMap::new();
        let mut total_bytes = 0;
        for marker in 0..count {
            let decoy = transaction_with_outputs(&[([9; 32], VOUT)], marker, &script, 30);
            total_bytes += decoy.len();
            if marker < 3 {
                mock.add(UNSPENT, &decoy, 0);
            }
            sizes.insert(mock.add(HISTORY, &decoy, 0), decoy.len());
            mock.add(MEMPOOL, &decoy, 0);
        }
        assert!(
            total_bytes > 1024 * 1024,
            "also catches counting hex instead of bytes"
        );
        assert_eq!(total_bytes <= 2 * 1024 * 1024, count == 6);
        let (result, calls) = query(mock, "1.6", None).await;
        assert_spender(result, None);
        assert_queries(&calls, true, None, true);
        if count == 6 {
            assert_eq!(downloads(&calls).len(), 6);
        } else {
            let fetched = downloads(&calls);
            assert!(
                fetched.len() < count as usize,
                "byte exhaustion must stop further downloads"
            );
            assert!(
                fetched.iter().map(|hash| sizes[*hash]).sum::<usize>() >= 2 * 1024 * 1024,
                "the mock must reach the byte budget"
            );
        }
    }
}

#[tokio::test]
async fn twenty_second_deadline_is_global_despite_rpc_progress() {
    let mut mock = Mock {
        transaction_delay: Duration::from_secs(6),
        ..Mock::default()
    };
    mock.add(UNSPENT, &transaction(&[([9; 32], VOUT)], 1000), 0);
    for marker in 0..4 {
        mock.add(HISTORY, &transaction(&[([9; 32], VOUT)], marker), 0);
    }
    let started = Instant::now();
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, None);
    assert_queries(&calls, true, None, true);
    assert!(started.elapsed() >= Duration::from_secs(20));
    assert!(started.elapsed() < Duration::from_secs(25));
    assert!(
        downloads(&calls).len() >= 3,
        "short successful RPCs precede the deadline"
    );
}

#[tokio::test]
async fn a_descendant_still_at_the_address_leads_back_to_the_spender() {
    // The spender's change was spent on; only that later transaction still
    // has an output at the address. The history is never needed.
    let spender = transaction_with_outputs(&[(FUNDING, 0), (TARGET, VOUT)], 1, SCRIPT, 2);
    let change = transaction(&[(sha256d(&spender), 1)], 2);
    let mut mock = Mock::default();
    mock.transactions.insert(
        display_hash(sha256d(&spender)),
        json!(hex::encode(&spender)),
    );
    mock.add(UNSPENT, &change, 120);
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender_via(result, Some((&spender, None)), &[(&change, Some(120))]);
    assert_queries(&calls, true, None, false);
    assert_eq!(
        fetches(&calls),
        [
            display_hash(sha256d(&change)),
            display_hash(sha256d(&spender)),
        ]
    );
}

#[tokio::test]
async fn an_authchain_ending_at_the_address_walks_back_past_the_depth_limit() {
    // rnbrady's forward-walk entry: the identity output at the end of the
    // chain is unspent at this address, and following output-0 links back
    // from it finds the spender and every hop between, in one pass.
    let spender = transaction(&[(FUNDING, 0), (TARGET, VOUT)], 1);
    let mut chain = vec![spender.clone()];
    for marker in 2..6 {
        let parent = sha256d(chain.last().unwrap());
        chain.push(transaction(&[(parent, 0)], marker));
    }
    // The head also carries a coinbase-shaped input, which is never fetched.
    let head = transaction(
        &[(sha256d(chain.last().unwrap()), 0), ([0; 32], u32::MAX)],
        6,
    );
    chain.push(head.clone());
    let mut mock = Mock::default();
    for raw in &chain[..chain.len() - 1] {
        mock.transactions
            .insert(display_hash(sha256d(raw)), json!(hex::encode(raw)));
    }
    mock.add(UNSPENT, &head, 130);
    let (result, calls) = query(mock, "1.6", None).await;
    let descendants: Vec<(&[u8], Option<u32>)> = chain[1..]
        .iter()
        .map(|raw| (raw.as_slice(), (raw == &head).then_some(130)))
        .collect();
    assert_spender_via(result, Some((&spender, None)), &descendants);
    assert_queries(&calls, true, None, false);
    // Five links back is deeper than the three-hop limit for other inputs.
    assert_eq!(fetches(&calls).len(), chain.len());
    assert!(!fetches(&calls).contains(&display_hash([0; 32]).as_str()));
}

#[tokio::test]
async fn walks_along_other_outputs_stop_after_three_hops() {
    // Each link spends output 1, so this is not an authchain: the walk gives
    // up after three hops and the history scan finds the spender instead.
    let spender = transaction_with_outputs(&[(FUNDING, 0), (TARGET, VOUT)], 1, SCRIPT, 2);
    let mut chain = vec![spender.clone()];
    for marker in 2..6 {
        let parent = sha256d(chain.last().unwrap());
        chain.push(transaction_with_outputs(&[(parent, 1)], marker, SCRIPT, 2));
    }
    let mut mock = Mock::default();
    for raw in &chain[1..chain.len() - 1] {
        mock.transactions
            .insert(display_hash(sha256d(raw)), json!(hex::encode(raw)));
    }
    mock.add(UNSPENT, chain.last().unwrap(), 140);
    mock.add(HISTORY, &spender, 101);
    let (result, calls) = query(mock, "1.6", None).await;
    assert_spender(result, Some((&spender, Some(101))));
    assert_queries(&calls, true, None, true);
    // The unspent transaction and three ancestors, then the history entry.
    let fetched = fetches(&calls);
    assert_eq!(fetched.len(), 5);
    assert_eq!(fetched[4], display_hash(sha256d(&spender)));
}
