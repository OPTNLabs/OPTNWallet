# Vendored openmls_rust_crypto 0.5.1

Source: https://static.crates.io/crates/openmls_rust_crypto/openmls_rust_crypto-0.5.1.crate

Archive SHA-256:
`fafcc8a3552b10fbb3ab757cccaf1a34081e826ca819f49aa7e6645b1d95c00f`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept, with name and version unchanged,
except its `Cargo.lock`: upstream's own development lockfile, which OPTN's
builds never read and which still names the vulnerable crates this patch
removes. This is a path patch from `[patch.crates-io]` in the root and
`src-tauri` manifests, so `mdk-core 0.8.0` (optn-chat's MLS) resolves it as
before. The import commit adds the published files unchanged; the commit
after it holds every change below.

## Why

It requires `p256 0.13`, whose `elliptic-curve 0.13` brings `crypto-bigint
0.5.5`: RUSTSEC-2026-0387, timing variability in operations meant to be
constant-time, fixed only in `crypto-bigint >= 0.7.6`, which needs
`elliptic-curve 0.14`. Through `hpke-rs 0.6` it also brings `p256`, `p384` and
`k256` 0.13 again (in `hpke-rs-rust-crypto 0.6.1`), `libcrux-sha3 0.0.8`
(RUSTSEC-2026-0207, -0208) and `libcrux-secrets 0.0.5` (RUSTSEC-2026-0212).

No release fixes it. `openmls_rust_crypto 0.6.0`, the latest on crates.io,
still requires `p256 0.13`, and `mdk-core 0.8.0`, the latest MDK there,
accepts only 0.5. Upstream fixed it on GitHub: openmls/openmls#2249 and #2261
move the provider to RustCrypto 0.14 and hpke-rs 0.8, and MDK's `main` pins a
backport of both onto its OpenMLS 0.8 line (marmot-protocol/mdk#2597, fork
commit erskingardner/openmls@94f57b829 on branch `mdk/rustcrypto-0.14`). This
copy applies those changes to the published 0.5.1.

It replaces `vendor/hpke-rs-0.6.1`, which existed only because this crate
needed hpke-rs 0.6; hpke-rs 0.8 already carries the libcrux fixes that copy
backported.

## Local changes

Each follows erskingardner/openmls@94f57b829, adapted to 0.5.1, which has no
P-384 signing and keeps `aes-gcm` and `chacha20poly1305` 0.10:

- `Cargo.toml`: `p256` 0.13 -> 0.14; `hpke-rs`, `hpke-rs-crypto` and
  `hpke-rs-rust-crypto` 0.6 -> 0.8, with the same features; `ed25519-dalek`
  2 -> 3; `rand` 0.8 and `rand_chacha` 0.3 -> `rand_core` 0.10, `rand_chacha`
  0.10 and `getrandom` 0.4 (`sys_rng`). The generators move together because
  `p256` 0.14 and `ed25519-dalek` 3 take `rand_core` 0.10 ones. The hpke-rs
  calls this crate makes (`Hpke::new`, `seal`, `open`, `setup_sender`,
  `setup_receiver`, `export`, `derive_key_pair`) have the same signatures in
  0.6 and 0.8.
- `src/provider.rs`:
  - the provider's ChaCha20 generator is seeded from getrandom's `SysRng`
    instead of rand 0.8's `from_entropy`; both read the OS generator and panic
    if it fails, since `Default` cannot return an error;
  - P-256 key generation calls `generate_from_rng` and `to_sec1_point`, p256
    0.14's names for `random` and `to_encoded_point`; the stored formats are
    unchanged, a 32-byte scalar and a 65-byte uncompressed SEC1 point;
  - P-256 verification parses the key with `VerifyingKey::from_sec1_bytes`,
    which accepts the same SEC1 encodings as `EncodedPoint::from_bytes`
    followed by `from_encoded_point`;
  - P-256 signing converts the key with `try_into` and returns
    `CryptoError::InvalidLength` for a key that is not 32 bytes, where 0.13's
    slice-to-array `into()` panicked.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

hpke-rs 0.8 declares an optional libcrux backend that Cargo.lock lists;
nothing in OPTN enables it, so it is never built, and the releases it names
are the fixed ones.

`crates/optn-chat/tests/openmls_crypto_provider.rs` checks this copy against
published answers: RFC 6979 A.2.5's exact P-256 signature, RFC 8032 test 1's
Ed25519 signature, the generated key formats, and HPKE over P-256 and X25519.
`tests/hpke_rfc9180.rs` reproduces RFC 9180 A.1.1 and A.1.2 on hpke-rs 0.8, and
the group chat and ts-mls key package tests run MLS through this provider.

## Advisory coverage

Scanners skip a path package, so CI's Rust dependency policy job audits the
registry crate this replaces, with the repository's `deny.toml`, which ignores
nothing. `scripts/check-vendored-advisories.py` passes it only if every
advisory found is in that step's `REPAIRED_IN_VENDOR` list (RUSTSEC-2026-0207,
-0208, -0212 and -0387), the ones this copy repairs; a new advisory against
the crate fails the job.

## Remove when

`mdk-core` on crates.io accepts an `openmls_rust_crypto` release on p256 0.14
(openmls's next release carries #2249), or optn-chat leaves MDK 0.8. Then drop
both `[patch.crates-io]` entries, this directory and
`vendor/openmls_basic_credential-0.5.0` together.
