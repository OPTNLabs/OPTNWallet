# `@optn/docker-dev` — production-grade contributor / lab image

**Honesty first:** this is **not** “OPTN Wallet for end users in Docker.”  
It **is** a **production-ready lab image** (hardened, release-tagged, multi-arch).

Read [PRODUCTION.md](./PRODUCTION.md) and [SCOPE.md](./SCOPE.md).  
**Release model:** [docs/docker-release-model.md](../../docs/docker-release-model.md)  
→ Docker **updates from our git tags**.

Contributor setup is documented in the repository-level
[CONTRIBUTING.md](../../CONTRIBUTING.md).

| Audience | Use? |
|----------|------|
| Contributors / auditors | **Yes** (`dev` service) |
| End users (mainnet keys) | **No** — installers only |
| VPS / always-on fusion lab | `--profile fusion-lab` — **Tor is mandatory** |

## Quick start (local build)

```bash
# repo root
docker compose -f packages/docker-dev/docker-compose.yml up -d --build
docker compose -f packages/docker-dev/docker-compose.yml exec --user 1000:1000 dev bash
# inside:
npm ci && npm run test:core
```

```bash
npm --prefix packages/docker-dev run up
npm --prefix packages/docker-dev run shell
npm --prefix packages/docker-dev run test:core
```

## After a release (pull published image)

```bash
export OPTN_DOCKER_TAG=v1.2.3   # required: the image publishes version tags only
# forks: export OPTN_DOCKER_IMAGE=ghcr.io/<you>/optn-docker-dev
npm --prefix packages/docker-dev run pull:release
npm --prefix packages/docker-dev run up:release
```

## Production-grade properties

| Property | How |
|----------|-----|
| Reproducible base | `node:22-bookworm-slim@sha256:d649c27…` |
| Non-root | official image user `node` uid/gid **1000** |
| Init | `tini` entrypoint |
| Multi-arch | `linux/amd64` + `linux/arm64` on tag push |
| Supply chain | SBOM + required provenance attestation on publish |
| CI | PR smoke (`node`/`npm` as 1000:1000) |
| Compose hardening | `no-new-privileges` |
| **CashFusion Tor** | **Mandatory** on `fusion-lab` (fail-closed; same as desktop P2P) |

## fusion-lab / VPS (Tor **mandatory**)

P2P CashFusion **must not** run clearnet (same as desktop fail-closed).

The `fusion-lab` profile always starts:

1. **`tor`** — SOCKS  
2. **`fusion-lab`** — supervisor that **exits if Tor is down**

```bash
npm --prefix packages/docker-dev run up:fusion-lab
# Tor: 127.0.0.1:9050 (host) / tor:9050 (compose)
# Default OPTN_NETWORK=chipnet
# Volume: optn-fusion-data → /optn-data
docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab logs -f fusion-lab
```

Full VPS notes: **[VPS.md](./VPS.md)**  

Plain `npm run up` is **dev/tests only** — no fusion, Tor not required.

## Layout

```
packages/docker-dev/
  Dockerfile                      # digest-pinned, non-root
  docker-compose.yml              # local build + fusion-lab profile
  docker-compose.release.yml      # GHCR image + fusion-lab profile
  scripts/fusion-lab-entrypoint.sh
  scripts/fusion-lab-supervisor.mjs
  VPS.md PRODUCTION.md SCOPE.md
  package.json README.md
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Permission denied on bind mount | Services run as uid 1000 (`exec --user 1000:1000`), and `dev` writes to the checkout. Checkout owned by root or another uid: `chown -R 1000:1000 <checkout>` (as CI does) or clone as uid 1000. Don't switch services to `user: "0:0"`: it drops the non-root boundary |
| Port 5173 busy | `OPTN_VITE_PORT=5174` |
| `curl 127.0.0.1:5173`: empty reply / connection reset | Expected: `dev` is an idle shell (`sleep infinity`), and nothing listens until you run `npm ci && npm run dev` inside it. The port binds to 127.0.0.1; `OPTN_VITE_BIND=0.0.0.0` exposes it. Fusion does not use it |
| fusion-lab `unhealthy`, log shows `EACCES` on `/optn-data` | The volume was created root-owned (by an older image, or while a service ran as root). After rebuilding: `docker compose -f packages/docker-dev/docker-compose.yml --profile fusion-lab run --rm --no-deps --user 0:0 --entrypoint chown fusion-lab -R 1000:1000 /optn-data` |
| fusion-lab `healthy` but nothing fuses | `healthy` only means Tor's SOCKS port answers. Without `OPTN_HEADLESS_CMD` no wallet is loaded and no round runs (see VPS.md) |
| GHCR pull denied | Package visibility / `docker login ghcr.io` |
| fusion-lab exits immediately | Tor not ready / SOCKS wrong — check `logs:tor` |
| Want consumer wallet | Use AppImage/DMG/MSI/APK — not this image |
| Want live Auto CoinJoin on VPS | Needs headless wallet binary via `OPTN_HEADLESS_CMD` (see VPS.md) |

## License

Same as monorepo root `LICENSE`.
