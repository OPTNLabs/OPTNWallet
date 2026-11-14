//! MDK's encrypted store across the move from rusqlite 0.37 to 0.42
//! (vendor/mdk-sqlite-storage-0.8.0): a store written under SQLCipher 4.6.1
//! opens, reads and takes writes under SQLCipher 4.20.0, and the SQLite beneath
//! it is one without RUSTSEC-2026-0459.
//!
//! `fixtures/sqlcipher-4.6.1/` is a chat store this crate wrote at 48e897cd,
//! the last commit on libsqlite3-sys 0.35.0 (SQLCipher 4.6.1, SQLite 3.46.1):
//! [`fixture_identity`] opened it with [`ChatEngine::open`], created the group
//! with a second member, read that member's message and answered it. It holds
//! no secret of anyone's: the identity is derived from the label below.
#![cfg(feature = "sqlite")]

use std::path::Path;
use std::time::Duration;

use nostr_sdk::prelude::LocalRelay;
use optn_chat::{ChatConfig, ChatEngine, MdkSqliteStorage};
use optn_nostr::nostr::prelude::{Keys, SecretKey};
use optn_nostr::{RelayRoute, Relays};
use sha2::{Digest, Sha256};

const STORE: &[u8] = include_bytes!("fixtures/sqlcipher-4.6.1/store.mdk.sqlite");
const STATE: &[u8] = include_bytes!("fixtures/sqlcipher-4.6.1/state.json");

const GROUP: &str = "kept across SQLCipher 4.6.1";
const THEIRS: &str = "written under SQLCipher 4.6.1";
const MINE: &str = "and its answer";

/// The identity the fixture was written by.
fn fixture_identity() -> Keys {
    let secret = Sha256::digest(b"optn-chat fixture: store written by SQLCipher 4.6.1");
    Keys::new(SecretKey::from_slice(&secret).unwrap())
}

/// Put the fixture in `dir` as `identity`'s store.
fn place(dir: &Path, identity: &Keys) {
    let name = identity.public_key().to_hex();
    std::fs::write(dir.join(format!("{name}.mdk.sqlite")), STORE).unwrap();
    std::fs::write(dir.join(format!("{name}.state.json")), STATE).unwrap();
}

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

/// The fix for RUSTSEC-2026-0459 is SQLite 3.54.0. The advisory's patched
/// range starts at libsqlite3-sys 0.39.0, whose SQLCipher is still on SQLite
/// 3.53.4, so no scanner sees a store that slips back there; this does.
#[cfg(not(target_vendor = "apple"))]
#[test]
fn the_store_runs_on_a_sqlite_with_the_wal_page_size_fix() {
    // SAFETY: sqlite3_libversion_number takes no arguments and returns the
    // linked library's version constant.
    let linked = unsafe { libsqlite3_sys::sqlite3_libversion_number() };
    assert!(linked >= 3_054_000, "linked SQLite is {linked}");
    assert_eq!(linked, libsqlite3_sys::SQLITE_VERSION_NUMBER);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_store_written_under_sqlcipher_4_6_1_opens_reads_and_takes_writes() {
    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let identity = fixture_identity();

    // The fixture is a SQLCipher file, not a plain database.
    assert!(!STORE.starts_with(b"SQLite format 3"));
    assert!(!STORE
        .windows(THEIRS.len())
        .any(|window| window == THEIRS.as_bytes()));

    let dir = tempfile::tempdir().unwrap();
    place(dir.path(), &identity);
    let alice: ChatEngine<MdkSqliteStorage> = ChatEngine::open(
        dir.path(),
        identity.clone(),
        relays(&url).await,
        config(&url),
    )
    .await
    .unwrap();

    // The group, its members and its history are what was written.
    let groups = alice.groups().await.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, GROUP);
    assert!(groups[0].active);
    assert_eq!(groups[0].members.len(), 2);
    assert!(groups[0].members.contains(&alice.public_key()));
    let id = groups[0].mls_group_id.clone();
    let history = alice.messages(&id, 10).await.unwrap();
    assert_eq!(history.len(), 2);
    let theirs = history.iter().find(|message| !message.mine).unwrap();
    let mine = history.iter().find(|message| message.mine).unwrap();
    assert_eq!(theirs.content, THEIRS);
    assert_eq!(mine.content, MINE);

    // It takes writes: the group is deleted, and stays deleted when the
    // store is opened again. (Sending would need the relay the fixture's group
    // was made on.)
    alice.forget(&id).await.unwrap();
    alice.shutdown().await;
    drop(alice);
    let alice: ChatEngine<MdkSqliteStorage> =
        ChatEngine::open(dir.path(), identity, relays(&url).await, config(&url))
            .await
            .unwrap();
    assert!(alice.groups().await.unwrap().is_empty());
    alice.shutdown().await;

    // Another identity's key still does not open it.
    let stranger = Keys::generate();
    let other = tempfile::tempdir().unwrap();
    place(other.path(), &stranger);
    assert!(
        ChatEngine::open(other.path(), stranger, relays(&url).await, config(&url))
            .await
            .is_err()
    );
    relay.shutdown();
}
