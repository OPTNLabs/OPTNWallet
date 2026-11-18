# Vendored mdk-sqlite-storage 0.8.0

Source: https://static.crates.io/crates/mdk-sqlite-storage/mdk-sqlite-storage-0.8.0.crate

Archive SHA-256:
`865eeb78d12a90d53aaabd8f2b1dba97893e82b67f13bd6d8a2693092813528d`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept, with name and version unchanged,
except its `Cargo.lock`: upstream's own development lockfile, which OPTN's
builds never read and which still names the vulnerable crate this patch
removes. This is a path patch from `[patch.crates-io]` in the root and
`src-tauri` manifests, so optn-chat's `sqlite` feature (the desktop's chat
store) resolves it as before. The import commit adds the published files
unchanged; the commit after it holds every change below.

## Why

It requires `rusqlite 0.37`, whose `libsqlite3-sys 0.35.0` bundles SQLCipher
4.6.1 on SQLite 3.46.1. SQLite before 3.54.0 has RUSTSEC-2026-0459
(CVE-2026-119375): a database opened with a `-wal` file of another page size
can return uninitialised page-cache memory.

The advisory's patched range starts at `libsqlite3-sys 0.39.0`, but that is
plain SQLite. This crate builds SQLCipher (`bundled-sqlcipher`), and in 0.39.0
and 0.39.1 that is `sqlcipher-src =419.0.6`: SQLCipher 4.19.0 on SQLite
3.53.4, still affected, as the advisory says. The first SQLCipher on a fixed
SQLite is 4.20.0 (SQLite 3.54.1), which is `sqlcipher-src 420.0.0`,
`libsqlite3-sys 0.40.0` and `rusqlite 0.42.0`. So this copy goes to 0.42, not
0.41.

No release fixes it. `mdk-sqlite-storage 0.8.0` is the latest on crates.io.
MDK's `main` has no fix to backport either: this crate was replaced there by
another codebase (`crates/storage-sqlite`, marmot-protocol/mdk@9db9dbc092),
which is on `rusqlite 0.40.1` with a git pin of `libsqlite3-sys`
(rusqlite/rusqlite@5ae7fdf8, SQLCipher 4.17.0 on SQLite 3.53.3), itself still
affected, and a git source OPTN's `deny.toml` refuses.

## Local changes

- `Cargo.toml`: `rusqlite` 0.37 -> 0.42, with two features beside
  `bundled-sqlcipher`. No source file changes: with them the crate compiles as
  published.
  - `cache`: rusqlite 0.38 made the prepared-statement cache optional
    (rusqlite/rusqlite#1682). `Connection::prepare_cached` and
    `CachedStatement`, which the group-snapshot code in `src/lib.rs` uses,
    exist only with it. In 0.37 the cache was always built. MDK's own manifest
    enables `cache` on rusqlite 0.40.
  - `fallible_uint`: rusqlite 0.38 put `ToSql` and `FromSql` for `u64` and
    `usize` behind this feature (rusqlite/rusqlite#1732). This crate binds and
    reads `u64` timestamps, epochs and counts (`src/db.rs`, `groups.rs`,
    `messages.rs`, `welcomes.rs`). The feature brings back the same
    conversions, from macros that are identical in 0.37.0 and 0.42.0: a value
    above `i64::MAX` still fails to bind and a negative column still fails to
    read.

  `default-features = false` stays, as published.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

Its migrations run through `refinery`, whose `refinery-core 0.9.2` refuses
rusqlite above 0.39; `vendor/refinery-core-0.9.2` raises that bound and moves
with this copy.

OPTN's lockfiles gain `sqlcipher-src`, the SQLCipher source libsqlite3-sys
0.40 builds instead of carrying its own, and `sqlite-wasm-rs` with
`rsqlite-vfs`. rusqlite 0.42's `bundled-sqlcipher` names
`sqlite-wasm-rs?/sqlcipher`, and Cargo locks such a dependency whether or not
anything enables it; it is for `wasm32-unknown-unknown` only, and no native
build compiles it.

## SQLCipher 4.6.1 -> 4.20.0

Nothing about how a store is keyed or laid out changes. This crate still
opens it with `PRAGMA key = "x'<64 hex>'"` (a raw 32-byte key, so no
passphrase KDF) and then `PRAGMA cipher_compatibility = 4`.

- Format defaults are the same in both sources (`sqlcipher/sqlite3.c` of
  libsqlite3-sys 0.35.0 and `sqlcipher.c` of sqlcipher-src 420.0.0): 4096-byte
  pages, PBKDF2-HMAC-SHA512 at 256000 iterations, HMAC-SHA512 page MACs, no
  plaintext header, `cipher_memory_security` off.
- SQLCipher 4.7.0's breaking changes do not reach it: a `SELECT` before the
  key is now refused, and this crate sets the key first; the build must define
  `SQLITE_EXTRA_INIT`/`SQLITE_EXTRA_SHUTDOWN`, a thread-safe mode and
  `SQLITE_TEMP_STORE` 2 or 3, which libsqlite3-sys 0.40.0 does; OpenSSL must be
  3.0 or newer, and it is 3.6.
- The crypto provider is unchanged: OpenSSL off Apple platforms, CommonCrypto
  on them. sqlcipher-src also ships libtomcrypt, which libsqlite3-sys does not
  compile.
- libsqlite3-sys 0.40.0 no longer defines `SQLITE_ENABLE_MEMORY_MANAGEMENT`
  for the bundled build (rusqlite/rusqlite#1900); nothing here uses it.

`crates/optn-chat/tests/sqlcipher_upgrade.rs` opens a store optn-chat wrote
at 48e897cd under SQLCipher 4.6.1 (`tests/fixtures/sqlcipher-4.6.1/`) with
its identity's key, reads its group, members and messages, deletes the group,
finds it gone after reopening, and checks that another identity's key is
still refused. It also checks the linked SQLite is 3.54.0 or newer, which no
advisory scanner can: a store back on SQLCipher 4.19 would satisfy the
advisory's range. `tests/persistent_store.rs` runs a new store end to end.

## Advisory coverage

Scanners skip a path package, so CI's Rust dependency policy job audits the
registry crate this replaces, with the repository's `deny.toml`, which ignores
nothing. `scripts/check-vendored-advisories.py` passes it only if every
advisory found is in that step's `REPAIRED_IN_VENDOR` list (RUSTSEC-2026-0459),
the one this copy repairs; a new advisory against the crate fails the job.

## Remove when

`mdk-sqlite-storage` on crates.io requires `rusqlite >= 0.42` (libsqlite3-sys
0.40 or newer), or optn-chat leaves MDK 0.8. Then drop both
`[patch.crates-io]` entries, this directory and `vendor/refinery-core-0.9.2`
together, unless that copy is still needed on its own terms.
