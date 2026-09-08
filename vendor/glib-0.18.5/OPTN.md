# Vendored glib 0.18.5

Source: https://static.crates.io/crates/glib/glib-0.18.5.crate

Archive SHA-256:
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`

All 121 files from the published crate are retained, including `LICENSE`,
`COPYRIGHT`, `Cargo.toml.orig`, and `.cargo_vcs_info.json`. Package name, version,
features, and dependency requirements remain unchanged. This is a path patch,
not a Cargo source replacement or a republished crate.

## Local changes

- `src/variant_iter.rs`: backport the exact two-line production fix from
  [upstream commit b5a4071e439bef2b5eea76c3aa25e5ae84839e34](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34)
  ([PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)). The pointer variable
  becomes mutable and the variadic C output argument becomes `&mut p`.
  One unit test covers successful `next`, `nth`, `last`, `next_back`, and
  `nth_back`, mixed front/back traversal, empty strings, UTF-8, and exhaustion.
- `Cargo.toml`: an empty `[workspace]` table permits standalone upstream tests
  without changing OPTN's root workspace or adding glib to it.
- `OPTN.md`: this provenance and verification note.

The original `src/variant_iter.rs` SHA-256 is
`1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e`.
Compare each retained file against the authenticated archive; only the two
files above should differ, and this note is the only added file.

## Smallest optimized Linux regression

From the repository root, with an existing Linux Rust toolchain, linker,
pkg-config, GLib/GObject/GIO development libraries, and cached test dependencies:

```sh
cargo test --offline --manifest-path vendor/glib-0.18.5/Cargo.toml --release --lib variant_iter::tests::test_variant_str_iter_output_pointer -- --exact
```

This tests glib directly, without building Tauri, GTK, or the wallet. The
standalone test command creates its own Cargo.lock/build artifacts under this
vendor directory; they are not part of the imported upstream source. The
desktop dependency graph is instead governed by `src-tauri/Cargo.lock`.

For desktop resolution verification without fetching or changing its lock:

```sh
cargo metadata --offline --locked --manifest-path src-tauri/Cargo.toml --format-version 1
```

## Advisory review remains open

[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) still
lists 0.18.5 as affected. Its existing `deny.toml` exception is intentionally
unchanged pending parent review of source evidence and advisory visibility.
Cargo scanners can skip path dependencies; a disappearing warning is not
proof that this backport works or that future glib advisories remain covered.
Do not relabel the package or remove the exception solely because a scan passes.

The existing Rust nextest CI job runs the optimized regression on Linux. The
Rust dependency policy job also audits a temporary registry dependency pinned
to `glib = "=0.18.5"` with the repository's existing `deny.toml`. This preserves
registry advisory matching despite the desktop path patch; it adds no ignore.
Local source, lock resolution, YAML, and shell syntax checks pass. Optimized
Linux execution and the registry audit still require their CI results.
