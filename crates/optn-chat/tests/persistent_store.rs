//! MDK's encrypted store across restarts: a reopened engine keeps its groups,
//! its history and its epoch, and reads on where it left off.
#![cfg(feature = "sqlite")]

use std::time::Duration;

use mdk_memory_storage::MdkMemoryStorage;
use nostr_sdk::prelude::LocalRelay;
use optn_chat::{ChatConfig, ChatEngine, ChatEvent, MdkSqliteStorage, KIND_CHAT};
use optn_nostr::nostr::prelude::Keys;
use optn_nostr::{RelayRoute, Relays};

fn config(relay: &str) -> ChatConfig {
    ChatConfig {
        relays: vec![relay.to_owned()],
        timeout: Duration::from_secs(5),
    }
}

async fn relays(relay: &str) -> Relays {
    Relays::connect(&[relay], RelayRoute::LocalOnly, Duration::from_secs(5))
        .await
        .unwrap()
}

async fn open(dir: &std::path::Path, keys: &Keys, relay: &str) -> ChatEngine<MdkSqliteStorage> {
    ChatEngine::open(dir, keys.clone(), relays(relay).await, config(relay))
        .await
        .unwrap()
}

fn texts(events: &[ChatEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::Message(message) => Some(message.content.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reopened_store_reads_on_where_it_left_off() {
    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let dir = tempfile::tempdir().unwrap();

    let alice_keys = Keys::generate();
    let alice = open(dir.path(), &alice_keys, &url).await;
    let bob: ChatEngine<MdkMemoryStorage> = ChatEngine::new(
        MdkMemoryStorage::default(),
        Keys::generate(),
        relays(&url).await,
        config(&url),
    )
    .unwrap();
    bob.publish_key_package().await.unwrap();

    let group = alice
        .create_group("kept", &[bob.public_key()], &[])
        .await
        .unwrap();
    let id = group.mls_group_id;
    bob.catch_up().await.unwrap();
    bob.send(&id, KIND_CHAT, "before the restart", &[])
        .await
        .unwrap();
    assert_eq!(
        texts(&alice.catch_up().await.unwrap()),
        ["before the restart"]
    );
    alice.shutdown().await;
    drop(alice);

    // Nothing on disk reads as a database without the key.
    let database = dir
        .path()
        .join(format!("{}.mdk.sqlite", alice_keys.public_key().to_hex()));
    let raw = std::fs::read(&database).unwrap();
    assert!(!raw.starts_with(b"SQLite format 3"));
    assert!(!raw
        .windows("before the restart".len())
        .any(|window| window == b"before the restart"));

    // Another identity's key does not open it.
    let stranger = Keys::generate();
    let other = dir.path().join("stranger");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::copy(
        &database,
        other.join(format!("{}.mdk.sqlite", stranger.public_key().to_hex())),
    )
    .unwrap();
    assert!(
        ChatEngine::open(&other, stranger, relays(&url).await, config(&url))
            .await
            .is_err()
    );

    // Reopened, Alice has the group, the history, and reads only what is new.
    let alice = open(dir.path(), &alice_keys, &url).await;
    let groups = alice.groups().await.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "kept");
    let history = alice.messages(&id, 10).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].content, "before the restart");

    bob.send(&id, KIND_CHAT, "after the restart", &[])
        .await
        .unwrap();
    assert_eq!(
        texts(&alice.catch_up().await.unwrap()),
        ["after the restart"]
    );
    alice.send(&id, KIND_CHAT, "still here", &[]).await.unwrap();
    assert_eq!(texts(&bob.catch_up().await.unwrap()), ["still here"]);

    alice.shutdown().await;
    bob.shutdown().await;
    relay.shutdown();
}
