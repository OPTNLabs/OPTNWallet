# Vendored hpke-rs 0.6.1

Source: https://static.crates.io/crates/hpke-rs/hpke-rs-0.6.1.crate

Archive SHA-256:
`b6ad6a58eb3e0ee30be8bfc7a9770ae98adcfa1d9bc820a5847732ce84f70837`
(the checksum OPTN's Cargo.lock already recorded for the registry crate).

All files from the published crate are kept except its `Cargo.lock`: upstream's
own development lockfile, which OPTN's builds never read and which would show
GitHub's dependency scanning the vulnerable libcrux versions this patch removes
(the crate's bundled `.gitignore` excludes it too). Package name and version are
unchanged, so `openmls_rust_crypto 0.5.1` (under `mdk-core 0.8.0`, optn-chat's
MLS) still resolves it. This is a path patch from `[patch.crates-io]` in the
root and `src-tauri` manifests, not a source replacement or a republished crate.

## Why

hpke-rs 0.6.1 requires `libcrux-sha3 0.0.8`, which has RUSTSEC-2026-0207 and
RUSTSEC-2026-0208, and brings `libcrux-secrets 0.0.5` (RUSTSEC-2026-0212). Its
optional libcrux backend, `hpke-rs-libcrux 0.6.1`, sits in Cargo.lock with
`libcrux-kem 0.0.7` (RUSTSEC-2026-0330, -0331), `libcrux-chacha20poly1305
0.0.7` (RUSTSEC-2026-0124) and `libcrux-aesgcm 0.0.7` (RUSTSEC-2026-0209,
-0211, which libcrux will not patch: it replaced the crate with `libcrux-aes`).

The fixed hpke-rs releases (0.7, 0.8) need `openmls_rust_crypto 0.6`, which
`mdk-core 0.8.0`, the latest MDK on crates.io, does not accept. MDK itself
moved on only on GitHub (v0.13, a different crate layout on git
dependencies), and fixed the same advisories there the same way: by vendoring
its HPKE provider with the fixed libcrux (`vendor/hpke-rs-libcrux/BACKPORT.md`
in marmot-protocol/mdk).

## Local changes

- `Cargo.toml`: `libcrux-sha3` 0.0.8 -> 0.0.11, the release hpke-rs 0.8.0
  itself uses (fixed: >= 0.0.10). hpke-rs calls only
  `libcrux_sha3::shake256::<N>(&[u8]) -> [u8; N]`, whose signature is identical
  in 0.0.8, 0.0.10 and 0.0.11; no source change was needed for it.
- `Cargo.toml`: the optional `hpke-rs-libcrux` dependency, its `libcrux`
  feature, and its `?/std` and `?/deterministic-prng` forwards are removed,
  with the dev-dependency on it. Nothing in OPTN enables that backend
  (`openmls_rust_crypto` uses the RustCrypto one), and without the optional
  dependency it no longer reaches Cargo.lock.
- `src/lib.rs`: the three-line `#[cfg(feature = "libcrux")]` re-export of that
  backend is removed with the feature. The crate's doc examples and its own
  `cfg(test)` modules still name `hpke_rs_libcrux`; they build only when this
  crate is tested on its own against upstream, never in OPTN.
- `Cargo.toml`: an empty `[workspace]` table keeps the crate out of OPTN's
  root workspace, as `vendor/glib-0.18.5` does.

## Remove when

`mdk-core` on crates.io accepts an `openmls_rust_crypto` on hpke-rs >= 0.8, or
optn-chat leaves MDK 0.8. Then drop the `[patch.crates-io]` entries and this
directory together.
