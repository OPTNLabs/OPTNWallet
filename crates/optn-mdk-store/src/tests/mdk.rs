//! MDK itself on this store: a group made, joined, talked in, changed and
//! reopened, with nothing but MDK's own API.

use mdk_core::prelude::{GroupId, MessageProcessingResult, MDK};
use mdk_core::test_util::{
    create_key_package_event, create_nostr_group_config_data, create_test_rumor,
};
use nostr::{Event, EventId, Keys};

use crate::MdkStore;

pub(super) struct Member {
    pub(super) keys: Keys,
    pub(super) store: MdkStore,
    pub(super) mdk: MDK<MdkStore>,
}

impl Member {
    pub(super) fn open(path: &std::path::Path, keys: Keys) -> Self {
        let store = MdkStore::open(path, &[3; 32]).unwrap();
        Self {
            mdk: MDK::new(store.clone()),
            keys,
            store,
        }
    }

    pub(super) fn epoch(&self, group: &GroupId) -> u64 {
        self.mdk.get_group(group).unwrap().unwrap().epoch
    }

    pub(super) fn say(&self, group: &GroupId, text: &str) -> Event {
        self.mdk
            .create_message(group, create_test_rumor(&self.keys, text), None)
            .unwrap()
    }

    pub(super) fn hear(&self, event: &Event) -> String {
        match self.mdk.process_message(event).unwrap() {
            MessageProcessingResult::ApplicationMessage(message) => message.content,
            other => panic!("expected a message, got {other:?}"),
        }
    }
}

/// Alice makes a group with Bob in it; Bob joins by the welcome.
pub(super) fn alice_and_bob(dir: &std::path::Path) -> (Member, Member, GroupId) {
    let alice = Member::open(&dir.join("alice.mdk.redb"), Keys::generate());
    let bob = Member::open(&dir.join("bob.mdk.redb"), Keys::generate());
    let package = create_key_package_event(&bob.mdk, &bob.keys);
    let created = alice
        .mdk
        .create_group(
            &alice.keys.public_key(),
            vec![package],
            create_nostr_group_config_data(vec![alice.keys.public_key(), bob.keys.public_key()]),
        )
        .unwrap();
    let group = created.group.mls_group_id.clone();
    alice.mdk.merge_pending_commit(&group).unwrap();
    let welcome = bob
        .mdk
        .process_welcome(&EventId::all_zeros(), &created.welcome_rumors[0])
        .unwrap();
    bob.mdk.accept_welcome(&welcome).unwrap();
    (alice, bob, group)
}

#[test]
fn a_group_is_made_joined_changed_and_kept_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob, group) = alice_and_bob(dir.path());
    assert_eq!(bob.hear(&alice.say(&group, "hello bob")), "hello bob");

    // Bob rotates his keys: a commit Alice reads, and both move on an epoch.
    let before = alice.epoch(&group);
    let update = bob.mdk.self_update(&group).unwrap();
    bob.mdk.merge_pending_commit(&group).unwrap();
    alice.mdk.process_message(&update.evolution_event).unwrap();
    assert_eq!(alice.epoch(&group), before + 1);
    assert_eq!(bob.epoch(&group), before + 1);
    assert_eq!(alice.hear(&bob.say(&group, "new keys")), "new keys");

    // Both close and reopen their stores.
    let (alice_keys, bob_keys) = (alice.keys.clone(), bob.keys.clone());
    drop(alice);
    drop(bob);
    let alice = Member::open(&dir.path().join("alice.mdk.redb"), alice_keys);
    let bob = Member::open(&dir.path().join("bob.mdk.redb"), bob_keys);
    assert_eq!(alice.epoch(&group), before + 1);
    assert_eq!(alice.store.unreadable_records(), 0);

    // The history is there, and the group still works both ways.
    let history: Vec<String> = alice
        .mdk
        .get_messages(&group, None)
        .unwrap()
        .into_iter()
        .map(|message| message.content)
        .collect();
    assert!(history.contains(&"new keys".to_string()));
    assert_eq!(
        bob.hear(&alice.say(&group, "after the restart")),
        "after the restart"
    );
    assert_eq!(alice.hear(&bob.say(&group, "still here")), "still here");

    // Leaving and forgetting the group takes everything of it.
    alice.mdk.delete_group(&group).unwrap();
    assert!(alice.mdk.get_group(&group).unwrap().is_none());
    assert!(alice.mdk.get_groups().unwrap().is_empty());
}

#[test]
fn an_event_read_twice_is_known_the_second_time() {
    let dir = tempfile::tempdir().unwrap();
    let (alice, bob, group) = alice_and_bob(dir.path());
    let event = alice.say(&group, "once");
    assert_eq!(bob.hear(&event), "once");
    // MDK's processed record is what the engine asks before reading again.
    use mdk_storage_traits::messages::MessageStorage;
    assert!(bob
        .store
        .find_processed_message_by_event_id(&event.id)
        .unwrap()
        .is_some());
}
