# Docker contributor / lab image

**Package:** [`packages/docker-dev/`](../packages/docker-dev/)  
**Scope:** [`packages/docker-dev/SCOPE.md`](../packages/docker-dev/SCOPE.md)  
**What “production-ready” means:** [`packages/docker-dev/PRODUCTION.md`](../packages/docker-dev/PRODUCTION.md)  
**Release model:** [docker-release-model.md](./docker-release-model.md)  
  → **Docker updates from our tags/releases**, not the reverse.

Ship path for end users remains **native installers** (AppImage, DMG, MSI, APK).

This image is a **production-grade lab environment** (pinned base, non-root,
multi-arch GHCR on tags) for contributors — **not** a mainnet consumer wallet
in Docker.

## It covers both halves of the repository

Node **and** the pinned Rust toolchain (`1.98.1`, matching
[`rust-toolchain.toml`](../rust-toolchain.toml) and CI), with
`wasm32-unknown-unknown` and `wasm-bindgen-cli 0.2.127` — the versions
`.github/workflows/rust-connect.yml` installs.

That is deliberate. An image with only the Node half lets a contributor watch
a green `npx vitest` while the crates, the CLI and the committed WASM go
unchecked, and the two sides drift apart with nothing reporting it. It is not
a hypothetical failure: commits on this branch shipped stale generated WASM
precisely because the gate that catches it needs `cargo`, and the container
had none.

So the image pins the binding generator's version as well as the toolchain's.
A different `wasm-bindgen-cli` regenerates bindings that differ from CI's, and
the freshness gate then fails for a reason that has nothing to do with the
change under test.

Neither half is complete on its own:

```sh
# TypeScript
npm ci && npx vitest run

# Rust — `--workspace` reaches 9 of the crates; the rest carry their own
# lock files and must be run where they live (see docs/open-items.md).
cargo test --workspace
for d in crates/optn-core crates/optn-cli crates/optn-ui-egui crates/optn-ui-dioxus src-tauri; do
  (cd "$d" && cargo test) || echo "FAILED: $d"
done
cargo check -p optn-ui --target wasm32-unknown-unknown
cargo run -p xtask -- architecture

# The gate that the missing toolchain used to hide
npx --no-install tsx scripts/build-optn-core-wasm.mts --check
```

The desktop shell itself is still out of scope: a Tauri GUI needs a windowing
stack and a display, which this image deliberately does not carry. What it
covers is every crate the GUI is built out of.

→ **[packages/docker-dev/README.md](../packages/docker-dev/README.md)**

Workflows:

- PR validation: [`.github/workflows/docker-dev-pr.yml`](../.github/workflows/docker-dev-pr.yml)
- Trusted publish: [`.github/workflows/docker-dev.yml`](../.github/workflows/docker-dev.yml)

PR validation is read-only, builds a local `linux/amd64` image, runs non-root
smoke checks, and runs `npm ci && npm run test:core` inside that image. GHCR
publishing and provenance attestation are restricted to trusted tag or manual
publish runs.

For the fastest contributor setup, use a published version explicitly:

```bash
export OPTN_DOCKER_TAG=sha-abcdef1  # or a release tag such as v1.7.0
npm --prefix packages/docker-dev run pull:release
npm --prefix packages/docker-dev run up:release
```

`OPTN_DOCKER_TAG` is required. The image publishes version tags only, so
compose fails with an explanatory error rather than resolving to a mutable
tag whose contents change underneath you.

```bash
# Local build (dev shell — no fusion)
docker compose -f packages/docker-dev/docker-compose.yml up -d --build

# VPS / fusion-lab — Tor mandatory
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab up -d --build

# After a release tag is published to GHCR
export OPTN_DOCKER_TAG=v1.2.3
docker compose -f packages/docker-dev/docker-compose.release.yml pull
docker compose -f packages/docker-dev/docker-compose.release.yml up -d
```

VPS fusion lab details: [`packages/docker-dev/VPS.md`](../packages/docker-dev/VPS.md)
