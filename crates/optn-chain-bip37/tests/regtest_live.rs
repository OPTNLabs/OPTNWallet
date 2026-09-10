//! The BIP37 path against a real node, on a private chain.
//!
//! Opt-in, because it needs a node running. Nothing here is mocked: headers
//! come off a socket and through the same verifier the wallet uses, the shared
//! header store is the one the runtime owns, and the scan is the real Bloom
//! path. Regtest keeps it hermetic -- own chain, own coins, loopback only, no
//! peer discovery, and no resemblance to a network anyone relies on.
//!
//! Run:
//!   cargo test --manifest-path crates/optn-chain-bip37/Cargo.toml \
//!     --test regtest_live -- --ignored --nocapture
//!
//! A node to run it against, using BCHD:
//!
//!   # the address these tests derive, printed by the first assertion below
//!   bchd --regtest --datadir=<isolated dir> \
//!        --rpcuser=<user> --rpcpass=<pass> \
//!        --rpclisten=127.0.0.1:18443 --listen=127.0.0.1:18444 \
//!        --notls --nodnsseed --addrindex --txindex \
//!        --miningaddr=<that address>
//!   bchctl --notls -u <user> -P <pass> -s 127.0.0.1:18443 generate 120
//!
//! `--nodnsseed` and the loopback listeners are the point: this node must not
//! find peers and must not be reachable off the machine. Set `OPTN_REGTEST_P2P`
//! if the node is not on the default `127.0.0.1:18444`.

use std::sync::Arc;

use optn_chain_bip37::{genesis_hash, Bip37Backend, Bip37Config};
use optn_core::hd::{address_path, Wallet, BIP39_TEST_VECTOR_MNEMONIC};
use optn_core::network::Network;
use optn_runtime::chain::{BlockHeaderBytes, Endpoint, EndpointKind, SourceId};
use optn_runtime::chain_service::{ChainBackend, ChainPayload, ChainRequest, WalletInterest};
use optn_runtime::header_store::{BlockHeaderSource, SharedHeaders};
use optn_runtime::header_view::VerifiedHeaderView;

const NETWORK: &str = "regtest";
/// Anchors often enough that a short chain still exercises the index.
const ANCHOR_INTERVAL: u32 = 16;

fn endpoint() -> Endpoint {
    let raw = std::env::var("OPTN_REGTEST_P2P").unwrap_or_else(|_| "127.0.0.1:18444".into());
    let (host, port) = raw.rsplit_once(':').expect("OPTN_REGTEST_P2P is host:port");
    Endpoint {
        kind: EndpointKind::BchP2p,
        host: host.to_owned(),
        port: Some(port.parse().expect("a port number")),
    }
}

/// The wallet under test: a published BIP39 vector, first receive address.
///
/// Regtest shares testnet's SLIP-44 coin type. This is a test vector on a
/// private chain, so the coins it finds are worth nothing anywhere.
fn wallet_script() -> (String, Vec<u8>) {
    let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
        .expect("the published test mnemonic parses");
    let address = wallet
        .address(Network::Regtest, &address_path(1, 0, false, 0))
        .expect("the first receive address derives");
    (address.encode(), address.script_pubkey())
}

/// Genesis, and nothing else assumed.
fn seeded_store() -> Arc<SharedHeaders> {
    let store = Arc::new(SharedHeaders::default());
    store.write(|retained| retained.insert_hash_only(0, genesis_hash(NETWORK)));
    store
}

/// Pull the whole chain in, verifying every batch before it is accepted.
async fn sync_headers(backend: &Bip37Backend, store: &SharedHeaders) -> VerifiedHeaderView {
    let verifier = optn_runtime::header_verifier::regtest_header_verifier()
        .expect("the regtest verifier anchors at genesis");
    let mut view =
        VerifiedHeaderView::with_anchor_interval(Network::Regtest, verifier, ANCHOR_INTERVAL);
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
        // Linkage, declared proof-of-work, and the network's difficulty rule.
        // The provider deliberately does not do this, and deliberately does not
        // write to the store: that is the runtime's job.
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
    view
}

/// Outputs of a transaction: enough to total what it paid the wallet.
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

/// Seed phrase to balance, with a real node in the middle.
#[tokio::test]
#[ignore = "requires a local regtest node; see the module docs for how to start one"]
async fn a_wallet_finds_its_own_coins_over_bip37() {
    let (address, script) = wallet_script();
    println!("wallet address: {address}");

    let store = seeded_store();
    let backend = Bip37Backend::connect(
        Bip37Config::new(SourceId::new("regtest-live"), endpoint(), NETWORK),
        store.clone() as Arc<dyn BlockHeaderSource>,
    )
    .await
    .expect("the regtest node accepts a connection");
    assert!(
        backend.probe().serves_bloom,
        "the node must serve BIP37; start it without --nopeerbloomfilters"
    );

    let view = sync_headers(&backend, &store).await;
    let (tip_height, _) = store.tip().expect("a tip after syncing");
    assert!(
        tip_height > 0,
        "no blocks to scan; mine some to {address} first"
    );
    // The accumulator numbers leaves by height, so agreeing with the store is
    // what says the sync was attributed correctly rather than merely accepted.
    assert_eq!(
        view.verifier().state().expect("accumulator state").height,
        tip_height,
        "the accumulator and the store disagree about how many blocks exist"
    );
    assert_eq!(
        view.tip(),
        store.tip(),
        "verified tip and stored tip differ"
    );

    // The scan. Every merkleblock is checked against the block hash the store
    // accepted, and every transaction against the proof that block committed
    // to, so a peer cannot answer with a block of its own invention.
    let observation = backend
        .execute(&ChainRequest::WalletRefresh {
            interests: vec![WalletInterest::script(script.clone())],
            from_height: Some(1),
        })
        .await
        .expect("the Bloom scan completes");
    let ChainPayload::WalletRefresh { transactions, tip } = observation.payload else {
        panic!("expected a WalletRefresh payload");
    };

    assert!(
        !transactions.is_empty(),
        "no transactions found; mine blocks to {address} first"
    );
    assert_eq!(
        tip.map(|tip| tip.height),
        Some(tip_height),
        "the refresh reported a different tip than the store holds"
    );

    let mut total = 0u64;
    for transaction in &transactions {
        let paid: u64 = outputs(&transaction.raw)
            .into_iter()
            .filter(|(_, output)| *output == script)
            .map(|(value, _)| value)
            .sum();
        // A Bloom filter has false positives; a transaction that pays us
        // nothing at all means the match had nothing to do with this wallet.
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

/// A birth height is a floor, and it is inclusive.
///
/// The wallet asks for a range and gets that range; a provider quietly
/// starting earlier or later would show up here as a different set.
#[tokio::test]
#[ignore = "requires a local regtest node; see the module docs for how to start one"]
async fn a_birth_height_is_an_inclusive_floor() {
    let (_, script) = wallet_script();
    let store = seeded_store();
    let backend = Bip37Backend::connect(
        Bip37Config::new(SourceId::new("regtest-live"), endpoint(), NETWORK),
        store.clone() as Arc<dyn BlockHeaderSource>,
    )
    .await
    .expect("the regtest node accepts a connection");
    sync_headers(&backend, &store).await;
    let (tip_height, _) = store.tip().expect("a tip after syncing");
    assert!(tip_height >= 3, "needs at least a few blocks to compare");

    let scan_from = |height: u32| {
        let backend = &backend;
        let script = script.clone();
        async move {
            let observation = backend
                .execute(&ChainRequest::WalletRefresh {
                    interests: vec![WalletInterest::script(script)],
                    from_height: Some(height),
                })
                .await
                .expect("the Bloom scan completes");
            let ChainPayload::WalletRefresh { transactions, .. } = observation.payload else {
                panic!("expected a WalletRefresh payload");
            };
            transactions
        }
    };

    let from_two = scan_from(2).await;
    assert!(
        from_two.iter().all(|tx| tx.block_height >= Some(2)),
        "a scan from height 2 returned something below it"
    );

    // Whatever sits in block 2 is present starting at 2 and gone starting at 3.
    let from_three = scan_from(3).await;
    let in_block_two: Vec<_> = from_two
        .iter()
        .filter(|tx| tx.block_height == Some(2))
        .map(|tx| tx.txid)
        .collect();
    for txid in in_block_two {
        assert!(
            !from_three.iter().any(|tx| tx.txid == txid),
            "a scan from height 3 still returned a transaction from block 2"
        );
    }
}
