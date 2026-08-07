# `@optn/docker-dev` — production-grade contributor / lab image

**Honesty first:** this is **not** “OPTN Wallet for end users in Docker.”  
It **is** a **production-ready lab image** (hardened, release-tagged, multi-arch).

Read [PRODUCTION.md](./PRODUCTION.md) and [SCOPE.md](./SCOPE.md).  
**Release model:** [docs/docker-release-model.md](../../docs/docker-release-model.md)  
→ Docker **updates from our git tags**.

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
export OPTN_DOCKER_TAG=v1.2.3   # or latest
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
| Supply chain | SBOM + provenance on push; optional attestation |
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
  Dockerfile                 # digest-pinned, non-root
  docker-compose.yml         # local build + optional Tor
  docker-compose.release.yml # pull GHCR image
  PRODUCTION.md
  SCOPE.md
  package.json
  README.md
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Permission denied on bind mount | `exec --user 1000:1000` or match host uid |
| Port 5173 busy | `OPTN_VITE_PORT=5174` |
| GHCR pull denied | Package visibility / `docker login ghcr.io` |
| Want consumer wallet | Use AppImage/DMG/MSI/APK — not this image |

## License

Same as monorepo root `LICENSE`.
