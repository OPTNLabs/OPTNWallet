//! BCHN's ZeroMQ notifications, against BCHN.
//!
//! #75 row 9 says ZMQ is an event and wake-up source and never proof. Both
//! halves of that need a real node to mean anything. A hand-built frame proves
//! the parser reads what the test author believed BCHN sends; only BCHN proves
//! what BCHN sends -- the frame layout, the topic names, the endianness of the
//! sequence counter, and whether a sequence frame is present at all.
//!
//! What is checked here:
//!
//! - a raw block arrives, and the hash this crate computes from its first 80
//!   bytes is the hash the node itself reports for that height. That is the
//!   whole "event, never proof" claim in one assertion: the event carries
//!   enough to *identify* a block, and identifying is not verifying.
//! - `hashtx` and `rawtx` describe the same transaction, so a consumer that
//!   subscribed to one is not seeing a different mempool from one that
//!   subscribed to the other.
//! - sequence numbers advance by one per topic across a run of blocks, which
//!   is what makes a dropped notification detectable rather than silent.
//!
//! Opt-in, because it needs a node running. Regtest keeps it hermetic: own
//! chain, own coins, loopback only.
//!
//! Start one:
//!
//!   docker run -d --name optn-bchn-zmq \
//!     -p 127.0.0.1:18453:18443 -p 127.0.0.1:28332:28332 \
//!     zquestz/bitcoin-cash-node:latest \
//!     bitcoind -regtest -server -listen=0 \
//!       -rpcbind=0.0.0.0 -rpcport=18443 -rpcallowip=0.0.0.0/0 \
//!       -rpcuser=optn -rpcpassword=optnzmqtest \
//!       -zmqpubrawtx=tcp://0.0.0.0:28332 -zmqpubhashtx=tcp://0.0.0.0:28332 \
//!       -zmqpubrawblock=tcp://0.0.0.0:28332 -zmqpubhashblock=tcp://0.0.0.0:28332 \
//!       -fallbackfee=0.00001
//!
//! Run:
//!   cargo test --manifest-path crates/optn-chain-zmq/Cargo.toml \
//!     --test bchn_live -- --ignored --nocapture
//!
//! `OPTN_BCHN_ZMQ` overrides the socket (default `127.0.0.1:28332`) and
//! `OPTN_BCHN_CONTAINER` the container `bitcoin-cli` is run in (default
//! `optn-bchn-zmq`).

use std::process::Command;
use std::time::Duration;

use optn_chain_zmq::{BchnZmqConfig, BchnZmqEventSource};
use optn_runtime::chain::{Endpoint, EndpointKind, SourceId};
use optn_runtime::events::{ChainEventEnvelope, ChainEventKind, ChainEventStream};

fn endpoint() -> Endpoint {
    let raw = std::env::var("OPTN_BCHN_ZMQ").unwrap_or_else(|_| "127.0.0.1:28332".into());
    let (host, port) = raw.rsplit_once(':').expect("OPTN_BCHN_ZMQ is host:port");
    Endpoint {
        kind: EndpointKind::BchnZmq,
        host: host.to_owned(),
        port: Some(port.parse().expect("a port number")),
    }
}

/// `bitcoin-cli` inside the node's own container, so this needs no node
/// binaries or credentials on the host.
fn cli(args: &[&str]) -> String {
    let container =
        std::env::var("OPTN_BCHN_CONTAINER").unwrap_or_else(|_| "optn-bchn-zmq".to_owned());
    let mut command = Command::new("docker");
    command
        .arg("exec")
        .arg(&container)
        .arg("bitcoin-cli")
        .arg("-regtest")
        .arg("-rpcuser=optn")
        .arg("-rpcpassword=optnzmqtest");
    for arg in args {
        command.arg(arg);
    }
    let output = command.output().expect("docker exec bitcoin-cli runs");
    assert!(
        output.status.success(),
        "bitcoin-cli {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("bitcoin-cli prints UTF-8")
        .trim()
        .to_owned()
}

fn new_address() -> String {
    // A wallet exists by default on regtest; create one if this node has none.
    let existing = cli(&["listwallets"]);
    if !existing.contains('"') {
        let _ = Command::new("docker").args(["exec", "x"]).output();
        cli(&["createwallet", "zmqtest"]);
    }
    cli(&["getnewaddress"])
}

fn generate(blocks: u32, address: &str) {
    cli(&["generatetoaddress", &blocks.to_string(), address]);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A display hash is the wire hash reversed.
fn display_hash(hash: [u8; 32]) -> String {
    let mut bytes = hash;
    bytes.reverse();
    hex(&bytes)
}

async fn next(source: &BchnZmqEventSource) -> ChainEventEnvelope {
    tokio::time::timeout(Duration::from_secs(20), source.next_event())
        .await
        .expect("a notification within 20s -- is the node publishing on this socket?")
        .expect("the notification decodes")
}

#[tokio::test]
#[ignore = "requires a local BCHN regtest node with ZMQ; see the module docs"]
async fn a_real_bchn_block_notification_identifies_the_block_the_node_mined() {
    let source = BchnZmqEventSource::connect(BchnZmqConfig {
        source_id: SourceId::new("bchn-regtest"),
        endpoint: endpoint(),
    })
    .await
    .expect("SUB socket connects to the node's ZMQ publisher");

    // A SUB socket that has just connected can miss messages published before
    // the subscription is established, so mine after connecting and keep
    // reading until the block arrives.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let address = new_address();
    generate(1, &address);

    // Matched by hash rather than by arrival order: several tests share one
    // node, so the next rawblock and the next hashblock are not necessarily
    // the same block. Success is one hash reported by both topics.
    let mut from_raw: Vec<String> = Vec::new();
    let mut from_hash: Vec<String> = Vec::new();
    let mut agreed = None;
    for _ in 0..40 {
        let envelope = next(&source).await;
        match envelope.event {
            ChainEventKind::BlockSeen { hash, raw: Some(_) } => {
                from_raw.push(display_hash(hash));
            }
            ChainEventKind::BlockSeen { hash, raw: None } => {
                from_hash.push(display_hash(hash));
            }
            _ => continue,
        }
        if let Some(both) = from_raw.iter().find(|hash| from_hash.contains(hash)) {
            agreed = Some(both.clone());
            break;
        }
    }

    // BCHN's `hash*` topics carry the uint256 reversed relative to everything
    // else on this socket, so agreement here is not a formality: taking the
    // frame as it arrives makes the two topics report byte-reversed hashes of
    // the same block, and the wallet can then match a `hashblock` wake-up
    // against nothing it holds.
    let from_raw = agreed.unwrap_or_else(|| {
        panic!(
            "no block was reported by both topics; rawblock saw {from_raw:?} and              hashblock saw {from_hash:?}"
        )
    });

    // The node itself confirms it knows this block, which is what makes the
    // event an identification rather than an assertion by the publisher.
    // Asked by hash rather than by height on purpose: the tip moves.
    let header = cli(&["getblockheader", &from_raw]);
    assert!(
        header.contains(&from_raw),
        "the node does not know the block it just published: {header}"
    );

    // And the identification stops there. The event says a block exists with
    // this hash; it carries no work, no MMR and no position, so this crate can
    // wake a sync and can never advance authoritative state. That half of row
    // 9 is held by the type, not by an assertion: `ChainEventKind` has no
    // variant that carries verified state, so there is nothing here a consumer
    // could mistake for proof.
}

#[tokio::test]
#[ignore = "requires a local BCHN regtest node with ZMQ; see the module docs"]
async fn rawtx_and_hashtx_describe_the_same_transaction() {
    let source = BchnZmqEventSource::connect(BchnZmqConfig {
        source_id: SourceId::new("bchn-regtest"),
        endpoint: endpoint(),
    })
    .await
    .expect("SUB socket connects");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let address = new_address();
    // Coinbase outputs need 100 confirmations before they are spendable.
    if cli(&["getblockcount"]).parse::<u32>().unwrap_or(0) < 101 {
        generate(101, &address);
    }
    let sent = cli(&["sendtoaddress", &address, "0.001"]);

    let mut from_raw = None;
    let mut from_hash = None;
    // A generous budget: other tests mine against the same node, so this
    // socket also carries their blocks and coinbase transactions.
    for _ in 0..60 {
        let envelope = next(&source).await;
        if let ChainEventKind::TransactionSeen { txid, raw } = envelope.event {
            let display = display_hash(txid);
            if display != sent {
                continue;
            }
            if raw.is_some() {
                from_raw = Some(display);
            } else {
                from_hash = Some(display);
            }
        }
        if from_raw.is_some() && from_hash.is_some() {
            break;
        }
    }

    // `rawtx`'s txid is computed here by double-SHA over the body BCHN sent;
    // `hashtx`'s is read from the node's own frame. Agreement means a consumer
    // subscribed to either topic sees the same mempool.
    assert_eq!(from_raw.as_deref(), Some(sent.as_str()), "rawtx txid");
    assert_eq!(from_hash.as_deref(), Some(sent.as_str()), "hashtx txid");
}

#[tokio::test]
#[ignore = "requires a local BCHN regtest node with ZMQ; see the module docs"]
async fn sequence_numbers_advance_by_one_so_a_dropped_notification_is_detectable() {
    let source = BchnZmqEventSource::connect(BchnZmqConfig {
        source_id: SourceId::new("bchn-regtest"),
        endpoint: endpoint(),
    })
    .await
    .expect("SUB socket connects");
    tokio::time::sleep(Duration::from_millis(500)).await;

    let address = new_address();
    generate(4, &address);

    let mut per_topic: Vec<(String, u32)> = Vec::new();
    let mut gaps = Vec::new();
    for _ in 0..16 {
        let envelope = next(&source).await;
        let Some(sequence) = envelope.sequence else {
            panic!(
                "BCHN sent no sequence frame on '{}'; without it a dropped \
                 notification is indistinguishable from a quiet node",
                envelope.topic
            );
        };
        if let Some(gap) = envelope.gap {
            gaps.push((envelope.topic.clone(), gap));
        }
        if let Some(previous) = per_topic
            .iter_mut()
            .find(|(topic, _)| topic == &envelope.topic)
        {
            assert_eq!(
                sequence,
                previous.1 + 1,
                "'{}' jumped from {} to {sequence}",
                envelope.topic,
                previous.1
            );
            previous.1 = sequence;
        } else {
            per_topic.push((envelope.topic.clone(), sequence));
        }
        if per_topic
            .iter()
            .filter(|(topic, _)| topic == "hashblock" || topic == "rawblock")
            .count()
            == 2
            && per_topic.iter().any(|(_, seq)| *seq >= 3)
        {
            break;
        }
    }

    assert!(
        per_topic.len() >= 2,
        "expected several topics, saw {per_topic:?}"
    );
    // No gap is expected on a socket that stayed connected. The point is that
    // the tracker is watching a counter the node really sends, so a gap on a
    // flakier link would be reported rather than silently skipped.
    assert!(gaps.is_empty(), "unexpected sequence gaps: {gaps:?}");
}
