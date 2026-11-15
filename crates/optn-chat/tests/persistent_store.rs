//! The engine's encrypted store across restarts: a reopened engine keeps its
//! groups, its history and its epoch, and reads on where it left off.

use std::time::Duration;

use mdk_memory_storage::MdkMemoryStorage;
use nostr_sdk::prelude::LocalRelay;
use optn_chat::{ChatConfig, ChatEngine, ChatEvent, EngineState, MdkStore, KIND_CHAT};
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

async fn open(dir: &std::path::Path, keys: &Keys, relay: &str) -> ChatEngine<MdkStore> {
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

    // Nothing of the conversation is readable on disk.
    let database = dir
        .path()
        .join(format!("{}.mdk.redb", alice_keys.public_key().to_hex()));
    let raw = std::fs::read(&database).unwrap();
    for needle in [b"before the restart".as_slice(), b"kept", id.as_bytes()] {
        assert!(!raw.windows(needle.len()).any(|window| window == needle));
    }

    // Another identity's key does not open it.
    let stranger = Keys::generate();
    let other = dir.path().join("stranger");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::copy(
        &database,
        other.join(format!("{}.mdk.redb", stranger.public_key().to_hex())),
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

#[tokio::test(flavor = "multi_thread")]
async fn a_new_store_starts_fresh_beside_an_old_one_and_publishes_a_key_package() {
    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let dir = tempfile::tempdir().unwrap();
    let keys = Keys::generate();
    let name = keys.public_key().to_hex();

    // What an earlier build left: a SQLCipher store, and a state file saying
    // a key package went out a moment ago from it.
    let old_store = dir.path().join(format!("{name}.mdk.sqlite"));
    std::fs::write(&old_store, b"an earlier build's SQLCipher store").unwrap();
    let state_path = dir.path().join(format!("{name}.state.json"));
    EngineState {
        key_package_slot: Some("ab".repeat(32)),
        key_packages: vec!["01".repeat(32), "02".repeat(32)],
        key_package_published_at: Some(u64::MAX / 2),
        inbox_read_until: Some(u64::MAX / 2),
        groups_read_until: Some(u64::MAX / 2),
    }
    .save(&state_path)
    .unwrap();

    let engine = open(dir.path(), &keys, &url).await;
    // The old store is not read, moved or changed.
    assert_eq!(
        std::fs::read(&old_store).unwrap(),
        b"an earlier build's SQLCipher store"
    );
    // Its key packages' private keys are in that store, not this one: the
    // engine forgets them and publishes a new key package now, in the same slot.
    let state = EngineState::load(&state_path).unwrap();
    assert_eq!(
        state.key_package_slot.as_deref(),
        Some("ab".repeat(32).as_str())
    );
    assert!(state.key_packages.is_empty());
    assert!(state.inbox_read_until.is_none());
    assert!(engine.ensure_key_package().await.unwrap().is_some());
    engine.shutdown().await;
    drop(engine);

    // Reopened, the store is the one just made: its state is kept.
    let engine = open(dir.path(), &keys, &url).await;
    let state = EngineState::load(&state_path).unwrap();
    assert_eq!(state.key_packages.len(), 1);
    assert!(engine.ensure_key_package().await.unwrap().is_none());
    engine.shutdown().await;
    relay.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_store_reopens_while_the_last_engine_is_still_held() {
    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let dir = tempfile::tempdir().unwrap();
    let keys = Keys::generate();

    let first = open(dir.path(), &keys, &url).await;
    first.publish_key_package().await.unwrap();
    // As the desktop's catch-up task may still hold the engine it closed.
    let held = first.clone();
    first.shutdown().await;
    drop(first);

    // The store is still open in this process; the new engine shares it, and
    // it is not a new store: the key package just published stands.
    let second = open(dir.path(), &keys, &url).await;
    assert!(second.ensure_key_package().await.unwrap().is_none());
    assert_eq!(held.groups().await.unwrap(), second.groups().await.unwrap());
    drop(held);
    second.shutdown().await;
    relay.shutdown();
}
