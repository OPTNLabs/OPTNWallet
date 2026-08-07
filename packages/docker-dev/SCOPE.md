# Docker package — full draft scope (PR #13)

This package is tracked as a **draft PR** until the checklist below is done.
End-user product shipping remains **native installers** (AppImage / DMG / MSI /
APK). Docker is **derived from us** (git tags / releases), not the reverse.

## Direction of truth (non-negotiable)

```text
git tag / GitHub Release  →  native installers (primary ship)
                         └→  optional: build + push container image(s)
```

| Model | Status |
|-------|--------|
| **Docker updates from our releases** | ✅ Target design |
| **Releases built only from Docker** | ❌ Not the product path |

See [docs/docker-release-model.md](../../docs/docker-release-model.md).

---

## Phases (check off in the PR)

### Phase A — Contributor lab (landed in first commit)

- [x] `packages/docker-dev/Dockerfile` (Node 22 Bookworm slim)
- [x] `docker-compose.yml` mount monorepo at `/optn`
- [x] `npm` scripts: `up` / `shell` / `test:core`
- [x] Package + root/docs README links
- [x] Explicit **not** production wallet / not mainnet appliance

### Phase B — CI build + release publish

- [ ] Workflow: build image on PRs that touch `packages/docker-dev/**` (smoke)
- [ ] Workflow: on tag `v*.*.*` (and/or `workflow_dispatch`), push to GHCR
- [ ] Tags: `ghcr.io/<org>/optn-docker-dev:<version>` and `:latest` (dev only)
- [ ] Document required `packages: write` / GHCR permissions
- [ ] Optional: pin `node:22-bookworm-slim` by digest in Dockerfile when publishing

### Phase C — Dev experience polish

- [ ] Document `user:` uid/gid for Linux file ownership
- [ ] Optional compose profile: `vite` defaults / healthcheck
- [ ] Optional: pre-warm layer that runs `npm ci` only when `package-lock.json` changes
- [ ] Contribute section in root README stays short; detail stays here

### Phase D — Fusion lab profile (optional, Chipnet only)

- [ ] Compose profile `fusion-lab` (stub or real): pinned Tor sidecar notes
- [ ] Docs: Chipnet only; no mainnet seeds in volumes
- [ ] Optional local fusion server sidecar (Electron Cash or internal) — **only if** maintainers want ops demo
- [ ] Explicit threat note: always-on = hot wallet ops, not default UX

### Phase E — Out of scope for this package (do not block draft)

- [ ] ~~Tauri desktop GUI in Docker as primary ship~~ — no
- [ ] ~~Hardware wallet USB as required path~~ — no
- [ ] ~~Replace AppImage/DMG/MSI~~ — no
- [ ] ~~Production mainnet “OPTN in Docker” consumer product~~ — separate decision

---

## Done criteria (mark PR ready for review)

1. Phase **A** + **B** complete and documented.
2. Smoke: `docker compose … build` and `test:core` path green in CI or maintainer machine.
3. Release model doc merged with the package.
4. PR description checklist matches this file; draft → ready.

Phase **C/D** may land in follow-ups without blocking “ready” if A+B are solid.
