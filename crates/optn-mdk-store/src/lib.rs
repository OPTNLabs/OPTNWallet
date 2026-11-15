#![forbid(unsafe_code)]

//! A pure-Rust encrypted store for MDK, the Marmot Development Kit.
//!
//! [`MdkStore`] implements MDK 0.8's `MdkStorageProvider` (its group, message
//! and welcome storage, and the OpenMLS storage provider under them) on
//! [redb](https://docs.rs/redb), with every record sealed before it reaches
//! the database. It takes the place of MDK's SQLCipher store, which is C.
//!
//! - **At rest.** One file. Each record's key is a keyed hash and its value is
//!   XChaCha20-Poly1305 over a padded frame (see `record.rs`). What shows is
//!   the file's size, how many records there are, their padded lengths, and
//!   how many commits were made. Group ids, event ids, public keys, relays,
//!   names, times, epochs, record kinds and content do not.
//! - **Units of work.** MLS changes several records for one event: a commit
//!   merge rewrites the tree, the secrets and the key pairs; a received
//!   message advances a ratchet that cannot be run again. [`MdkStore::begin_unit`]
//!   gathers every write until [`Unit::commit`], which puts them in the
//!   database in one transaction. A crash, a storage fault, or a unit dropped
//!   uncommitted leaves the database as it was. A call made outside a unit is
//!   a unit of its own.
//! - **Queries.** Hashed keys cannot be listed in order, so what MDK asks for
//!   by group or by time is answered from indexes kept in memory and rebuilt
//!   from the records at each open (`index.rs`).
//!
//! Deleting a record frees its pages; it does not overwrite them. Nothing
//! stops someone who can write the file from putting back an older copy of it.
//! Both were true of the SQLCipher store.

mod groups;
mod index;
mod keys;
mod messages;
mod mls;
mod record;
mod snapshots;
mod welcomes;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use mdk_storage_traits::groups::error::GroupError;
use mdk_storage_traits::messages::error::MessageError;
use mdk_storage_traits::welcomes::error::WelcomeError;
use mdk_storage_traits::MdkStorageError;
use redb::{
    Database, DatabaseError, Durability, ReadOnlyTable, ReadableDatabase, ReadableTable,
    ReadableTableMetadata, TableDefinition, TableError,
};
use zeroize::Zeroizing;

use crate::index::Index;
use crate::record::{Crypt, Family};

/// Every record, under its hashed key. The one table: a table per kind of
/// record would show how many of each there are.
const RECORDS: TableDefinition<&[u8; 32], &[u8]> = TableDefinition::new("r");
/// What the header record starts with.
const MAGIC: &[u8] = b"optn-mdk-store";
/// The layout of the store as a whole. A store with a later one is refused.
const FORMAT: u16 = 1;
/// The most redb keeps of the file in memory.
const CACHE_BYTES: usize = 16 * 1024 * 1024;

/// Why a store could not be opened, or stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The file, or the database in it, could not be read or written.
    Io(String),
    /// The file is a store, but not one this key opens.
    WrongKey,
    /// The store was written by a later version of this crate.
    Newer { format: u16 },
    /// Another process has the store open.
    InUse,
    /// A unit of work met a storage fault and was rolled back.
    RolledBack(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(reason) => write!(f, "{reason}"),
            StoreError::WrongKey => write!(f, "the key does not open this store"),
            StoreError::Newer { format } => write!(
                f,
                "the store has format {format}; this build reads up to {FORMAT}"
            ),
            StoreError::InUse => write!(f, "the store is open in another process"),
            StoreError::RolledBack(reason) => write!(f, "rolled back: {reason}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// A storage fault: the database, the cipher or an encoding failed. Distinct
/// from MDK's own refusals (a group that does not exist, a limit exceeded),
/// which are answers, not faults.
#[derive(Debug, Clone)]
pub(crate) struct Fault(String);

impl Fault {
    pub(crate) fn new(reason: impl Into<String>) -> Self {
        Self(reason.into())
    }

    fn database(error: impl std::fmt::Display) -> Self {
        Self(format!("database: {error}"))
    }
}

/// How a storage call ended badly: MDK's kind of answer, or a fault.
pub(crate) enum Failed<E> {
    /// The call is refused, as MDK's stores refuse it. Not a fault: a unit
    /// that met it is still committed.
    Refused(E),
    Fault(Fault),
}

impl<E> From<Fault> for Failed<E> {
    fn from(fault: Fault) -> Self {
        Failed::Fault(fault)
    }
}

/// What a storage call's body returns.
pub(crate) type Outcome<T, E> = Result<T, Failed<E>>;

impl From<Fault> for MdkStorageError {
    fn from(fault: Fault) -> Self {
        MdkStorageError::Database(fault.0)
    }
}

impl From<Fault> for GroupError {
    fn from(fault: Fault) -> Self {
        GroupError::DatabaseError(fault.0)
    }
}

impl From<Fault> for MessageError {
    fn from(fault: Fault) -> Self {
        MessageError::DatabaseError(fault.0)
    }
}

impl From<Fault> for WelcomeError {
    fn from(fault: Fault) -> Self {
        WelcomeError::DatabaseError(fault.0)
    }
}

/// An MDK store in one encrypted file. Cheap to clone; clones are the same
/// store.
#[derive(Clone)]
pub struct MdkStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for MdkStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MdkStore").finish_non_exhaustive()
    }
}

struct Inner {
    database: Database,
    crypt: Crypt,
    state: Mutex<State>,
    created: bool,
}

struct State {
    index: Index,
    /// What the open unit has written and not yet committed: sealed values by
    /// disk key, `None` for a deletion.
    pending: BTreeMap<[u8; 32], Option<Vec<u8>>>,
    /// Units of work open now.
    units: usize,
    /// A storage fault happened in the open unit: it must not be committed.
    faulted: bool,
    /// The store stopped: a commit failed, or the indexes could not be rebuilt.
    stopped: Option<String>,
    /// Records the last scan could not open.
    unreadable: usize,
    #[cfg(any(test, feature = "test-utils"))]
    fail_after: Option<Injected>,
}

/// A fault a test asked for, after so many more writes.
#[cfg(any(test, feature = "test-utils"))]
#[derive(Debug, Clone, Copy)]
enum Injected {
    Fail(usize),
    Abort(usize),
}

/// One call's view of the store: the open unit's writes over the database.
pub(crate) struct Session<'a> {
    inner: &'a Inner,
    state: &'a mut State,
    /// The database as last committed, opened at this call's first read.
    committed: Option<ReadOnlyTable<&'static [u8; 32], &'static [u8]>>,
}

impl MdkStore {
    /// Open the store at `path`, or make one, with the 32-byte `key` the host
    /// derived for it. The file is created readable by its owner alone.
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, StoreError> {
        let crypt = Crypt::new(key);
        owner_only(path)?;
        let database = Database::builder()
            .set_cache_size(CACHE_BYTES)
            .create(path)
            .map_err(|error| match error {
                DatabaseError::DatabaseAlreadyOpen => StoreError::InUse,
                other => StoreError::Io(format!("{}: {other}", path.display())),
            })?;
        let io = |error: Fault| StoreError::Io(format!("{}: {}", path.display(), error.0));

        let header_at = crypt.disk_key(Family::Header, b"");
        let found = {
            let reading = database.begin_read().map_err(Fault::database).map_err(io)?;
            match reading.open_table(RECORDS) {
                Ok(table) => {
                    let header = table
                        .get(&header_at)
                        .map_err(Fault::database)
                        .map_err(io)?
                        .map(|value| value.value().to_vec());
                    let records = table.len().map_err(Fault::database).map_err(io)?;
                    Some((header, records))
                }
                Err(TableError::TableDoesNotExist(_)) => None,
                Err(error) => return Err(io(Fault::database(error))),
            }
        };
        let inner = Inner {
            database,
            crypt,
            state: Mutex::new(State {
                index: Index::default(),
                pending: BTreeMap::new(),
                units: 0,
                faulted: false,
                stopped: None,
                unreadable: 0,
                #[cfg(any(test, feature = "test-utils"))]
                fail_after: None,
            }),
            created: !matches!(found, Some((Some(_), _))),
        };
        match found {
            Some((Some(header), _)) => {
                // Another key finds no header at its own hash, or cannot open this one.
                let record = inner
                    .crypt
                    .open(&header_at, &header)
                    .map_err(|_| StoreError::WrongKey)?;
                let format = record
                    .payload
                    .strip_prefix(MAGIC)
                    .and_then(|rest| <[u8; 2]>::try_from(rest).ok())
                    .map(u16::from_le_bytes)
                    .ok_or(StoreError::WrongKey)?;
                if format > FORMAT {
                    return Err(StoreError::Newer { format });
                }
            }
            // Records, and none of them our header: someone else's store.
            Some((None, records)) if records > 0 => return Err(StoreError::WrongKey),
            Some((None, _)) | None => {
                let mut payload = MAGIC.to_vec();
                payload.extend_from_slice(&FORMAT.to_le_bytes());
                let sealed = inner
                    .crypt
                    .seal(&header_at, Family::Header, b"", &payload)
                    .map_err(io)?;
                inner
                    .commit(BTreeMap::from([(header_at, Some(sealed))]))
                    .map_err(io)?;
            }
        }
        {
            let mut state = inner.state.lock().expect("nothing else holds a new store");
            state.reload(&inner).map_err(io)?;
        }
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Whether [`MdkStore::open`] made this store rather than found it.
    pub fn created(&self) -> bool {
        self.inner.created
    }

    /// Records the last read of the whole store could not open: damaged on
    /// disk, or changed by someone without the key. They are treated as
    /// absent. Zero in a healthy store.
    pub fn unreadable_records(&self) -> usize {
        self.lock().unreadable
    }

    /// Start a unit of work: every write, by any clone of this store, is held
    /// until [`Unit::commit`] and then lands in one transaction. Reads see the
    /// unit's own writes.
    pub fn begin_unit(&self) -> Unit {
        self.lock().units += 1;
        Unit {
            store: self.clone(),
            open: true,
        }
    }

    /// Make the write after the next `writes` fail, as a full disk would.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn fail_after_writes(&self, writes: usize) {
        self.lock().fail_after = Some(Injected::Fail(writes));
    }

    /// End the process at the write after the next `writes`, as a crash
    /// would: for crash tests, in a child process.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn abort_after_writes(&self, writes: usize) {
        self.lock().fail_after = Some(Injected::Abort(writes));
    }

    /// Forget an injected fault that has not happened yet.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn clear_injected(&self) {
        self.lock().fail_after = None;
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                // A panic inside a call: what the unit wrote is not to be trusted.
                let mut state = poisoned.into_inner();
                state
                    .stopped
                    .get_or_insert_with(|| "an earlier storage call panicked".into());
                self.inner.state.clear_poison();
                state
            }
        }
    }

    /// Run one storage call. Outside a unit, the call is a unit of its own.
    /// A fault marks the unit it happened in, which is then not committed.
    pub(crate) fn run<T, E>(
        &self,
        work: impl FnOnce(&mut Session<'_>) -> Outcome<T, E>,
    ) -> Result<T, E>
    where
        E: From<Fault>,
    {
        let mut state = self.lock();
        if let Some(reason) = &state.stopped {
            return Err(Fault::new(format!("the store stopped: {reason}; reopen it")).into());
        }
        let mut session = Session {
            inner: &self.inner,
            state: &mut state,
            committed: None,
        };
        let out = work(&mut session);
        drop(session);
        let out = match out {
            Ok(value) => Ok(value),
            Err(Failed::Refused(answer)) => Err(answer),
            Err(Failed::Fault(fault)) => {
                state.faulted = true;
                Err(E::from(fault))
            }
        };
        if state.units == 0 {
            if let Err((fault, _)) = state.settle(&self.inner) {
                // A failed call has said why already; a successful one whose
                // commit failed says so now.
                if out.is_ok() {
                    return Err(E::from(fault));
                }
            }
        }
        out
    }
}

impl Inner {
    /// Put `writes` in the database in one durable transaction.
    fn commit(&self, writes: BTreeMap<[u8; 32], Option<Vec<u8>>>) -> Result<(), Fault> {
        let mut transaction = self.database.begin_write().map_err(Fault::database)?;
        transaction
            .set_durability(Durability::Immediate)
            .map_err(Fault::database)?;
        // Two-phase commit, and the allocator state saved with each commit:
        // recovery after a crash does not depend on a non-cryptographic
        // checksum, nor on walking the whole file.
        transaction.set_quick_repair(true);
        {
            let mut table = transaction.open_table(RECORDS).map_err(Fault::database)?;
            for (key, value) in &writes {
                match value {
                    Some(value) => {
                        table
                            .insert(key, value.as_slice())
                            .map_err(Fault::database)?;
                    }
                    None => {
                        table.remove(key).map_err(Fault::database)?;
                    }
                }
            }
        }
        transaction.commit().map_err(Fault::database)
    }

    /// Read every record and build the indexes from them.
    fn scan(&self) -> Result<(Index, usize), Fault> {
        let reading = self.database.begin_read().map_err(Fault::database)?;
        let table = reading.open_table(RECORDS).map_err(Fault::database)?;
        let mut index = Index::default();
        let mut unreadable = 0;
        for row in table.iter().map_err(Fault::database)? {
            let (key, value) = row.map_err(Fault::database)?;
            let indexed = self
                .crypt
                .open(key.value(), value.value())
                .and_then(|record| index.wrote(record.family, &record.key, &record.payload));
            if indexed.is_err() {
                unreadable += 1;
            }
        }
        Ok((index, unreadable))
    }
}

impl State {
    /// End the unit: commit what it wrote, or, after a fault, forget it.
    /// On failure, says whether the store has stopped.
    fn settle(&mut self, inner: &Inner) -> Result<(), (Fault, bool)> {
        let faulted = std::mem::take(&mut self.faulted);
        let pending = std::mem::take(&mut self.pending);
        if faulted {
            if !pending.is_empty() {
                // Nothing reached the database. The indexes learned of the
                // writes as they were made; read them back from what is there.
                self.reload(inner).map_err(|fault| (fault, true))?;
            }
            return Err((Fault::new("a storage call failed"), false));
        }
        if pending.is_empty() {
            return Ok(());
        }
        inner.commit(pending).map_err(|fault| {
            self.stopped = Some(fault.0.clone());
            (fault, true)
        })
    }

    fn reload(&mut self, inner: &Inner) -> Result<(), Fault> {
        match inner.scan() {
            Ok((index, unreadable)) => {
                self.index = index;
                self.unreadable = unreadable;
                Ok(())
            }
            Err(fault) => {
                self.stopped = Some(fault.0.clone());
                Err(fault)
            }
        }
    }
}

impl Session<'_> {
    pub(crate) fn index(&self) -> &Index {
        &self.state.index
    }

    /// A record's payload, if the record exists.
    pub(crate) fn get(
        &mut self,
        family: Family,
        key: &[u8],
    ) -> Result<Option<Zeroizing<Vec<u8>>>, Fault> {
        let found = self.read(family, key);
        self.note(found)
    }

    pub(crate) fn put(&mut self, family: Family, key: &[u8], payload: &[u8]) -> Result<(), Fault> {
        let wrote = self.write(family, key, Some(payload));
        self.note(wrote)
    }

    pub(crate) fn delete(&mut self, family: Family, key: &[u8]) -> Result<(), Fault> {
        let wrote = self.write(family, key, None);
        self.note(wrote)
    }

    /// A fault anywhere in a unit means the unit is not committed.
    fn note<T>(&mut self, result: Result<T, Fault>) -> Result<T, Fault> {
        if result.is_err() {
            self.state.faulted = true;
        }
        result
    }

    fn read(&mut self, family: Family, key: &[u8]) -> Result<Option<Zeroizing<Vec<u8>>>, Fault> {
        let at = self.inner.crypt.disk_key(family, key);
        let record = match self.state.pending.get(&at) {
            Some(Some(value)) => self.inner.crypt.open(&at, value)?,
            Some(None) => return Ok(None),
            None => {
                if self.committed.is_none() {
                    let reading = self.inner.database.begin_read().map_err(Fault::database)?;
                    self.committed = Some(reading.open_table(RECORDS).map_err(Fault::database)?);
                }
                let table = self.committed.as_ref().expect("opened above");
                match table.get(&at).map_err(Fault::database)? {
                    Some(value) => self.inner.crypt.open(&at, value.value())?,
                    None => return Ok(None),
                }
            }
        };
        if record.family != family || record.key != key {
            return Err(Fault::new("a record is not the one asked for"));
        }
        Ok(Some(record.payload))
    }

    fn write(&mut self, family: Family, key: &[u8], payload: Option<&[u8]>) -> Result<(), Fault> {
        #[cfg(any(test, feature = "test-utils"))]
        match self.state.fail_after {
            Some(Injected::Fail(0)) => {
                self.state.fail_after = None;
                return Err(Fault::new("a write failed (injected)"));
            }
            Some(Injected::Abort(0)) => std::process::abort(),
            Some(Injected::Fail(left)) => self.state.fail_after = Some(Injected::Fail(left - 1)),
            Some(Injected::Abort(left)) => self.state.fail_after = Some(Injected::Abort(left - 1)),
            None => {}
        }
        let at = self.inner.crypt.disk_key(family, key);
        match payload {
            Some(payload) => {
                let sealed = self.inner.crypt.seal(&at, family, key, payload)?;
                self.state.index.wrote(family, key, payload)?;
                self.state.pending.insert(at, Some(sealed));
            }
            None => {
                self.state.index.deleted(family, key)?;
                self.state.pending.insert(at, None);
            }
        }
        Ok(())
    }
}

/// A unit of work, from [`MdkStore::begin_unit`]. Dropped without
/// [`Unit::commit`], it leaves the database as it was.
#[must_use = "a unit that is not committed is rolled back"]
pub struct Unit {
    store: MdkStore,
    open: bool,
}

impl Unit {
    /// Make the unit's writes durable, all of them or none. If a storage call
    /// failed inside the unit, nothing is written and this says so.
    pub fn commit(mut self) -> Result<(), StoreError> {
        self.open = false;
        let mut state = self.store.lock();
        state.units = state.units.saturating_sub(1);
        if state.units > 0 {
            return Ok(());
        }
        state
            .settle(&self.store.inner)
            .map_err(|(fault, stopped)| match stopped {
                true => StoreError::Io(fault.0),
                false => StoreError::RolledBack(fault.0),
            })
    }
}

impl Drop for Unit {
    fn drop(&mut self) {
        if !self.open {
            return;
        }
        let mut state = self.store.lock();
        state.units = state.units.saturating_sub(1);
        if state.units == 0 {
            state.faulted = true;
            // Rolled back; an error here has already stopped the store.
            let _ = state.settle(&self.store.inner);
        }
    }
}

/// Make sure the file exists and only its owner can read it, before the
/// database writes anything into it. Windows files take their folder's
/// access list; the app-data folder is the user's own.
fn owner_only(path: &Path) -> Result<(), StoreError> {
    let io = |error: std::io::Error| StoreError::Io(format!("{}: {error}", path.display()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .map_err(io)?;
            }
            Ok(())
        }
        Err(error) => Err(io(error)),
    }
}

#[cfg(test)]
mod tests;
