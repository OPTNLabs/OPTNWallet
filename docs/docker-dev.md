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

→ **[packages/docker-dev/README.md](../packages/docker-dev/README.md)**

Workflows:

- PR validation: [`.github/workflows/docker-dev-pr.yml`](../.github/workflows/docker-dev-pr.yml)
- Trusted publish: [`.github/workflows/docker-dev.yml`](../.github/workflows/docker-dev.yml)

PR validation is read-only and builds a local `linux/amd64` image. GHCR
publishing and provenance attestation are restricted to trusted tag or manual
publish runs.

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
