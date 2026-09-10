//! Compact filters against the implementation that defines them.
//!
//! BCH's basic filter is what BCHD puts in it -- serialized spent outpoints of
//! non-coinbase inputs, plus every non-empty output script -- not Core's
//! BIP158. That definition only holds if it is checked against filters BCHD
//! actually produced, so this drives the real backend at a real node: probe the
//! genesis filter, walk the cfheaders chain, download the filters, match
//! locally, then pull the full blocks and confirm the coins are there.
//!
//! Opt-in, because it needs a node running. Regtest keeps it hermetic: own
//! chain, own coins, loopback only, no peer discovery.
//!
//! Run:
//!   cargo test --manifest-path crates/optn-chain-neutrino/Cargo.toml \
//!     --test regtest_live -- --ignored --nocapture
//!
//! The node setup is the same one the BIP37 crate's `regtest_live` documents;
//! BCHD serves compact filters by default, so no extra flag is needed. Set
//! `OPTN_REGTEST_P2P` if it is not on `127.0.0.1:18444`.

use std::sync::Arc;

use optn_chain_neutrino::{genesis_hash, NeutrinoBackend, NeutrinoConfig};
use optn_core::hd::{address_path, Wallet, BIP39_TEST_VECTOR_MNEMONIC};
use optn_core::network::Network;
use optn_runtime::chain::{BlockHeaderBytes, Endpoint, EndpointKind, SourceId};
use optn_runtime::chain_service::{ChainBackend, ChainPayload, ChainRequest, WalletInterest};
use optn_runtime::header_store::{BlockHeaderSource, SharedHeaders};
use optn_runtime::header_view::VerifiedHeaderView;

fn endpoint() -> Endpoint {
    let raw = std::env::var("OPTN_REGTEST_P2P").unwrap_or_else(|_| "127.0.0.1:18444".into());
    let (host, port) = raw.rsplit_once(':').expect("OPTN_REGTEST_P2P is host:port");
    Endpoint {
        kind: EndpointKind::BchP2p,
        host: host.to_owned(),
        port: Some(port.parse().expect("a port number")),
    }
}

/// The same wallet the BIP37 test uses, so both paths are looking for the
/// same coins on the same chain.
fn wallet_script() -> (String, Vec<u8>) {
    let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
        .expect("the published test mnemonic parses");
    let address = wallet
        .address(Network::Regtest, &address_path(1, 0, false, 0))
        .expect("the first receive address derives");
    (address.encode(), address.script_pubkey())
}

fn outputs(raw: &[u8]) -> Vec<(u64, Vec<u8>)> {
    let mut pos = 4usize; // version
    let inputs = varint(raw, &mut pos);
    for _ in 0..inputs {
        pos += 36; // outpoint
        let len = varint(raw, &mut pos) as usize;
        pos += len + 4; // scriptSig, then sequence
    }
    let count = varint(raw, &mut pos);
    let mut found = Vec::new();
    for _ in 0..count {
        let value = u64::from_le_bytes(raw[pos..pos + 8].try_into().expect("an output value"));
        pos += 8;
        let len = varint(raw, &mut pos) as usize;
        found.push((value, raw[pos..pos + len].to_vec()));
        pos += len;
    }
    found
}

/// The accepted chain, seeded with genesis and nothing else assumed.
fn seeded_store(network: &str) -> Arc<SharedHeaders> {
    let store = Arc::new(SharedHeaders::default());
    store.write(|retained| retained.insert_hash_only(0, genesis_hash(network)));
    store
}

fn varint(raw: &[u8], pos: &mut usize) -> u64 {
    let first = raw[*pos];
    *pos += 1;
    match first {
        0xfd => {
            let value = u16::from_le_bytes(raw[*pos..*pos + 2].try_into().unwrap()) as u64;
            *pos += 2;
            value
        }
        0xfe => {
            let value = u32::from_le_bytes(raw[*pos..*pos + 4].try_into().unwrap()) as u64;
            *pos += 4;
            value
        }
        0xff => {
            let value = u64::from_le_bytes(raw[*pos..*pos + 8].try_into().unwrap());
            *pos += 8;
            value
        }
        small => small as u64,
    }
}

#[tokio::test]
#[ignore = "requires a local regtest node; see the module docs for how to start one"]
async fn a_wallet_finds_its_own_coins_through_bchd_filters() {
    let (address, script) = wallet_script();
    println!("wallet address: {address}");

    // Connecting runs the genesis-filter probe. If OPTN and the node disagreed
    // about which chain this is, the probe would find nothing to commit to and
    // the capability would come back unusable rather than wrong.
    let store = seeded_store("regtest");
    let backend = NeutrinoBackend::connect(
        NeutrinoConfig::new(SourceId::new("regtest-neutrino"), endpoint(), "regtest"),
        store.clone() as Arc<dyn BlockHeaderSource>,
    )
    .await
    .expect("the node accepts a connection and the genesis filter commits");
    assert!(
        backend.probe().serves_compact_filters,
        "the node must serve compact filters; start it without --nocfilters"
    );

    // The provider hands back headers and stores nothing. Verification and
    // acceptance happen here, exactly as the runtime does them, and only what
    // is accepted becomes the chain the scan below runs against.
    let verifier = optn_runtime::header_verifier::regtest_header_verifier()
        .expect("the regtest verifier anchors at genesis");
    let mut view = VerifiedHeaderView::with_anchor_interval(Network::Regtest, verifier, 16);
    let mut next = 1u32;
    loop {
        let observation = backend
            .execute(&ChainRequest::HeaderSync {
                start_height: next,
                count: 2000,
            })
            .await
            .expect("the node answers getheaders");
        let ChainPayload::Headers {
            start_height,
            headers,
        } = observation.payload
        else {
            panic!("expected a Headers payload");
        };
        if headers.is_empty() {
            break;
        }
        let batch: Vec<BlockHeaderBytes> = headers.iter().copied().map(BlockHeaderBytes).collect();
        view.extend(&batch).expect("live headers verify");
        store.write(|retained| {
            for (offset, header) in batch.iter().enumerate() {
                retained
                    .insert_verified(start_height + offset as u32, header.clone())
                    .expect("verified headers link");
            }
        });
        next = start_height + batch.len() as u32;
        if batch.len() < 2000 {
            break;
        }
    }
    let (tip_height, _) = store.tip().expect("a tip after syncing");
    assert!(
        tip_height > 0,
        "no blocks to scan; mine some to {address} first"
    );
    // One accepted chain: the filter scan reads the same heights the verifier
    // accepted, so a disagreement here means the provider is answering from
    // somewhere else.
    assert_eq!(
        view.verifier().state().expect("accumulator state").height,
        tip_height,
        "the accumulator and the accepted store disagree about how many blocks exist"
    );

    let observation = backend
        .execute(&ChainRequest::WalletRefresh {
            interests: vec![WalletInterest::script(script.clone())],
            from_height: Some(1),
        })
        .await
        .expect("the compact-filter scan completes");
    let ChainPayload::WalletRefresh { transactions, tip } = observation.payload else {
        panic!("expected a WalletRefresh payload");
    };

    // Finding nothing is the failure this test exists to catch: it is what
    // happens when OPTN's idea of a filter entry differs from BCHD's.
    assert!(
        !transactions.is_empty(),
        "compact filters matched nothing; mine blocks to {address} first, \
         and if there are blocks then the filter entry set disagrees with BCHD"
    );
    assert_eq!(
        tip.map(|tip| tip.height),
        Some(tip_height),
        "the refresh reported a different tip than the header sync reached"
    );

    let mut total = 0u64;
    for transaction in &transactions {
        let paid: u64 = outputs(&transaction.raw)
            .into_iter()
            .filter(|(_, output)| *output == script)
            .map(|(value, _)| value)
            .sum();
        // A GCS filter has false positives, and the backend downloads the full
        // block before believing one. Anything that reaches here paying nothing
        // means the local match, not the filter, is wrong.
        assert!(
            paid > 0,
            "a matched transaction paid this wallet nothing: {}",
            transaction
                .txid
                .iter()
                .rev()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert!(
            transaction
                .block_height
                .is_some_and(|height| height >= 1 && height <= tip_height),
            "a matched transaction was attributed outside the scanned range"
        );
        total += paid;
    }
    println!(
        "{} transactions, {total} sats across blocks 1..={tip_height}",
        transactions.len()
    );
}

/// A wrong chain must report a wrong chain, not a missing capability.
///
/// Asking a regtest node to speak for mainnet is the shape of the bug this
/// path had: the parameters knew the network, the genesis table did not, and
/// the mismatch surfaced as "this node cannot do compact filters".
#[tokio::test]
#[ignore = "requires a local regtest node; see the module docs for how to start one"]
async fn a_regtest_node_does_not_answer_for_mainnet() {
    let store = seeded_store("mainnet");
    let result = NeutrinoBackend::connect(
        NeutrinoConfig::new(SourceId::new("regtest-as-mainnet"), endpoint(), "mainnet"),
        store as Arc<dyn BlockHeaderSource>,
    )
    .await;
    match result {
        // The magic bytes differ, so this normally fails in the handshake.
        Err(_) => {}
        Ok(backend) => assert!(
            !backend
                .capabilities()
                .is_usable(optn_runtime::chain::Capability::CompactFilters),
            "a regtest node reported working mainnet compact filters"
        ),
    }
}
