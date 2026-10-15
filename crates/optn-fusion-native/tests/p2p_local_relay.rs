//! Whole P2P CashFusion rounds through a real Nostr relay.
//!
//! Every peer is a full host: its own relay connections, pool announcements
//! signed with its round key, NIP-17 gift wraps, a one-shot connection per
//! anonymous component, the desktop's gather policy, the rendezvous and the
//! round. Only the relay (nostr-sdk's in-process relay) and the wallet side
//! (reserving outputs, broadcasting) are stand-ins.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use nostr_sdk::prelude::{LocalRelay, RateLimit};
use optn_fusion::p2p::assemble::{assemble, verify_final};
use optn_fusion::p2p::credentials::random_scalar;
use optn_fusion::p2p::wire::{InputRef, OutputRef, PoolNetwork};
use optn_fusion_native::p2p_round::{
    run_p2p, Broadcaster, OutputReserver, P2pCoins, P2pCore, P2pFused, WalletFuture,
};
use optn_nostr::RelayRoute;
use zeroize::Zeroizing;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Random bytes, drawn without a zeroed placeholder for code scanning to
/// follow into the keys built from them (see `optn_fusion::p2p::random_bytes`).
fn random_bytes<const N: usize>() -> [u8; N] {
    use rand_core::{OsRng, RngCore};
    std::array::from_fn(|_| OsRng.next_u32() as u8)
}

/// Fresh P2PKH scripts, remembered so the test can find them in the fusion.
struct Reserver(Arc<Mutex<Vec<Vec<u8>>>>);

impl OutputReserver for Reserver {
    fn reserve(&self, count: usize) -> WalletFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async move {
            let scripts: Vec<Vec<u8>> = (0..count)
                .map(|_| {
                    [
                        vec![0x76, 0xa9, 0x14],
                        random_bytes::<20>().to_vec(),
                        vec![0x88, 0xac],
                    ]
                    .concat()
                })
                .collect();
            self.0.lock().unwrap().extend(scripts.clone());
            Ok(scripts)
        })
    }
}

/// Records what would have gone to the network.
struct Network(Arc<Mutex<Vec<Vec<u8>>>>);

impl Broadcaster for Network {
    fn broadcast(&self, raw: Vec<u8>) -> WalletFuture<'_, String> {
        Box::pin(async move {
            let mut txid = optn_core::header_hash::sha256d(&raw);
            txid.reverse();
            self.0.lock().unwrap().push(raw);
            Ok(hex(&txid))
        })
    }
}

fn coins() -> P2pCoins {
    let inputs_and_keys: Vec<(InputRef, (String, [u8; 32]))> =
        (0..1 + random_bytes::<1>()[0] as usize % 2)
            .map(|index| {
                let scalar = random_scalar();
                let pubkey = hex(&optn_core::fusion::schnorr::pubkey_compressed(scalar));
                (
                    InputRef {
                        prev_txid: hex(&random_bytes::<32>()),
                        prev_index: index as u32,
                        value: 150_000 + u64::from(random_bytes::<1>()[0]) * 500,
                        pubkey: pubkey.clone(),
                    },
                    (pubkey, scalar.to_bytes().into()),
                )
            })
            .collect();
    P2pCoins {
        inputs: inputs_and_keys
            .iter()
            .map(|(input, _)| input.clone())
            .collect(),
        keys: Zeroizing::new(inputs_and_keys.into_iter().map(|(_, key)| key).collect()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ten_rust_peers_gather_agree_and_fuse_over_a_relay() {
    // A ten-wallet coordinator publishes about 220 control-plane events on its
    // one connection in the round's first minute: proposal resends, twelve
    // rounds of `onion_declare` to every peeler, then params, responses,
    // `assembled` and `final` (the desktop coordinator keeps the same
    // cadence). nostr-sdk's local relay allows 60 per connection per minute
    // by default and refuses the rest, so the limit is set above that load
    // here; this test is about the host and the protocol, not that budget.
    let relay = LocalRelay::builder()
        .rate_limit(RateLimit {
            max_reqs: 500,
            notes_per_minute: 1_200,
        })
        .build();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();

    let reserved = Arc::new(Mutex::new(Vec::new()));
    let broadcasts = Arc::new(Mutex::new(Vec::new()));
    let mut all_inputs = Vec::new();
    let mut peers = Vec::new();
    for peer in 0..10 {
        let coins = coins();
        all_inputs.extend(coins.inputs.clone());
        let core = P2pCore {
            network: PoolNetwork::Chipnet,
            relays: vec![url.clone()],
            route: RelayRoute::LocalOnly,
            auto: false,
        };
        let (reserved, broadcasts) = (reserved.clone(), broadcasts.clone());
        peers.push(tokio::spawn(async move {
            let id = format!("local-relay-test-{}-{peer}", std::process::id());
            optn_fusion::round_cancel::prepare_round(&id).unwrap();
            let registration = optn_fusion::round_cancel::acquire_round(&id).unwrap();
            run_p2p(
                &core,
                coins,
                &Reserver(reserved),
                Arc::new(Network(broadcasts)),
                &registration.flag(),
                &move |line: &str| eprintln!("[{peer}] {line}"),
            )
            .await
        }));
    }
    let mut results: Vec<P2pFused> = Vec::new();
    let outcomes: Vec<Result<P2pFused, String>> = futures::future::join_all(peers)
        .await
        .into_iter()
        .map(|joined| joined.unwrap())
        .collect();
    for (peer, outcome) in outcomes.iter().enumerate() {
        if let Err(error) = outcome {
            eprintln!("[{peer}] FAILED {error}");
        }
    }
    for outcome in outcomes {
        results.push(outcome.expect("every peer fuses"));
    }

    let txids: HashSet<&str> = results
        .iter()
        .map(|fused| fused.result.txid.as_str())
        .collect();
    assert_eq!(txids.len(), 1, "one transaction for everyone");
    let fused = &results[0].result;
    assert!(
        !broadcasts.lock().unwrap().is_empty(),
        "the coordinator broadcast it"
    );

    // Rebuild the template from what the peers put in and what came out, and
    // check the transaction everyone fused against it, signatures included.
    let raw = optn_core::payment::decode_hex(&fused.tx_hex).unwrap();
    let decoded = optn_core::tx::decode(&raw).unwrap();
    let outputs: Vec<OutputRef> = decoded
        .outputs
        .iter()
        .map(|output| OutputRef {
            script: hex(&output.script_pubkey),
            value: output.value,
        })
        .collect();
    let template = assemble([(&all_inputs[..], &outputs[..])]).unwrap();
    assert_eq!(
        verify_final(&template, &fused.tx_hex, &fused.txid).unwrap(),
        fused.txid
    );
    assert_eq!(
        template.inputs.len(),
        all_inputs.len(),
        "every peer's inputs are in it"
    );
    let ours: HashSet<Vec<u8>> = reserved.lock().unwrap().iter().cloned().collect();
    let theirs: HashSet<Vec<u8>> = decoded
        .outputs
        .iter()
        .map(|output| output.script_pubkey.clone())
        .collect();
    assert_eq!(
        ours, theirs,
        "every output is one a peer reserved, and every reserved one is paid"
    );
    for peer in &results {
        assert!(peer.scripts.iter().all(|script| theirs.contains(script)));
    }
}
