//! Three identities, each with its own engine, on one local relay: the whole
//! life of a Marmot group as the chat drives it.

use std::time::Duration;

use futures::StreamExt;
use mdk_memory_storage::MdkMemoryStorage;
use nostr_sdk::prelude::LocalRelay;
use optn_chat::{ChatConfig, ChatEngine, ChatError, ChatEvent, GroupView, KIND_CHAT, KIND_FILE};
use optn_nostr::nostr::prelude::Keys;
use optn_nostr::{RelayRoute, Relays};

type Engine = ChatEngine<MdkMemoryStorage>;

async fn engine(relay: &str) -> Engine {
    let relays = Relays::connect(&[relay], RelayRoute::LocalOnly, Duration::from_secs(5))
        .await
        .unwrap();
    ChatEngine::new(
        MdkMemoryStorage::default(),
        Keys::generate(),
        relays,
        ChatConfig {
            relays: vec![relay.to_owned()],
            timeout: Duration::from_secs(5),
        },
    )
    .unwrap()
}

fn messages(events: &[ChatEvent]) -> Vec<(String, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::Message(message) => Some((message.from.clone(), message.content.clone())),
            _ => None,
        })
        .collect()
}

fn joined(events: &[ChatEvent]) -> Vec<GroupView> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::Joined(group) => Some(group.clone()),
            _ => None,
        })
        .collect()
}

fn last_change(events: &[ChatEvent]) -> GroupView {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            ChatEvent::Changed(group) => Some(group.clone()),
            _ => None,
        })
        .expect("a group change")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_lives_from_invitation_to_leaving() {
    let relay = LocalRelay::new();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();

    let alice = engine(&url).await;
    let bob = engine(&url).await;
    let carol = engine(&url).await;
    bob.publish_key_package().await.unwrap();
    carol.publish_key_package().await.unwrap();

    // Someone with no Marmot key package cannot be invited, and nothing is
    // created when one of the members fails.
    let stranger = Keys::generate().public_key().to_hex();
    assert_eq!(
        alice
            .create_group("nope", &[bob.public_key(), stranger.clone()], &[])
            .await
            .unwrap_err(),
        ChatError::NoKeyPackage { member: stranger }
    );
    assert!(alice.groups().await.unwrap().is_empty());

    // Alice creates the group with Bob; Bob's inbox holds the welcome.
    let group = alice
        .create_group("ops", &[bob.public_key()], &[])
        .await
        .unwrap();
    assert_eq!(group.name, "ops");
    assert_eq!(group.admins, vec![alice.public_key()]);
    let mut members = vec![alice.public_key(), bob.public_key()];
    members.sort();
    assert_eq!(group.members, members);
    let id = group.mls_group_id.clone();

    let seen = bob.catch_up().await.unwrap();
    let welcomed = joined(&seen);
    assert_eq!(welcomed.len(), 1);
    assert_eq!(welcomed[0].mls_group_id, id);
    assert_eq!(welcomed[0].name, "ops");

    // Messages both ways; each side reads them once, however often it
    // catches up.
    let sent = alice.send(&id, KIND_CHAT, "hello bob", &[]).await.unwrap();
    assert!(sent.mine);
    assert_eq!(
        messages(&bob.catch_up().await.unwrap()),
        vec![(alice.public_key(), "hello bob".to_owned())]
    );
    assert!(messages(&bob.catch_up().await.unwrap()).is_empty());
    bob.send(&id, KIND_CHAT, "hello alice", &[]).await.unwrap();
    assert_eq!(
        messages(&alice.catch_up().await.unwrap()),
        vec![(bob.public_key(), "hello alice".to_owned())]
    );

    // An inline file keeps its kind and tags.
    let tags = vec![vec!["file-type".to_owned(), "image/png".to_owned()]];
    alice
        .send(&id, KIND_FILE, "data:image/png;base64,iVBORw0KGgo=", &tags)
        .await
        .unwrap();
    let file = bob
        .catch_up()
        .await
        .unwrap()
        .into_iter()
        .find_map(|event| match event {
            ChatEvent::Message(message) => Some(message),
            _ => None,
        })
        .unwrap();
    assert_eq!(file.kind, KIND_FILE);
    assert!(file.tags.contains(&tags[0]));

    // A rename reaches Bob as a change.
    alice.rename(&id, "ops room").await.unwrap();
    assert_eq!(last_change(&bob.catch_up().await.unwrap()).name, "ops room");

    // Live: Bob listens, Alice writes.
    let mut live = Box::pin(bob.events());
    bob.listen().await.unwrap();
    alice.send(&id, KIND_CHAT, "live?", &[]).await.unwrap();
    let heard = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(ChatEvent::Message(message)) = live.next().await {
                return message;
            }
        }
    })
    .await
    .expect("Bob hears Alice live");
    assert_eq!(heard.content, "live?");
    assert!(!heard.mine);
    // From here Bob reads by catching up, so the test sees what he reads.
    bob.stop_listening().await;

    // Carol is added later and reads what is written after.
    alice.add_members(&id, &[carol.public_key()]).await.unwrap();
    assert_eq!(joined(&carol.catch_up().await.unwrap()).len(), 1);
    assert_eq!(last_change(&bob.catch_up().await.unwrap()).members.len(), 3);
    alice
        .send(&id, KIND_CHAT, "welcome carol", &[])
        .await
        .unwrap();
    assert_eq!(
        messages(&carol.catch_up().await.unwrap()),
        vec![(alice.public_key(), "welcome carol".to_owned())]
    );

    // Removed, Carol's group goes inactive.
    alice
        .remove_members(&id, &[carol.public_key()])
        .await
        .unwrap();
    assert!(!last_change(&carol.catch_up().await.unwrap()).active);

    // Bob leaves; Alice commits his departure.
    bob.leave(&id).await.unwrap();
    assert!(bob.groups().await.unwrap().is_empty());
    let after = last_change(&alice.catch_up().await.unwrap());
    assert_eq!(after.members, vec![alice.public_key()]);

    // History stays in Alice's store.
    let history = alice.messages(&id, 50).await.unwrap();
    assert!(history
        .iter()
        .any(|message| message.content == "hello alice"));

    for engine in [&alice, &bob, &carol] {
        engine.shutdown().await;
    }
    relay.shutdown();
}
