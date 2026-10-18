//! Two throwaway identities make a Marmot group on public relays through the
//! holder's Tor: real relays' acceptance, latency and ordering, which a local
//! relay does not show. Opt-in:
//!
//! ```sh
//! OPTN_CHAT_TOR=127.0.0.1:9050 \
//! OPTN_CHAT_RELAYS=wss://relay.damus.io,wss://nos.lol \
//!   cargo test -p optn-chat --test live_relays -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use mdk_memory_storage::MdkMemoryStorage;
use optn_chat::{ChatConfig, ChatEngine, ChatEvent, KIND_CHAT};
use optn_nostr::nostr::prelude::Keys;
use optn_nostr::{RelayRoute, Relays};

type Engine = ChatEngine<MdkMemoryStorage>;

const TIMEOUT: Duration = Duration::from_secs(45);

async fn engine(relays: &[String], tor: std::net::SocketAddr) -> Engine {
    let connected = Relays::connect(relays, RelayRoute::Tor(tor), TIMEOUT)
        .await
        .expect("a relay through Tor");
    ChatEngine::new(
        MdkMemoryStorage::default(),
        Keys::generate(),
        connected,
        ChatConfig {
            relays: relays.to_vec(),
            timeout: TIMEOUT,
        },
    )
    .unwrap()
}

/// Catch up until `found` sees what it waits for: public relays take a
/// moment to serve what was just published.
async fn wait_for<T>(
    engine: &Engine,
    what: &str,
    mut found: impl FnMut(&[ChatEvent]) -> Option<T>,
) -> T {
    let started = Instant::now();
    loop {
        let events = engine.catch_up().await.expect("catch up");
        if let Some(value) = found(&events) {
            eprintln!("{what}: {:.1}s", started.elapsed().as_secs_f32());
            return value;
        }
        assert!(
            started.elapsed() < Duration::from_secs(180),
            "{what}: gave up"
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

fn message(events: &[ChatEvent]) -> Option<String> {
    events.iter().find_map(|event| match event {
        ChatEvent::Message(message) => Some(message.content.clone()),
        _ => None,
    })
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "public relays over Tor; set OPTN_CHAT_TOR and OPTN_CHAT_RELAYS"]
async fn two_identities_chat_over_public_relays_through_tor() {
    let tor = std::env::var("OPTN_CHAT_TOR")
        .expect("OPTN_CHAT_TOR")
        .parse()
        .expect("OPTN_CHAT_TOR is host:port");
    let relays: Vec<String> = std::env::var("OPTN_CHAT_RELAYS")
        .expect("OPTN_CHAT_RELAYS")
        .split(',')
        .map(str::to_owned)
        .collect();

    let alice = engine(&relays, tor).await;
    let bob = engine(&relays, tor).await;
    let published = bob.publish_key_package().await.unwrap();
    eprintln!("bob's key package on {:?}", published.accepted);

    // Relays index a new event a moment after taking it.
    let started = Instant::now();
    let group = loop {
        match alice.create_group("live", &[bob.public_key()], &[]).await {
            Ok(group) => break group,
            Err(error) if started.elapsed() < Duration::from_secs(90) => {
                eprintln!("not yet: {error}");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(error) => panic!("{error}"),
        }
    };
    let id = group.mls_group_id.clone();

    wait_for(&bob, "bob joins", |events| {
        events
            .iter()
            .any(|event| matches!(event, ChatEvent::Joined(joined) if joined.mls_group_id == id))
            .then_some(())
    })
    .await;

    alice
        .send(&id, KIND_CHAT, "hello over Tor", &[])
        .await
        .unwrap();
    assert_eq!(
        wait_for(&bob, "bob reads alice", message).await,
        "hello over Tor"
    );
    bob.send(&id, KIND_CHAT, "and back", &[]).await.unwrap();
    assert_eq!(
        wait_for(&alice, "alice reads bob", message).await,
        "and back"
    );

    alice.shutdown().await;
    bob.shutdown().await;
}
