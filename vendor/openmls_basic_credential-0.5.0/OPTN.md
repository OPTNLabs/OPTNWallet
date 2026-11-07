# Vendored openmls_basic_credential 0.5.0

Source: https://static.crates.io/crates/openmls_basic_credential/openmls_basic_credential-0.5.0.crate

Archive SHA-256:
`983e8be1457dd6f316f409292cec334af3b57b49a19deadc925c83c3c35e15b6`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept, with name and version unchanged,
except its `Cargo.lock`: upstream's own development lockfile, which OPTN's
builds never read and which still names the vulnerable crate this patch
removes. This is a path patch from `[patch.crates-io]` in the root and
`src-tauri` manifests, so `mdk-core 0.8.0` (optn-chat's MLS credentials)
resolves it as before. The import commit adds the published files unchanged;
the commit after it holds every change below.

## Why

It requires `p256 0.13`, whose `elliptic-curve 0.13` brings `crypto-bigint
0.5.5` (RUSTSEC-2026-0387, fixed only in `crypto-bigint >= 0.7.6`, which needs
`elliptic-curve 0.14`). `openmls_basic_credential 0.6.0`, the latest on
crates.io, still requires `p256 0.13`; `mdk-core 0.8.0` accepts only 0.5.
Upstream moved it to p256 0.14 on GitHub (openmls/openmls#2249), and MDK pins a
backport onto its OpenMLS 0.8 line (marmot-protocol/mdk#2597,
erskingardner/openmls@94f57b829). See `vendor/openmls_rust_crypto-0.5.1/OPTN.md`,
which this copy moves with.

## Local changes

Each follows erskingardner/openmls@94f57b829, adapted to 0.5.0, which has no
P-384 or zeroizing code:

- `Cargo.toml`: `p256` 0.13 -> 0.14, `ed25519-dalek` 2 -> 3, and `rand` 0.8 ->
  `rand_core` 0.10 with `getrandom` 0.4 (`sys_rng`), since both curve crates
  now take `rand_core` 0.10 generators.
- `src/lib.rs`:
  - new key pairs draw from getrandom's `SysRng` (through `rand_core`'s
    `UnwrapErr`) instead of rand 0.8's `OsRng`; both read the OS generator and
    panic if it fails;
  - P-256 key generation calls `generate_from_rng` and `to_sec1_point`, p256
    0.14's names for `random` and `to_encoded_point`; the stored formats are
    unchanged;
  - P-256 signing converts the private key with `try_into` and returns
    `SignerError::SigningError` for one that is not 32 bytes, where 0.13's
    slice-to-array `into()` panicked.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

`crates/optn-chat/tests/openmls_crypto_provider.rs` signs RFC 6979 A.2.5's
message with this crate's `SignatureKeyPair` and checks the exact signature,
and checks new P-256 and Ed25519 credentials sign verifiably.

## Advisory coverage

CI's Rust dependency policy job audits the registry crate this replaces, as
for `vendor/openmls_rust_crypto-0.5.1`, and passes only if every advisory
found is RUSTSEC-2026-0387, the one this copy repairs.

## Remove when

With `vendor/openmls_rust_crypto-0.5.1`: when `mdk-core` on crates.io accepts
an OpenMLS release on p256 0.14, or optn-chat leaves MDK 0.8.
