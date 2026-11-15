//! The same calls, in the same order, on this store and on MDK's own memory
//! store, with every answer compared, and this store reopened along the way.
//!
//! Where MDK leaves an order unstated (all groups, invalidated records,
//! snapshots made in the same second), answers are compared as sets.

use std::collections::BTreeSet;

use mdk_memory_storage::MdkMemoryStorage;
use mdk_storage_traits::groups::types::{Group, GroupExporterSecret, GroupState, SelfUpdateState};
use mdk_storage_traits::groups::{GroupStorage, MessageSortOrder, Pagination as MessagePages};
use mdk_storage_traits::messages::types::{MessageState, ProcessedMessageState};
use mdk_storage_traits::messages::MessageStorage;
use mdk_storage_traits::test_utils::cross_storage::{
    create_test_group, create_test_message, create_test_processed_message,
    create_test_processed_welcome, create_test_welcome,
};
use mdk_storage_traits::welcomes::types::WelcomeState;
use mdk_storage_traits::welcomes::{Pagination as WelcomePages, WelcomeStorage};
use mdk_storage_traits::{GroupId, MdkStorageProvider, Secret};
use nostr::{EventId, RelayUrl, Tag, Tags, Timestamp};
use optn_mdk_store::MdkStore;

/// A small, seeded, reproducible stream of choices (xorshift64*).
struct Dice(u64);

impl Dice {
    fn roll(&mut self, sides: u64) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) % sides
    }
}

fn group_id(n: u64) -> GroupId {
    GroupId::from_slice(&[n as u8 + 1; 16])
}

fn event_id(n: u64) -> EventId {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(&n.to_be_bytes());
    bytes[31] = 0xee;
    EventId::from_byte_array(bytes)
}

/// Both answers equal: values by `==` (nostr compares an event kind by its
/// number, whether it is read back as `Custom(444)` or `MlsWelcome`), errors
/// by their message.
fn same<T, E>(step: usize, call: &str, ours: Result<T, E>, theirs: Result<T, E>)
where
    T: PartialEq + std::fmt::Debug,
    E: std::fmt::Display,
{
    match (ours, theirs) {
        (Ok(ours), Ok(theirs)) => assert_eq!(ours, theirs, "step {step}: {call}"),
        (Err(ours), Err(theirs)) => {
            assert_eq!(ours.to_string(), theirs.to_string(), "step {step}: {call}")
        }
        (ours, theirs) => panic!(
            "step {step}: {call}: ours {}, theirs {}",
            describe(&ours),
            describe(&theirs)
        ),
    }
}

/// Both answers equal, for calls that carry exporter secrets: the same check
/// as [`same`], but a failure names only the step, the call and which side
/// erred. Neither the secrets nor the stores' error text reach the test
/// output, which CI keeps.
fn same_secret<T, E>(step: usize, call: &str, ours: Result<T, E>, theirs: Result<T, E>)
where
    T: PartialEq,
    E: std::fmt::Display,
{
    let outcome = |answer: &Result<T, E>| if answer.is_ok() { "Ok" } else { "Err" };
    let agree = match (&ours, &theirs) {
        (Ok(ours), Ok(theirs)) => ours == theirs,
        (Err(ours), Err(theirs)) => ours.to_string() == theirs.to_string(),
        _ => false,
    };
    assert!(
        agree,
        "step {step}: {call}: ours {}, theirs {} (values withheld: secret material)",
        outcome(&ours),
        outcome(&theirs)
    );
}

fn describe<T: std::fmt::Debug, E: std::fmt::Display>(answer: &Result<T, E>) -> String {
    match answer {
        Ok(value) => format!("Ok({value:?})"),
        Err(error) => format!("Err({error})"),
    }
}

/// Both answers hold the same items, in whatever order.
fn same_set<T, E>(step: usize, call: &str, ours: Result<Vec<T>, E>, theirs: Result<Vec<T>, E>)
where
    T: PartialEq + std::fmt::Debug,
    E: std::fmt::Display,
{
    let ours = ours.map(|mut ours| {
        if let Ok(theirs) = &theirs {
            let mut ordered = Vec::with_capacity(ours.len());
            for item in theirs {
                if let Some(at) = ours.iter().position(|mine| mine == item) {
                    ordered.push(ours.remove(at));
                }
            }
            ordered.append(&mut ours);
            ordered
        } else {
            ours
        }
    });
    same(step, call, ours, theirs);
}

const GROUPS: u64 = 5;
const EVENTS: u64 = 40;
const STEPS: usize = 4000;

#[test]
fn this_store_answers_as_mdks_memory_store_does() {
    for seed in [1u64, 0x5eed, 0xdead_beef] {
        run(seed);
    }
}

fn run(seed: u64) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("differential.mdk.redb");
    let mut ours = MdkStore::open(&path, &[5; 32]).unwrap();
    let theirs = MdkMemoryStorage::default();
    let mut dice = Dice(seed);

    for step in 0..STEPS {
        let group = dice.roll(GROUPS);
        let g = group_id(group);
        // Each group draws its Nostr ids from its own pair, as random 32-byte
        // ids never meet; one save in eight asks for another group's, which
        // both stores must refuse.
        let nostr = match dice.roll(8) {
            0 => [10 + 2 * dice.roll(GROUPS) as u8; 32],
            _ => [10 + 2 * group as u8 + dice.roll(2) as u8; 32],
        };
        let n = dice.roll(EVENTS);
        let e = event_id(n);
        // A message's id is a hash of the message, so no two groups share
        // one. MDK's memory store relies on that: it caches messages by id
        // alone, and would lose one of two that shared it.
        let m = event_id(1_000 * (group + 1) + n);
        match dice.roll(24) {
            0 | 1 => {
                let mut group: Group = create_test_group(g.clone());
                group.nostr_group_id = nostr;
                group.epoch = dice.roll(10);
                group.name = format!("group {}", dice.roll(100));
                group.state = [GroupState::Active, GroupState::Inactive][dice.roll(2) as usize];
                group.self_update_state = match dice.roll(2) {
                    0 => SelfUpdateState::Required,
                    _ => SelfUpdateState::CompletedAt(Timestamp::from_secs(1_700_000_000)),
                };
                same(
                    step,
                    "save_group",
                    ours.save_group(group.clone()),
                    theirs.save_group(group),
                );
            }
            2 => same(
                step,
                "find_group",
                ours.find_group_by_mls_group_id(&g),
                theirs.find_group_by_mls_group_id(&g),
            ),
            3 => {
                same(
                    step,
                    "find_by_nostr",
                    ours.find_group_by_nostr_group_id(&nostr),
                    theirs.find_group_by_nostr_group_id(&nostr),
                );
            }
            4 => same_set(step, "all_groups", ours.all_groups(), theirs.all_groups()),
            5..=7 => {
                let mut message = create_test_message(g.clone(), m);
                message.created_at = Timestamp::from_secs(1_000 + dice.roll(5));
                message.processed_at = Timestamp::from_secs(2_000 + dice.roll(5));
                message.epoch = [None, Some(dice.roll(6))][dice.roll(2) as usize];
                message.state =
                    [MessageState::Processed, MessageState::Created][dice.roll(2) as usize];
                // One distinct tag per event, so a tag search has one answer.
                message.tags =
                    Tags::from_list(vec![Tag::parse(["x", &format!("hash-{m}")]).unwrap()]);
                same(
                    step,
                    "save_message",
                    ours.save_message(message.clone()),
                    theirs.save_message(message),
                );
            }
            8 => {
                let sort = [
                    MessageSortOrder::CreatedAtFirst,
                    MessageSortOrder::ProcessedAtFirst,
                ][dice.roll(2) as usize];
                let pages = MessagePages::with_sort_order(
                    Some(1 + dice.roll(8) as usize),
                    Some(dice.roll(4) as usize),
                    sort,
                );
                same(
                    step,
                    "messages",
                    ours.messages(&g, Some(pages)),
                    theirs.messages(&g, Some(pages)),
                );
                same(
                    step,
                    "last_message",
                    ours.last_message(&g, sort),
                    theirs.last_message(&g, sort),
                );
            }
            9 => same(
                step,
                "find_message",
                ours.find_message_by_event_id(&g, &m),
                theirs.find_message_by_event_id(&g, &m),
            ),
            10 => {
                let mut record = create_test_processed_message(e, Some(e));
                record.processed_at = Timestamp::from_secs(3_000);
                record.mls_group_id = (dice.roll(2) == 1).then(|| g.clone());
                record.epoch = [None, Some(dice.roll(6))][dice.roll(2) as usize];
                record.state = [
                    ProcessedMessageState::Processed,
                    ProcessedMessageState::Failed,
                ][dice.roll(2) as usize];
                same(
                    step,
                    "save_processed",
                    ours.save_processed_message(record.clone()),
                    theirs.save_processed_message(record),
                );
            }
            11 => same(
                step,
                "find_processed",
                ours.find_processed_message_by_event_id(&e),
                theirs.find_processed_message_by_event_id(&e),
            ),
            12 => {
                let epoch = dice.roll(6);
                same_set(
                    step,
                    "invalidate_messages",
                    ours.invalidate_messages_after_epoch(&g, epoch),
                    theirs.invalidate_messages_after_epoch(&g, epoch),
                );
                same_set(
                    step,
                    "invalidate_processed",
                    ours.invalidate_processed_messages_after_epoch(&g, epoch),
                    theirs.invalidate_processed_messages_after_epoch(&g, epoch),
                );
            }
            13 => {
                same_set(
                    step,
                    "invalidated",
                    ours.find_invalidated_messages(&g),
                    theirs.find_invalidated_messages(&g),
                );
                same_set(
                    step,
                    "invalidated_processed",
                    ours.find_invalidated_processed_messages(&g),
                    theirs.find_invalidated_processed_messages(&g),
                );
                same_set(
                    step,
                    "failed_for_retry",
                    ours.find_failed_messages_for_retry(&g),
                    theirs.find_failed_messages_for_retry(&g),
                );
            }
            14 => same(
                step,
                "retryable",
                ours.mark_processed_message_retryable(&e),
                theirs.mark_processed_message_retryable(&e),
            ),
            15 => {
                let needle = format!("hash-{m}");
                same(
                    step,
                    "epoch_by_tag",
                    ours.find_message_epoch_by_tag_content(&g, &needle),
                    theirs.find_message_epoch_by_tag_content(&g, &needle),
                );
            }
            16 => {
                let mut welcome = create_test_welcome(g.clone(), e);
                welcome.state =
                    [WelcomeState::Pending, WelcomeState::Accepted][dice.roll(2) as usize];
                same(
                    step,
                    "save_welcome",
                    ours.save_welcome(welcome.clone()),
                    theirs.save_welcome(welcome),
                );
                let pages = WelcomePages::new(
                    Some(1 + dice.roll(10) as usize),
                    Some(dice.roll(3) as usize),
                );
                same(
                    step,
                    "pending_welcomes",
                    ours.pending_welcomes(Some(pages)),
                    theirs.pending_welcomes(Some(pages)),
                );
                same(
                    step,
                    "find_welcome",
                    ours.find_welcome_by_event_id(&e),
                    theirs.find_welcome_by_event_id(&e),
                );
                let processed = create_test_processed_welcome(e, Some(e));
                same(
                    step,
                    "save_processed_welcome",
                    ours.save_processed_welcome(processed.clone()),
                    theirs.save_processed_welcome(processed),
                );
                same(
                    step,
                    "find_processed_welcome",
                    ours.find_processed_welcome_by_event_id(&e),
                    theirs.find_processed_welcome_by_event_id(&e),
                );
            }
            17 => {
                let relays: BTreeSet<RelayUrl> = (0..dice.roll(4))
                    .map(|n| RelayUrl::parse(&format!("wss://relay{n}.example")).unwrap())
                    .collect();
                same(
                    step,
                    "replace_relays",
                    ours.replace_group_relays(&g, relays.clone()),
                    theirs.replace_group_relays(&g, relays),
                );
                same(
                    step,
                    "group_relays",
                    ours.group_relays(&g),
                    theirs.group_relays(&g),
                );
                same(step, "admins", ours.admins(&g), theirs.admins(&g));
            }
            18 => {
                let epoch = dice.roll(8);
                let secret = GroupExporterSecret {
                    mls_group_id: g.clone(),
                    epoch,
                    secret: Secret::new([dice.roll(255) as u8; 32]),
                };
                match dice.roll(3) {
                    0 => same_secret(
                        step,
                        "save_secret",
                        ours.save_group_exporter_secret(secret.clone()),
                        theirs.save_group_exporter_secret(secret),
                    ),
                    1 => same_secret(
                        step,
                        "save_legacy",
                        ours.save_group_legacy_exporter_secret(secret.clone()),
                        theirs.save_group_legacy_exporter_secret(secret),
                    ),
                    _ => same_secret(
                        step,
                        "save_mip04",
                        ours.save_group_mip04_exporter_secret(secret.clone()),
                        theirs.save_group_mip04_exporter_secret(secret),
                    ),
                }
                let at = dice.roll(8);
                same_secret(
                    step,
                    "secret",
                    ours.get_group_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                    theirs
                        .get_group_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                );
                same_secret(
                    step,
                    "legacy",
                    ours.get_group_legacy_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                    theirs
                        .get_group_legacy_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                );
                same_secret(
                    step,
                    "mip04",
                    ours.get_group_mip04_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                    theirs
                        .get_group_mip04_exporter_secret(&g, at)
                        .map(|s| s.map(|s| *s.secret)),
                );
            }
            19 => {
                let keep = dice.roll(8);
                same_secret(
                    step,
                    "prune_secrets",
                    ours.prune_group_exporter_secrets_before_epoch(&g, keep),
                    theirs.prune_group_exporter_secrets_before_epoch(&g, keep),
                );
            }
            20 => {
                let name = format!("snap-{}", dice.roll(3));
                match dice.roll(4) {
                    0 | 1 => same(
                        step,
                        "snapshot",
                        ours.create_group_snapshot(&g, &name),
                        theirs.create_group_snapshot(&g, &name),
                    ),
                    2 => same(
                        step,
                        "rollback",
                        ours.rollback_group_to_snapshot(&g, &name),
                        theirs.rollback_group_to_snapshot(&g, &name),
                    ),
                    _ => same(
                        step,
                        "release",
                        ours.release_group_snapshot(&g, &name),
                        theirs.release_group_snapshot(&g, &name),
                    ),
                }
                let names = |list: Vec<(String, u64)>| {
                    list.into_iter().map(|(name, _)| name).collect::<Vec<_>>()
                };
                same_set(
                    step,
                    "list_snapshots",
                    ours.list_group_snapshots(&g).map(names),
                    theirs.list_group_snapshots(&g).map(names),
                );
            }
            21 => {
                same(
                    step,
                    "delete_messages",
                    ours.delete_messages_for_group(&g),
                    theirs.delete_messages_for_group(&g),
                );
            }
            22 => {
                if dice.roll(4) == 0 {
                    same(
                        step,
                        "delete_group",
                        ours.delete_group(&g),
                        theirs.delete_group(&g),
                    );
                } else {
                    same_set(
                        step,
                        "groups_needing_self_update",
                        ours.groups_needing_self_update(3600),
                        theirs.groups_needing_self_update(3600),
                    );
                }
            }
            _ => {
                // Close and reopen: everything above must have been on disk.
                drop(ours);
                ours = MdkStore::open(&path, &[5; 32]).unwrap();
                assert_eq!(ours.unreadable_records(), 0);
            }
        }
    }
    // Pruning everything older than now removes every snapshot from both.
    let later = Timestamp::now().as_secs() + 1;
    same(
        STEPS,
        "prune_snapshots",
        ours.prune_expired_snapshots(later),
        theirs.prune_expired_snapshots(later),
    );
}
