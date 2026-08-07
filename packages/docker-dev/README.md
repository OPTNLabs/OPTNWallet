# `@optn/docker-dev` — contributor Docker lab

**Purpose:** lower the barrier for **developers and auditors** who want a
repeatable Linux environment for OPTN Wallet work (install deps, run core
tests, optional web/vite). Aimed at onboarding — same spirit as architecture
docs and green CI.

**Not for:** production mainnet wallets, hardware USB passthrough as a first
class product, or replacing AppImage / DMG / MSI / APK downloads.

| Audience | Use this? |
|----------|-----------|
| New contributors | **Yes** |
| Code reviewers / auditors | **Yes** (reproducible shell) |
| End users | **No** — use release installers |
| Always-on mainnet fusion appliance | **No** (out of scope for v1) |

## Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) + Compose v2
- Repo checked out (this package lives under `packages/docker-dev/`)

## Quick start

From the **repository root**:

```bash
# Build image + start a long-lived dev container (repo mounted at /optn)
docker compose -f packages/docker-dev/docker-compose.yml up -d --build

# Shell into the lab
docker compose -f packages/docker-dev/docker-compose.yml exec dev bash

# Inside the container (first time):
npm ci
npm run test:core          # unit tests (no mainnet)
# optional:
# npm run build:web
# npm run dev              # Vite on 0.0.0.0:5173 — map port below
```

Or use the package scripts (from repo root):

```bash
npm --prefix packages/docker-dev run up
npm --prefix packages/docker-dev run shell
npm --prefix packages/docker-dev run test:core
```

## What is in the image

| Piece | Notes |
|-------|--------|
| Node.js **22** (Bookworm) | Matches modern CI Node for frontend tests |
| `git`, `python3`, `make`, `g++` | `npm ci` native modules / tooling |
| `ca-certificates` | HTTPS for npm |
| Working dir `/optn` | Compose bind-mounts the monorepo here |

**Not** included in v1 (deliberately): full Tauri/WebKit GUI, Android SDK,
hardware-wallet USB, production Tor sidecar. Those stay on host or later
compose profiles.

## Ports

| Host | Container | Use |
|------|-----------|-----|
| `5173` | `5173` | Vite dev server if you run `npm run dev` |

## Safety rules

1. **Chipnet / mocks only** for fusion and wallet tests inside the lab.
2. Do **not** put mainnet seeds or production keystores in the container volume.
3. Image tags and base digests should stay **pinned** when we publish to a
   registry (see `Dockerfile` comments).
4. This package is **additive** — shipping installers remain the user path.

## Layout

```
packages/docker-dev/
  Dockerfile           # pinned base image
  docker-compose.yml   # dev service + volume mount
  .dockerignore        # keep build context small when used
  package.json         # npm run up / shell / test:core
  README.md            # this file
```

## Relation to CashFusion

P2P and server fusion are **implemented in the app** (see
`docs/cashfusion-implementation-scope.md` on the fusion ship branch). This
Docker package does **not** replace that; it only makes it easier for
contributors to run **tests and tooling** in a clean Linux environment.

Optional later profiles (not in v1): local Electron Cash fusion server,
pinned Tor sidecar for headless experiments — only if maintainers want them.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `npm ci` fails on optional native deps | Ensure container has `g++`/`python3` (already in image); retry |
| Port 5173 in use | Change host mapping in `docker-compose.yml` |
| File permission oddities on Linux | Run as your uid: `user: "${UID}:${GID}"` (add if needed) |

## License

Same as the monorepo (see root `LICENSE`).
