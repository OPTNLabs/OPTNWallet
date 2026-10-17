# Vendored mdk-memory-storage 0.8.0

Source: https://static.crates.io/crates/mdk-memory-storage/mdk-memory-storage-0.8.0.crate

Archive SHA-256:
`66cf685d2eefc45e37b2fd739beb0419fcc58a229a53c096090010f86bc66c12`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept, with name and version unchanged.
This is a path patch from `[patch.crates-io]` in the root manifest. optn-chat
uses it only as a dev-dependency: its tests' in-memory MDK store.

## Why

It requires `lru 0.16`, which has RUSTSEC-2026-0253 (use-after-free when a key's
`Drop` panics inside `LruCache::pop`), fixed only in `lru >= 0.18.2`.
`mdk-memory-storage 0.8.0` is the latest on crates.io; MDK has moved on only on
GitHub, in a different crate layout.

## Local changes

- `Cargo.toml`: `lru` 0.16 -> 0.18. The crate calls `LruCache::new`, `peek`,
  `get`, `pop`, `put` and `iter`, all with the same signatures in 0.18. lru
  0.18.5 was already in OPTN's lockfile through nostr-sdk, so this adds no
  crate.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

## Remove when

`mdk-memory-storage` on crates.io moves to `lru >= 0.18.2`, or optn-chat's tests
stop using it.
