# `@optn/docker-dev` — contributor Docker lab

**PR status:** full scope checklist in [SCOPE.md](./SCOPE.md) (phases A–E).  
**Release model:** Docker **updates from our git tags** — see
[docs/docker-release-model.md](../../docs/docker-release-model.md).

**Purpose:** lower the barrier for **developers and auditors** who want a
repeatable Linux environment for OPTN Wallet work (install deps, run core
tests, optional web/vite). On each **release tag**, CI pushes this image to
GHCR so devs can pull an env that matches that version.

**Not for:** production mainnet wallets, hardware USB passthrough as a first
class product, or replacing AppImage / DMG / MSI / APK downloads.

| Audience | Use this? |
|----------|-----------|
| New contributors | **Yes** |
| Code reviewers / auditors | **Yes** (reproducible shell) |
| End users | **No** — use release installers |
| Always-on fusion ops | **Phase D only**, Chipnet / advanced — not default UX |

## Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) + Compose v2
- Repo checked out (this package lives under `packages/docker-dev/`)

## Quick start

From the **repository root**:

```bash
docker compose -f packages/docker-dev/docker-compose.yml up -d --build
docker compose -f packages/docker-dev/docker-compose.yml exec dev bash

# Inside the container (first time):
npm ci
npm run test:core          # unit tests (no mainnet)
# npm run dev              # Vite — host port 5173 (or OPTN_VITE_PORT)
```

Package scripts (from repo root):

```bash
npm --prefix packages/docker-dev run up
npm --prefix packages/docker-dev run shell
npm --prefix packages/docker-dev run test:core
```

### Linux file ownership

Bind mounts write as root inside the container by default. Prefer:

```bash
docker compose -f packages/docker-dev/docker-compose.yml exec \
  --user "$(id -u):$(id -g)" dev bash
```

Or run one-off:

```bash
docker compose -f packages/docker-dev/docker-compose.yml run --rm \
  --user "$(id -u):$(id -g)" --workdir /optn dev bash -lc "npm ci"
```

### Optional: fusion-lab (Tor SOCKS, Chipnet only)

```bash
npm --prefix packages/docker-dev run up:fusion-lab
# Tor SOCKS on host: 127.0.0.1:9050 (override with OPTN_TOR_HOST_PORT)
# Inside compose network: tor:9050 (env OPTN_TOR_SOCKS)
```

**Threat note:** always-on Tor + a hot wallet is **ops**, not the normal
install path. No mainnet seeds in volumes. Chipnet for experiments.

## What is in the image

| Piece | Notes |
|-------|--------|
| Node.js **22** (Bookworm) | Frontend / vitest tooling |
| `git`, `python3`, `make`, `g++` | `npm ci` native modules |
| `ca-certificates` | HTTPS for npm |
| Working dir `/optn` | Compose bind-mounts the monorepo |

**Not** in the image (by design): Tauri/WebKit GUI, Android SDK, USB HW.
Tor is a **compose profile** sidecar, not baked into the Node image.

## Ports

| Host | Container | Use |
|------|-----------|-----|
| `5173` (or `OPTN_VITE_PORT`) | `5173` | Vite dev |
| `127.0.0.1:9050` (fusion-lab) | `9050` | Tor SOCKS |

## Safety rules

1. **Chipnet / mocks only** for fusion and wallet tests inside the lab.
2. Do **not** put mainnet seeds or production keystores in the volume.
3. Pin base image digests when publishing long-lived GHCR tags (`Dockerfile`).
4. Shipping installers remain the **user** path; this package is additive.

## Pull a released lab image (after GHCR publish)

```bash
docker pull ghcr.io/optnlabs/optn-docker-dev:latest
docker run --rm -it -v "$PWD":/optn -w /optn ghcr.io/optnlabs/optn-docker-dev:latest bash
```

Until the first tag push, use **local compose build**.

## CI

Workflow: `.github/workflows/docker-dev.yml`

| Event | Action |
|-------|--------|
| PR / push touching this package | Build image + smoke `node -v` |
| Tag `v*.*.*` | Build + **push** to GHCR |
| `workflow_dispatch` with push=true | Manual GHCR push |

## Layout

```
packages/docker-dev/
  Dockerfile
  docker-compose.yml    # dev + optional fusion-lab Tor
  package.json
  SCOPE.md
  README.md
  .dockerignore
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `npm ci` native build fails | Image already has `g++`/`python3`; retry with clean `node_modules` |
| Port 5173 in use | `OPTN_VITE_PORT=5174 docker compose ... up` |
| Root-owned files on Linux host | `exec --user "$(id -u):$(id -g)"` |
| Tor not starting | Ensure profile: `--profile fusion-lab` or `npm run up:fusion-lab` |

## License

Same as the monorepo (see root `LICENSE`).
