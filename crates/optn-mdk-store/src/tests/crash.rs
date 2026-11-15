//! An epoch change cut short at any point: by a failed write, or by the
//! process ending. Either way the store keeps the old epoch whole, and the
//! same commit applies when it is read again.

use mdk_core::prelude::MDK;
use mdk_storage_traits::messages::MessageStorage;
use nostr::{Event, JsonUtil, Keys};

use super::mdk::{alice_and_bob, Member};
use crate::{MdkStore, StoreError};

/// Bob reads Alice's key rotation with the write after `writes` failing. True
/// if the fault happened.
fn read_commit_failing(bob: &mut Member, commit: &Event, writes: usize) -> bool {
    bob.store.fail_after_writes(writes);
    let unit = bob.store.begin_unit();
    let _ = bob.mdk.process_message(commit);
    match unit.commit() {
        Ok(()) => {
            bob.store.clear_injected();
            false
        }
        Err(StoreError::RolledBack(_)) => {
            // MDK keeps some state in memory; the engine starts a new MDK
            // over the store after a rollback, and so does this.
            bob.mdk = MDK::new(bob.store.clone());
            true
        }
        Err(other) => panic!("the store stopped: {other}"),
    }
}

#[test]
fn a_failed_write_anywhere_in_reading_a_commit_leaves_the_old_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, mut bob, group) = alice_and_bob(dir.path());
    let before = bob.epoch(&group);
    let commit = alice.mdk.self_update(&group).unwrap().evolution_event;
    alice.mdk.merge_pending_commit(&group).unwrap();

    let mut faults = 0;
    while read_commit_failing(&mut bob, &commit, faults) {
        assert_eq!(bob.epoch(&group), before, "fault at write {faults}");
        assert!(bob
            .store
            .find_processed_message_by_event_id(&commit.id)
            .unwrap()
            .is_none());
        faults += 1;
    }
    // Every write of the commit was tried as the failing one, and then it applied.
    assert!(faults > 5, "only {faults} writes in a commit");
    assert_eq!(bob.epoch(&group), before + 1);
    assert_eq!(bob.hear(&alice.say(&group, "after")), "after");
}

#[test]
fn a_failed_write_anywhere_in_merging_our_own_commit_keeps_it_pending() {
    let dir = tempfile::tempdir().unwrap();
    let (mut alice, bob, group) = alice_and_bob(dir.path());
    let before = alice.epoch(&group);
    let commit = alice.mdk.self_update(&group).unwrap().evolution_event;

    let mut faults = 0;
    loop {
        alice.store.fail_after_writes(faults);
        let unit = alice.store.begin_unit();
        let _ = alice.mdk.merge_pending_commit(&group);
        match unit.commit() {
            Ok(()) => {
                alice.store.clear_injected();
                break;
            }
            Err(StoreError::RolledBack(_)) => {
                alice.mdk = MDK::new(alice.store.clone());
                assert_eq!(alice.epoch(&group), before, "fault at write {faults}");
            }
            Err(other) => panic!("the store stopped: {other}"),
        }
        faults += 1;
    }
    assert!(faults > 5, "only {faults} writes in a merge");
    assert_eq!(alice.epoch(&group), before + 1);
    bob.mdk.process_message(&commit).unwrap();
    assert_eq!(bob.hear(&alice.say(&group, "merged")), "merged");
}

/// Run by [`a_process_killed_while_reading_a_commit_leaves_the_old_epoch`]
/// in a child process; does nothing on its own.
#[test]
fn crash_child() {
    let Ok(store) = std::env::var("OPTN_MDK_STORE_CRASH_STORE") else {
        return;
    };
    let commit =
        std::fs::read_to_string(std::env::var("OPTN_MDK_STORE_CRASH_COMMIT").unwrap()).unwrap();
    let writes: usize = std::env::var("OPTN_MDK_STORE_CRASH_AT")
        .unwrap()
        .parse()
        .unwrap();
    let store = MdkStore::open(std::path::Path::new(&store), &[3; 32]).unwrap();
    let mdk = MDK::new(store.clone());
    store.abort_after_writes(writes);
    let unit = store.begin_unit();
    mdk.process_message(&Event::from_json(commit).unwrap())
        .unwrap();
    unit.commit().unwrap();
}

#[test]
fn a_process_killed_while_reading_a_commit_leaves_the_old_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob, group) = alice_and_bob(dir.path());
    let before = bob.epoch(&group);
    let commit = alice.mdk.self_update(&group).unwrap().evolution_event;
    alice.mdk.merge_pending_commit(&group).unwrap();
    let bob_keys: Keys = bob.keys.clone();
    drop(bob);

    let pristine = std::fs::read(dir.path().join("bob.mdk.redb")).unwrap();
    let commit_path = dir.path().join("commit.json");
    std::fs::write(&commit_path, commit.as_json()).unwrap();
    let store_path = dir.path().join("crashed.mdk.redb");

    for writes in [0, 1, 3, 8, 13, 10_000] {
        std::fs::write(&store_path, &pristine).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::crash::crash_child",
                "--test-threads=1",
                "--quiet",
            ])
            .env("OPTN_MDK_STORE_CRASH_STORE", &store_path)
            .env("OPTN_MDK_STORE_CRASH_COMMIT", &commit_path)
            .env("OPTN_MDK_STORE_CRASH_AT", writes.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        let bob = Member::open(&store_path, bob_keys.clone());
        assert_eq!(bob.store.unreadable_records(), 0);
        if status.success() {
            // The child finished: the commit is applied, once.
            assert_eq!(
                writes, 10_000,
                "the child should have died at write {writes}"
            );
            assert_eq!(bob.epoch(&group), before + 1);
        } else {
            assert_eq!(bob.epoch(&group), before, "killed at write {writes}");
            bob.mdk.process_message(&commit).unwrap();
            assert_eq!(bob.epoch(&group), before + 1);
        }
        assert_eq!(bob.hear(&alice.say(&group, "heard")), "heard");
    }
}
