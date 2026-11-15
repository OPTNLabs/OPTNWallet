//! The store on its own: opening, keys, units of work, faults, what is on disk.

mod crash;
mod mdk;

use std::path::{Path, PathBuf};

use mdk_storage_traits::groups::types::Group;
use mdk_storage_traits::groups::GroupStorage;
use mdk_storage_traits::messages::MessageStorage;
use mdk_storage_traits::test_utils::cross_storage::{create_test_group, create_test_message};
use mdk_storage_traits::GroupId;
use nostr::EventId;

use crate::record::Family;
use crate::{MdkStore, StoreError, FORMAT, MAGIC};

const KEY: [u8; 32] = [7; 32];

fn path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("store.mdk.redb")
}

fn group(byte: u8, name: &str) -> Group {
    let mut group = create_test_group(GroupId::from_slice(&[byte; 16]));
    group.nostr_group_id = [byte; 32];
    group.name = name.into();
    group
}

fn file_contains(path: &Path, needle: &[u8]) -> bool {
    let raw = std::fs::read(path).unwrap();
    raw.windows(needle.len()).any(|window| window == needle)
}

#[test]
fn a_new_store_is_made_once_and_found_again() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert!(store.created());
    store.save_group(group(1, "kept")).unwrap();
    drop(store);

    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert!(!store.created());
    assert_eq!(store.unreadable_records(), 0);
    let groups = store.all_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "kept");
}

/// Every record in the file, as raw bytes, read past the store.
fn raw_records(path: &Path) -> Vec<([u8; 32], Vec<u8>)> {
    use redb::{Database, ReadableDatabase, ReadableTable};
    let database = Database::create(path).unwrap();
    let reading = database.begin_read().unwrap();
    let table = reading.open_table(crate::RECORDS).unwrap();
    table
        .iter()
        .unwrap()
        .map(|row| {
            let (key, value) = row.unwrap();
            (*key.value(), value.value().to_vec())
        })
        .collect()
}

#[test]
fn another_key_does_not_open_a_store_and_changes_no_record() {
    let dir = tempfile::tempdir().unwrap();
    MdkStore::open(&path(&dir), &KEY)
        .unwrap()
        .save_group(group(1, "mine"))
        .unwrap();
    // redb rewrites its own file header on every open; the records are what
    // must not change.
    let before = raw_records(&path(&dir));
    assert_eq!(
        MdkStore::open(&path(&dir), &[8; 32]).unwrap_err(),
        StoreError::WrongKey
    );
    assert_eq!(raw_records(&path(&dir)), before);
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert_eq!(store.all_groups().unwrap()[0].name, "mine");
}

#[test]
fn a_store_another_process_holds_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    drop(MdkStore::open(&path(&dir), &KEY).unwrap());
    // A redb handle outside this crate's own: as another process holds it.
    let _elsewhere = redb::Database::create(path(&dir)).unwrap();
    assert_eq!(
        MdkStore::open(&path(&dir), &KEY).unwrap_err(),
        StoreError::InUse
    );
}

#[test]
fn a_second_open_in_this_process_shares_the_store() {
    // The desktop reopens an engine while the last one's tasks may still
    // hold its store.
    let dir = tempfile::tempdir().unwrap();
    let first = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert!(first.created());
    first.save_group(group(1, "one")).unwrap();

    let second = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert!(!second.created());
    assert_eq!(second.all_groups().unwrap().len(), 1);
    second.save_group(group(2, "two")).unwrap();
    assert_eq!(first.all_groups().unwrap().len(), 2);

    // Not with another key, even while it is open.
    assert_eq!(
        MdkStore::open(&path(&dir), &[8; 32]).unwrap_err(),
        StoreError::WrongKey
    );

    // The last handle keeps it open; once none is left, the file is closed.
    drop(first);
    assert_eq!(second.all_groups().unwrap().len(), 2);
    drop(second);
    let _elsewhere = redb::Database::create(path(&dir)).unwrap();
}

#[test]
fn a_unit_keeps_other_threads_out_until_it_ends() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let unit = store.begin_unit();
    store.save_group(group(1, "mine")).unwrap();

    let (done, finished) = std::sync::mpsc::channel();
    let other = store.clone();
    let writer = std::thread::spawn(move || {
        // Waits for the unit: it neither sees nor joins it.
        let seen = other.all_groups().unwrap().len();
        other.save_group(group(2, "theirs")).unwrap();
        done.send(seen).unwrap();
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(
        finished.try_recv().is_err(),
        "the other thread ran inside the unit"
    );

    // The unit is dropped: its write goes, and the other thread's lands alone.
    drop(unit);
    assert_eq!(finished.recv().unwrap(), 0);
    writer.join().unwrap();
    let groups = store.all_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "theirs");
}

#[test]
fn a_store_from_a_later_version_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let mut header = MAGIC.to_vec();
    header.extend_from_slice(&(FORMAT + 1).to_le_bytes());
    store
        .run::<_, crate::Fault>(|session| {
            session.put(Family::Header, b"", &header)?;
            Ok(())
        })
        .unwrap();
    drop(store);
    assert_eq!(
        MdkStore::open(&path(&dir), &KEY).unwrap_err(),
        StoreError::Newer { format: FORMAT + 1 }
    );
}

#[test]
fn nothing_written_is_readable_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let group = group(1, "a very particular group name");
    let id = group.mls_group_id.clone();
    store.save_group(group).unwrap();
    let mut message = create_test_message(id.clone(), EventId::from_byte_array([9; 32]));
    message.content = "a very particular message".into();
    store.save_message(message).unwrap();
    drop(store);

    for needle in [
        b"a very particular group name".as_slice(),
        b"a very particular message",
        b"Test Group",
        id.as_slice(),
        &[9; 32],
        MAGIC,
    ] {
        assert!(!file_contains(&path(&dir), needle));
    }
}

#[test]
fn a_unit_lands_whole_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();

    // Dropped: nothing lands, and the store says nothing of it afterwards.
    let unit = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    store.save_group(group(2, "two")).unwrap();
    assert_eq!(
        store.all_groups().unwrap().len(),
        2,
        "a unit reads its own writes"
    );
    drop(unit);
    assert!(store.all_groups().unwrap().is_empty());

    // Committed: both land, and survive a reopen.
    let unit = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    store.save_group(group(2, "two")).unwrap();
    unit.commit().unwrap();
    drop(store);
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert_eq!(store.all_groups().unwrap().len(), 2);
}

#[test]
fn a_fault_in_a_unit_rolls_all_of_it_back_but_a_refusal_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();

    let unit = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    store.fail_after_writes(0);
    assert!(store.save_group(group(2, "two")).is_err());
    store.save_group(group(3, "three")).unwrap();
    assert!(matches!(unit.commit(), Err(StoreError::RolledBack(_))));
    assert!(store.all_groups().unwrap().is_empty());

    // MDK's own refusals are answers: the rest of the unit still lands.
    let unit = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    let mut clash = group(2, "two");
    clash.nostr_group_id = [1; 32];
    assert!(store.save_group(clash).is_err());
    unit.commit().unwrap();
    assert_eq!(store.all_groups().unwrap().len(), 1);

    // Outside a unit, a call is its own unit.
    store.fail_after_writes(0);
    assert!(store.save_group(group(4, "four")).is_err());
    assert_eq!(store.all_groups().unwrap().len(), 1);
    store.save_group(group(4, "four")).unwrap();
    assert_eq!(store.all_groups().unwrap().len(), 2);
}

#[test]
fn units_nest_and_land_at_the_outermost_commit() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let outer = store.begin_unit();
    let inner = store.clone().begin_unit();
    store.save_group(group(1, "one")).unwrap();
    inner.commit().unwrap();
    drop(outer);
    assert!(store.all_groups().unwrap().is_empty());

    // A nested unit dropped uncommitted takes the outer one with it.
    let outer = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    let inner = store.begin_unit();
    store.save_group(group(2, "two")).unwrap();
    drop(inner);
    assert!(matches!(outer.commit(), Err(StoreError::RolledBack(_))));
    assert!(store.all_groups().unwrap().is_empty());

    // Both committed: both land.
    let outer = store.begin_unit();
    let inner = store.begin_unit();
    store.save_group(group(1, "one")).unwrap();
    inner.commit().unwrap();
    outer.commit().unwrap();
    assert_eq!(store.all_groups().unwrap().len(), 1);
}

#[test]
fn a_changed_record_is_counted_and_refused_not_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let kept = group(1, "kept");
    let changed = group(2, "changed");
    let changed_id = changed.mls_group_id.clone();
    store.save_group(kept).unwrap();
    store.save_group(changed).unwrap();
    let at = store
        .inner
        .crypt
        .disk_key(Family::Group, &crate::keys::gid(&changed_id).unwrap());
    drop(store);

    // Flip one byte of that record's value, as someone without the key could.
    {
        use redb::{Database, ReadableTable};
        let database = Database::create(path(&dir)).unwrap();
        let writing = database.begin_write().unwrap();
        {
            let mut table = writing.open_table(crate::RECORDS).unwrap();
            let mut value = table.get(&at).unwrap().unwrap().value().to_vec();
            let last = value.len() - 1;
            value[last] ^= 1;
            table.insert(&at, value.as_slice()).unwrap();
        }
        writing.commit().unwrap();
    }

    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert_eq!(store.unreadable_records(), 1);
    assert!(store.find_group_by_mls_group_id(&changed_id).is_err());
    let groups = store.all_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].name, "kept");
}

#[test]
fn a_record_is_only_ever_the_one_asked_for() {
    // Two records whose values are swapped on disk: each authenticates only
    // at its own key, so neither is read as the other.
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let one = group(1, "one");
    let two = group(2, "two");
    let (one_id, two_id) = (one.mls_group_id.clone(), two.mls_group_id.clone());
    store.save_group(one).unwrap();
    store.save_group(two).unwrap();
    let crypt = &store.inner.crypt;
    let at_one = crypt.disk_key(Family::Group, &crate::keys::gid(&one_id).unwrap());
    let at_two = crypt.disk_key(Family::Group, &crate::keys::gid(&two_id).unwrap());
    drop(store);
    {
        use redb::{Database, ReadableTable};
        let database = Database::create(path(&dir)).unwrap();
        let writing = database.begin_write().unwrap();
        {
            let mut table = writing.open_table(crate::RECORDS).unwrap();
            let first = table.get(&at_one).unwrap().unwrap().value().to_vec();
            let second = table.get(&at_two).unwrap().unwrap().value().to_vec();
            table.insert(&at_one, second.as_slice()).unwrap();
            table.insert(&at_two, first.as_slice()).unwrap();
        }
        writing.commit().unwrap();
    }
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    assert_eq!(store.unreadable_records(), 2);
    assert!(store.find_group_by_mls_group_id(&one_id).is_err());
    assert!(store.find_group_by_mls_group_id(&two_id).is_err());
}

#[cfg(unix)]
#[test]
fn only_the_owner_can_read_the_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    drop(MdkStore::open(&path(&dir), &KEY).unwrap());
    let mode = std::fs::metadata(path(&dir)).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_rollback_that_would_give_two_groups_one_nostr_id_is_refused() {
    use mdk_storage_traits::MdkStorageProvider;
    let dir = tempfile::tempdir().unwrap();
    let store = MdkStore::open(&path(&dir), &KEY).unwrap();
    let mut first = group(1, "first");
    store.save_group(first.clone()).unwrap();
    store
        .create_group_snapshot(&first.mls_group_id, "before")
        .unwrap();
    // The first group moves to another id, and a second group takes its old one.
    first.nostr_group_id = [9; 32];
    store.save_group(first.clone()).unwrap();
    let mut second = group(2, "second");
    second.nostr_group_id = [1; 32];
    store.save_group(second.clone()).unwrap();

    assert!(store
        .rollback_group_to_snapshot(&first.mls_group_id, "before")
        .is_err());
    // Nothing moved: each group keeps its id, and the snapshot is still there.
    assert_eq!(
        store
            .find_group_by_nostr_group_id(&[1; 32])
            .unwrap()
            .unwrap()
            .name,
        "second"
    );
    assert_eq!(
        store
            .find_group_by_nostr_group_id(&[9; 32])
            .unwrap()
            .unwrap()
            .name,
        "first"
    );
    assert_eq!(
        store
            .list_group_snapshots(&first.mls_group_id)
            .unwrap()
            .len(),
        1
    );
}
