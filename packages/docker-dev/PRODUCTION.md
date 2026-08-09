# Is this “production-ready Docker”?

## Clear answer

| Product | Production-ready? |
|---------|-------------------|
| **Lab/contributor image** (`optn-docker-dev`) | **Yes** — for its purpose: reproducible tests/tooling, release-tagged GHCR publish |
| **Consumer wallet (mainnet GUI, keys, HW wallets)** | **No** — not this package; use AppImage / DMG / MSI / APK |

This package is **production-grade packaging of a developer/lab environment**,
not “OPTN Wallet as a Docker product for end users.”

## What “production-ready” means here

- [x] Base image **pinned by digest**
- [x] Non-root default user (`optn` / uid 1000)
- [x] `tini` as init, `no-new-privileges` in compose
- [x] CI smoke on every PR that touches this package
- [x] Multi-arch (**amd64 + arm64**) on tag push to GHCR
- [x] Provenance/SBOM flags and required attestation on publish
- [x] Documented release model: **Docker updates from our tags**
- [x] `docker-compose.release.yml` to pull the published image
- [x] Explicit non-goals (no GUI ship, no mainnet wallet in Docker)

## CashFusion + Tor (non-negotiable)

Desktop P2P fusion is **Tor fail-closed**. Any Docker/VPS fusion path must match:

| Rule | Meaning |
|------|---------|
| Tor **mandatory** for fusion | No clearnet Nostr fusion |
| `fusion-lab` profile | Always brings up `tor` + lab with `OPTN_TOR_SOCKS=tor:9050` |
| Default network | **chipnet**; mainnet only if operator sets `OPTN_NETWORK=mainnet` |
| Secrets | Volume `optn-fusion-data` only — never bake keys into the image |

**Supervisor** (`scripts/fusion-lab-supervisor.mjs`) enforces Tor fail-closed,
validates `OPTN_FUSION_MODE` / `OPTN_NETWORK`, writes a health file, and optionally
execs `OPTN_HEADLESS_CMD`. **Auto fusion rounds** (wallet unlock +
`FusionRunnerService` + Tauri Tor WebSocket) are a **separate product milestone**,
not part of this lab image — see [VPS.md](./VPS.md).

## What we will not claim

- Safe storage of mainnet seeds inside a container by default  
- Hardware wallet USB as supported in Docker  
- Replacing native release artifacts  
- Formal third-party security audit of the image  
- “Production VPS fusion node” until headless runner ships (infra is ready)

## Operator checklist (after first GHCR publish)

1. Tag a release `vX.Y.Z` (or `workflow_dispatch` with push=true).  
2. Confirm package: `ghcr.io/<owner>/optn-docker-dev:vX.Y.Z`.  
3. Set package visibility (public/internal) in GitHub → Packages if needed.  
4. Contributors: `OPTN_DOCKER_TAG=vX.Y.Z docker compose -f packages/docker-dev/docker-compose.release.yml pull`

## Related

- [SCOPE.md](./SCOPE.md)  
- [docs/docker-release-model.md](../../docs/docker-release-model.md)  
