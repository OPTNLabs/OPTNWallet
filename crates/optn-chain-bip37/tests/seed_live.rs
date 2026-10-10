//! The shipped DNS seeds against the real network: a seed's DNS answer, and
//! the `getaddr` exchange with a node it names, whose timing a fake node does
//! not show. Opt-in, since it contacts public seeds and nodes:
//!
//! ```sh
//! OPTN_SEED_LIVE=1 cargo test -p optn-chain-bip37 --test seed_live -- --ignored --nocapture
//! ```
//!
//! With `OPTN_SEED_TOR=127.0.0.1:9050` the seed is also asked through that
//! Tor, by name, as the wallet asks it with Tor on.

use optn_chain_bip37::seed::{addr_fetch, seed_nodes, ADDR_FETCH_WAIT};
use optn_chain_bip37::Bip37Transport;
use std::time::{Duration, Instant};

const SEEDS: &[&str] = &[
    "seed.flowee.cash",
    "seed.bchd.cash",
    "btccash-seeder.bitcoinunlimited.info",
    "seed.bch.loping.net",
];

#[tokio::test]
#[ignore = "contacts public DNS seeds and nodes; set OPTN_SEED_LIVE=1"]
async fn public_seeds_name_nodes_that_answer_getaddr() {
    if std::env::var_os("OPTN_SEED_LIVE").is_none() {
        return;
    }
    let direct = Bip37Transport::Direct;
    let mut named = Vec::new();
    for seed in SEEDS {
        match seed_nodes(seed, 8333, "mainnet", &direct).await {
            Ok(nodes) => {
                println!("{seed}: {} nodes", nodes.len());
                assert!(nodes.iter().all(|node| node.port() == 8333));
                named.extend(nodes);
            }
            Err(error) => println!("{seed}: {error}"),
        }
    }
    assert!(!named.is_empty(), "no shipped seed answered");

    // The full reply waits for the node's next address-relay tick, so this
    // waits longer than the wallet does: it is checking the reply, not the
    // timing.
    let mut answered = false;
    for node in named.iter().filter(|node| node.is_ipv4()).take(6) {
        let started = Instant::now();
        match addr_fetch(
            &node.ip().to_string(),
            node.port(),
            "mainnet",
            &direct,
            Duration::from_secs(180),
        )
        .await
        {
            Ok(addresses) => {
                println!(
                    "{node} named {} full nodes after {:?}",
                    addresses.len(),
                    started.elapsed()
                );
                if addresses.len() > 1 {
                    answered = true;
                    break;
                }
            }
            Err(error) => println!("{node}: {error}"),
        }
    }
    assert!(answered, "no node a seed named answered getaddr in full");
    println!("the wallet waits {ADDR_FETCH_WAIT:?} per seed through Tor");

    if let Some(proxy) = std::env::var("OPTN_SEED_TOR")
        .ok()
        .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
    {
        let tor = Bip37Transport::Tor {
            proxy_host: proxy.ip().to_string(),
            proxy_port: proxy.port(),
        };
        let mut through_tor = false;
        for seed in SEEDS {
            match seed_nodes(seed, 8333, "mainnet", &tor).await {
                Ok(nodes) => {
                    println!("{seed} through Tor: {} nodes", nodes.len());
                    through_tor = true;
                    break;
                }
                Err(error) => println!("{seed} through Tor: {error}"),
            }
        }
        assert!(through_tor, "no seed answered through Tor");
    }
}
