# Vendored refinery-core 0.9.2

Source: https://static.crates.io/crates/refinery-core/refinery-core-0.9.2.crate

Archive SHA-256:
`24eeafd893124f29183dd6afa9137a27e7bef59250223b8b660005279c60aea4`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept, with name and version unchanged,
except its `Cargo.lock`: upstream's own development lockfile, which OPTN's
builds never read and which names the vulnerable crate this patch moves off.
The published crate ships no licence file; its manifest declares
`MIT OR Apache-2.0`, and the texts are in https://github.com/rust-db/refinery.
This is a path patch from `[patch.crates-io]` in the root and `src-tauri`
manifests, so `refinery 0.9.2` and `refinery-macros 0.9.2`, which
`mdk-sqlite-storage 0.8.0` (optn-chat's SQLCipher store) runs its migrations
with, resolve it as before. The import commit adds the published files
unchanged; the commit after it holds every change below.

## Why

It accepts `rusqlite >= 0.23, <= 0.39`. The store needs `rusqlite 0.42`, the
first whose SQLCipher is on a SQLite without RUSTSEC-2026-0459; see
`vendor/mdk-sqlite-storage-0.8.0/OPTN.md`, which this copy moves with. Cargo
links one `libsqlite3-sys`, so one crate held at 0.39 holds the store there.

No release accepts 0.42. `refinery-core 0.10.1`, the latest on crates.io,
stops at 0.41, as does `main` (rust-db/refinery@1d31d289a6), and no pull
request or issue asks for 0.42 yet. Upstream raises this bound one rusqlite
release at a time, each time by this one line of `refinery_core/Cargo.toml`
and no source change: rust-db/refinery#425 (0.39), #445 (0.40) and #457
(0.41). This copy does the same for 0.42.

It stays on 0.9.2 rather than moving to 0.10: `mdk-sqlite-storage 0.8.0`
requires `refinery 0.9`, 0.10.1 would need the same patch, and 0.9.2 is what
OPTN's lockfiles already resolve, so the migration runner and the checksums it
keeps in the store's `_refinery_schema_history_nostr_mls` table are untouched.

## Local changes

- `Cargo.toml`: the `rusqlite` requirement `>= 0.23, <= 0.39` ->
  `>= 0.23, <= 0.42`. The driver (`src/drivers/rusqlite.rs`, byte-identical in
  0.9.2 and 0.10.1) calls `Connection::prepare`, `transaction` and
  `execute_batch`, `Statement::query`, `Rows::next`, `Row::get` and
  `Transaction::commit`, and `src/drivers/config.rs` calls
  `Connection::open_with_flags`; all have the same signatures in 0.42.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

The dependency keeps rusqlite's default features on, as upstream declares it.
In 0.42 those are `cache`, which the store enables itself, and
`ffi-sqlite-wasm-rs`, which selects a dependency on `wasm32-unknown-unknown`
only, a target no build of the store has.

`crates/optn-chat/tests/sqlcipher_upgrade.rs` opens a store whose migrations
this crate's published build applied under rusqlite 0.37, which this copy must
find already applied with matching checksums, and `tests/persistent_store.rs`
applies them to a new store.

## Advisory coverage

CI's Rust dependency policy job audits the registry crate this replaces, as
for `vendor/mdk-sqlite-storage-0.8.0`, with the `rusqlite` feature the store
enables: there it resolves `rusqlite 0.39`, and the step passes only if every
advisory found is RUSTSEC-2026-0459, the one this copy lets the store leave
behind.

## Remove when

A `refinery-core` release that `mdk-sqlite-storage`'s `refinery` requirement
resolves accepts `rusqlite 0.42`, or `vendor/mdk-sqlite-storage-0.8.0` goes.
Then drop both `[patch.crates-io]` entries and this directory.
