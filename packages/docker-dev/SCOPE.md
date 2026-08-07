# Docker package — full scope (PR #13)

End-user product shipping remains **native installers** (AppImage / DMG / MSI /
APK). Docker is **derived from us** (git tags / releases), not the reverse.

## Direction of truth (non-negotiable)

```text
git tag / GitHub Release  →  native installers (primary ship)
                         └→  optional: build + push container image(s)
```

| Model | Status |
|-------|--------|
| **Docker updates from our releases** | ✅ Design + workflow |
| **Releases built only from Docker** | ❌ Not the product path |

See [docs/docker-release-model.md](../../docs/docker-release-model.md).

---

## Phases

### Phase A — Contributor lab

- [x] `packages/docker-dev/Dockerfile` (Node 22 Bookworm slim)
- [x] `docker-compose.yml` mount monorepo at `/optn`
- [x] `npm` scripts: `up` / `shell` / `test:core`
- [x] Package + root/docs README links
- [x] Explicit **not** production wallet / not mainnet appliance

### Phase B — CI build + release publish

- [x] Workflow smoke-build on PRs touching `packages/docker-dev/**`
- [x] Workflow push to GHCR on tag `v*.*.*` (+ `workflow_dispatch` push=true)
- [x] Tags: `ghcr.io/<org>/optn-docker-dev:<version>` and `:latest` on tag
- [x] Document `packages: write` / GHCR in docs
- [x] Smoke step: `node -v` / `npm -v` inside image (non-push builds)
- [x] Dockerfile notes for pinning base image by digest when publishing

**Verify on first merge:** open Actions → “Docker dev image” on this PR path.

### Phase C — Dev experience polish

- [x] `OPTN_DOCKER_UID` / `OPTN_DOCKER_GID` for Linux bind-mount ownership
- [x] Configurable Vite host port `OPTN_VITE_PORT`
- [x] Scripts: `up:fusion-lab`, `logs:tor`, `test:core` with `--no-deps`
- [x] README troubleshooting for uid/port

### Phase D — Fusion lab profile (Chipnet / ops only)

- [x] Compose profile `fusion-lab` with Tor SOCKS sidecar (`dperson/torproxy`)
- [x] Host bind `127.0.0.1:9050` by default; `OPTN_TOR_SOCKS=tor:9050` for dev
- [x] Docs: Chipnet only; no mainnet seeds in volumes
- [x] Threat note: always-on hot wallet is advanced ops, not default UX

### Phase E — Explicit non-goals (documented)

- [x] No Tauri desktop GUI as primary Docker ship
- [x] No hardware-wallet USB as required path
- [x] No replacing AppImage/DMG/MSI
- [x] No production mainnet “OPTN in Docker” consumer product in this package

---

## Done criteria (mark PR ready for review)

1. [x] Phases A–E implemented in tree (this session)
2. [ ] CI smoke green on PR #13 (Actions “Docker dev image”)
3. [ ] Maintainer confirms GHCR push on a test tag or workflow_dispatch (optional before ready)
4. [ ] Draft → **Ready for review** when (2) is green

Phase D Tor image uses a public tag (`dperson/torproxy:latest`); forks may pin
by digest for stricter supply-chain control.
