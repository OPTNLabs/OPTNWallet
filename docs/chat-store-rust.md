# A pure-Rust encrypted store for MDK chat (design, not yet built)

Status: **design for approval, 2026-11-15.** Nothing here is implemented. Base:
`agent/deps-bitcoinjs-20261114` at 29430001 (PR #123).

## Why

The desktop chat's MDK store is SQLCipher: C, plus OpenSSL built from source
off Apple platforms. It is the one C database in the wallet. RUSTSEC-2026-0459
cost two vendored crates (`mdk-sqlite-storage` 0.8.0, `refinery-core` 0.9.2), a
licence exception for `sqlcipher-src`, and Strawberry Perl on Windows builds.
`ChatEngine<S: MdkStorageProvider>` is already generic over the store, so the
store can be replaced without touching MDK, which stays as published.

## What was checked first

- **Neither MDK store makes an epoch change atomic.** OpenMLS 0.8.2 merges a
  commit with about nine separate storage calls (`public_group.store` writes
  tree, confirmation tag, context and interim transcript hash; then epoch
  secrets, message secrets, epoch key pairs, old key pairs deleted, proposal
  queue cleared: `staged_commit.rs`). `mdk-sqlite-storage` runs each one as its
  own autocommit statement (`with_connection`); it opens a transaction only for
  snapshot create, snapshot restore, `delete_group` and relay replacement. A
  crash between those calls leaves a group half in the new epoch today.
- **A received message is one-shot.** OpenMLS's `process_message` writes the
  advanced ratchet (`write_message_secrets`, "to ensure forward secrecy") and
  MDK then saves the message and its processed record, again as separate
  calls. If the ratchet is saved and the message is not, the message cannot be
  decrypted again.
- **MDK chat has not shipped in a tagged release.** `crates/optn-chat` arrived
  in 48e897cd on 2026-11-09 and is on `origin/dev` only; the newest local tags
  (`v1.7.4`, `v1.7.4-beta.82`) are from 2026-09-15 and do not contain it. A
  SQLCipher chat store can only have come from a dev or preview build.
- **Message bodies are small.** The renderer's chat layer caps an inline file
  at 100,000 characters (`MAX_INLINE_CHAT_DATA_URL`, `chat.ts`). The Rust
  engine sets no cap of its own; what a peer sends is bounded by what relays
  accept. A `Message` stores its content twice (`content` and `event`).
- **SQLCipher does not erase deleted rows here either.** Neither
  `libsqlite3-sys` 0.40's build nor MDK sets `secure_delete`.
- **Spike (throwaway, in the session scratchpad, not in the repo):** redb 4.6.0
  with XChaCha20-Poly1305 values and HMAC-SHA256 keys, Windows 11, rustc
  1.98.1. Builds in 10 s and adds no transitive crate. A durable unit of 8
  records took 1.7 to 2.3 ms. Reads inside an open write transaction see its
  writes. A dropped transaction, and one cut off by `process::abort()`, left
  nothing behind on reopen (2 ms). Scanning and decrypting 50.8 MiB took 95 ms.
  No key or value plaintext was found in the file. The file was 148 MiB for
  50 MiB of 128 KiB values: redb allocates large values in power-of-two pages.
  A killed process is not a power cut; power-loss safety rests on redb's
  design and was not tested.
- **Advisories and licences for that dependency set** (redb 4.6.0,
  `chacha20poly1305` 0.10.1, `hmac` 0.12.1, `sha2` 0.10.9 and what they pull
  in, 26 crates), on 2026-11-15: `cargo audit` 0.22.2 exited 0 against 1,509
  advisories. `cargo deny` 0.20.2 with this repository's `deny.toml` reported
  advisories, bans and sources ok; its one licence error was the spike crate
  itself, which declares no licence.

## Decisions

### 1. Storage engine: redb, not a snapshot file

| | redb 4.6 | Encrypted snapshot of an in-memory store |
| --- | --- | --- |
| Durability | Copy-on-write B-tree, one file, `fsync` per commit | Whole file rewritten and renamed per write |
| Atomicity across records | One write transaction covers any number of records | Only by rewriting everything; a split (state file plus message files) loses it, and with it messages |
| Crash recovery | Checksummed pages, two commit slots, repair on open | Rename is atomic; on Windows a rename over a file another process holds fails |
| Cost per write | Pages touched | Whole store, growing with history |
| New code | Key and value layer, indexes | Serialisation of everything, a log if rewriting is too slow (a database by hand) |
| Dependencies | `redb` only (MIT OR Apache-2.0, no dependencies on Windows, `libc` on Linux and Apple) | none |

**Recommendation: redb, pinned `=4.6.0`.** Considered and set aside: `fjall`
(LSM: many files, background threads, old values live until compaction),
`sled` (1.0 still alpha), `native_db` (a layer over redb, not needed),
page-level encryption through redb's `StorageBackend` (that is designing a
disk-encryption scheme: hand-rolled crypto).

Cautions: 4.6.0 is two days old (2026-11-13) and 4.5.0 (2026-11-05) added
multi-process locking. 4.6.0 fixes a repair bug that could open a damaged
database as an empty one, so older is not safer. redb has 40 lines of `unsafe`
(its XXH3, file locks, sync primitives). The 5.0 notes shipped inside 4.6.0
list many API breaks and say the file format is unchanged, so the next major
is a code change here, not a data migration. `cargo audit` and `cargo deny`
passed on the spike's lockfile (above) and must pass again on the real ones.

**The store does better than SQLCipher on atomicity.** The engine already runs
every MDK call inside one closure (`ChatEngine::mdk`). The store opens one redb
write transaction for that closure and commits it when the closure returns,
whether MDK returned `Ok` or `Err` (MDK records failures on purpose). A panic
or a crash drops the transaction. So a commit merge, a welcome
(`process_welcome` + `accept_welcome`), a group creation, and a received
message with its ratchet step each land whole or not at all. A trait call made
outside a unit commits by itself, as SQLite does. Commits use
`Durability::Immediate` with quick-repair on (two-phase commit, near-instant
recovery). If a commit fails, the store refuses further work until reopened:
`ChatError::Stopped` already means that.

The engine stays generic. The store is a cheap handle (`Clone` over an `Arc`);
`ChatEngine::open` keeps one clone to open and close units around `mdk()`, and
gives the other to `MDK::new`. `ChatEngine::new`, which the tests use with
MDK's memory store, keeps its `S: MdkStorageProvider` bound and has no units.

MIP-03 snapshots stay copies of the group's records, as both MDK stores do:
redb's own savepoints roll back the whole database, not one group.

### 2. Encryption at rest

Established crates only, all already in the lockfile: `chacha20poly1305`
0.10 (RustCrypto; NCC Group reviewed the implementation in 2020 with no
significant findings), `hmac`, `hkdf`, `sha2`, `zeroize`, OS randomness. No
new primitive and no new construction beyond AEAD with associated data and a
keyed hash as a lookup key.

- **Input:** a 32-byte root derived from the chat identity, as today.
  Recommended: a new HKDF label (`mdk rust store v1`) beside the existing
  `store_key`, so the SQLCipher key is never reused for another cipher.
- **Sub-keys:** HKDF-SHA256 expand of the root into a value key and an index
  key.
- **Values:** `version || nonce(24) || XChaCha20-Poly1305(padded record)`, with
  the on-disk key as associated data, so a value moved to another key does not
  open. Random 192-bit nonces need no counter. Records are MDK's own postcard
  (`MlsCodec`) and serde encodings, padded to size buckets.
- **Keys:** `HMAC-SHA256(index key, record family || logical key)`, 32 bytes,
  in one table. Exact lookups work; nothing on disk orders or groups records.
- **Queries that need order or enumeration** (messages of a group by time,
  records after an epoch, pending welcomes, all groups, snapshots) use
  in-memory indexes rebuilt at open by one decrypting scan. They are derived
  data: there is no on-disk index to go stale.
- **Wrong key:** a header record that must authenticate; otherwise open fails
  and writes nothing.

**Visible on disk:** file size; the number of records; each value's padded
length (an inline file stands out from a text message); how many commits were
ever made (redb's transaction counter); which pages changed, to someone with
two copies; one constant table name. **Not visible:** group ids, event ids,
public keys, relay URLs, names, timestamps, epochs, record types, content.

This is more than SQLCipher shows (file size and a salt), because SQLCipher
encrypts whole pages. I think it is acceptable for a file inside the app-data
directory, and it needs the owner's yes (question 2).

Deleted records are not erased from free pages; neither are SQLCipher's today.

### 3. Existing SQLCipher stores: a product decision

MDK's keys are random and live only in the store (`docs/chat-mdk.md`): a store
not carried over is its groups lost until someone re-invites the holder.

- **A. Convert once inside the wallet.** A reader opens the old file with
  `rusqlite` directly (no `mdk-sqlite-storage`, no `refinery`) and copies its
  16 tables in one transaction; the old file is kept, renamed. OpenMLS rows
  copy byte for byte (same postcard encoding); MDK rows are rebuilt from
  columns. Cost: SQLCipher, OpenSSL-from-source, Strawberry Perl, the
  `sqlcipher-src` exception and `libsqlite3-sys` advisories stay for at least
  one release, plus about 600 lines of converter and its tests.
- **B. Start fresh.** The wallet is free of C at once. Anyone with MDK groups
  from a dev or preview build loses them and is re-invited. ts-mls groups are
  untouched.
- **C. Start fresh, with a separate converter tool** outside the shipped
  workspace (own lockfile), for the few who have a store worth keeping.

**Recommendation: B**, because no tagged release contains MDK chat. C if a
tester's groups matter. A only if a preview build reached people who cannot be
asked to rejoin.

### 4. Proving equivalence

1. **One suite, every store.** Make `persistent_store.rs` and `group_chat.rs`
   generic over the store and run them on MDK's memory store, the SQLCipher
   store (until removed) and the new one.
2. **MDK's own storage tests.** The published crates carry about 200 inline
   tests in the SQLite store and 117 in the memory store, not a shared suite.
   Port those that use only trait methods (MIT, attributed) into a
   backend-generic suite, using `mdk-storage-traits`' `test-utils` fixtures.
3. **Differential test.** Drive the same random sequence of trait calls into
   the memory store and the new store and compare every read (the memory store
   sized so it never evicts).
4. **Crash and reopen.** Kill a child process inside a unit at each storage
   call of a commit merge and of a received message; reopen; the group is at
   the old epoch or the new one, never between, and the message is either
   stored or still readable from the relay.
5. **Wrong key, damage, tampering.** Another identity's key fails; a flipped
   byte in a value fails that record without a panic; a value copied over
   another key fails; a truncated file reports corruption, not an empty store.
6. **Nothing readable on disk**, as `persistent_store.rs` asserts today.
7. **Conversion** (option A or C only): the `sqlcipher-4.6.1` fixture
   converts, shows the same group and history, and a live conversation
   continues after conversion.

### 5. What is removed once it lands

With option B or C, in the same change; with A, one release later:

- `crates/optn-chat`: the `sqlite` feature, `mdk-sqlite-storage`, the
  `libsqlite3-sys` target dependency, `tests/sqlcipher_upgrade.rs` and
  `tests/fixtures/sqlcipher-4.6.1/`.
- `vendor/mdk-sqlite-storage-0.8.0`, `vendor/refinery-core-0.9.2`, and their
  `[patch.crates-io]` lines in `Cargo.toml` and `src-tauri/Cargo.toml`.
- `.github/workflows/rust-quality.yml`: the two "Preserve vendored ...
  advisory coverage" steps for those crates.
- `deny.toml`: the `sqlcipher-src` exception.
- `desktop-preview.yml` and `release.yml`: "Use Strawberry Perl for OpenSSL".
- From `Cargo.lock` and `src-tauri/Cargo.lock`: `rusqlite`, `libsqlite3-sys`,
  `sqlcipher-src`, `openssl-src`, `openssl-sys`, `refinery*`, `keyring-core`,
  `hashlink` and the `fallible-*` iterators, where nothing else needs them.
- `docs/chat-mdk.md` (Store row, Building section), `src-tauri/src/chat_mdk.rs`
  and `src-tauri`'s `mdk-chat` feature, updated to the new store.

`vendor/mdk-memory-storage-0.8.0` stays: it is the tests' reference store.

## Trait methods to implement (93)

**`MdkStorageProvider` (7):** `backend`, `create_group_snapshot`,
`rollback_group_to_snapshot`, `release_group_snapshot`, `list_group_snapshots`,
`prune_expired_snapshots`, `delete_group`. `backend()` must report a
persistent backend so MDK hydrates snapshots after a restart; the enum has only
`Memory` and `SQLite`, so it returns `SQLite` (question 4).

**`GroupStorage` (16, plus the provided `groups_needing_self_update`):**
`all_groups`, `find_group_by_mls_group_id`, `find_group_by_nostr_group_id`,
`save_group`, `messages`, `last_message`, `admins`, `group_relays`,
`replace_group_relays`, get and save for the group-event, legacy and
encrypted-media exporter secrets (6),
`prune_group_exporter_secrets_before_epoch`.

**`MessageStorage` (12):** `save_message`, `find_message_by_event_id`,
`save_processed_message`, `find_processed_message_by_event_id`,
`invalidate_messages_after_epoch`, `invalidate_processed_messages_after_epoch`,
`find_failed_messages_for_retry`, `find_invalidated_messages`,
`find_invalidated_processed_messages`, `mark_processed_message_retryable`,
`find_message_epoch_by_tag_content`, `delete_messages_for_group`.

**`WelcomeStorage` (5):** `save_welcome`, `find_welcome_by_event_id`,
`pending_welcomes`, `save_processed_welcome`,
`find_processed_welcome_by_event_id`.

**OpenMLS `StorageProvider<1>` (53; the three `extensions-draft-08` methods
are not compiled, as in both MDK stores):**

- Group state, write/read/delete for each of ten kinds (30): join config,
  tree, interim transcript hash, context, confirmation tag, group state,
  message secrets, resumption PSK store, own leaf index, group epoch secrets.
- Own leaf nodes (3): `append_own_leaf_node`, `own_leaf_nodes`,
  `delete_own_leaf_nodes`.
- Proposals (5): `queue_proposal`, `queued_proposal_refs`, `queued_proposals`,
  `remove_proposal`, `clear_proposal_queue`.
- Keys, write/read/delete (15): signature key pair, encryption key pair,
  encryption epoch key pairs, key package, PSK.

Beyond signatures, the store must match MDK's validation (limits, "group not
found", pagination bounds 1..=10,000), its sort orders, and the snapshot scope
both MDK stores share: MLS group data, proposals, own leaf nodes, epoch key
pairs, the group, its relays and its three exporter-secret families.

## Size and risk

| Part | Lines (estimate) |
| --- | --- |
| Encrypted record layer, units, open and header | 700 |
| In-memory indexes and the open scan | 600 |
| MDK traits (groups, messages, welcomes, snapshots, delete) | 1,400 |
| OpenMLS `StorageProvider` | 700 |
| Engine wiring (`open`, unit bracketing, desktop module) | 200 |
| Tests (ported, differential, crash, tamper) | 3,000 |
| Converter, option A or C only | 600 + tests |

About 3,600 lines of store and 3,000 of tests, against about 11,400 for MDK's
SQLite store with its tests: there is no SQL, schema, migration, keyring or
file-permission layer to write. A new crate
(`crates/optn-mdk-store`) is recommended over a module in `optn-chat`: it
implements MDK's traits and nothing chat-specific.

| Risk | Level | Answer |
| --- | --- | --- |
| A behavioural difference from MDK's stores corrupts a group | High impact, medium likelihood | Ported MDK tests, differential test, two-engine conversation tests |
| MDK 0.9+ changes the traits (git `main` is at 0.12) | Certain eventually | Both MDK stores change too; the differential test shows what moved |
| redb defect or format change | Low likelihood, high impact | Exact pin, crash tests, `check_integrity` in tests; the 5.0 notes say the format is unchanged |
| The old store set file permissions and this one must too | Low | Create the file owner-only, as `mdk-sqlite-storage`'s `permissions.rs` does; test on Unix and Windows |
| Open cost grows with history | Low | 537 MiB/s measured; a format version byte leaves room for on-disk indexes |
| More metadata visible than SQLCipher | Certain, modest | Padding; owner's decision (question 2) |
| File about 3x payload for large values | Low | Choose padding buckets that fit redb's page sizes; `compact()` |
| The store's own format needs versioning forever | Certain | Version byte in the header record and in every value from day one |

## Not in scope

- MDK itself: it stays `mdk-core` 0.8.0 as published.
- The ts-mls engine and its renderer-side store.
- Android and iOS: they build no chat.
- The engine's plain state file (`<pubkey>.state.json`): it holds nothing
  secret and stays beside the store. The new store file is
  `<pubkey>.mdk.redb` in the same `chat-mdk` directory.

## Build order once approved

1. The encrypted record layer and units, with the wrong-key, tamper and crash
   tests. Nothing of MDK yet.
2. OpenMLS `StorageProvider`, then the MDK traits, each against the ported
   tests and the differential test as it is written.
3. `ChatEngine::open` on the new store behind a new `store` feature; the
   conversation tests on all stores.
4. The desktop module and `mdk-chat` feature switched over; the removals of
   section 5; lockfiles regenerated; `cargo audit`, `cargo deny`, Clippy and
   `xtask architecture` on the result.
5. A desktop build on Windows without `OPENSSL_SRC_PERL`, and a live chipnet
   conversation with a restart in the middle.

## Open questions for the owner

1. **Migration:** start fresh (B, recommended), fresh plus a separate converter
   tool (C), or convert inside the wallet and keep SQLCipher one more release
   (A)? Did any preview build with MDK chat reach people whose groups matter?
2. **Metadata:** is it acceptable that record count, padded record sizes and
   the commit count are visible on disk, where SQLCipher showed only file size?
3. **redb version:** pin `=4.6.0`, released two days ago, or wait for it to
   age first?
4. **`backend()`** has to return `Backend::SQLite` for MDK to treat the store
   as persistent, although nothing in it is SQLite. Accept that, with a
   comment, until MDK's enum grows?
5. **New crate** `crates/optn-mdk-store`, or a module inside `optn-chat`?
6. **Store key label:** a new HKDF label for the new store (recommended), or
   reuse today's 32 bytes?
