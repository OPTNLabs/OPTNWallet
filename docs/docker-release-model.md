# Docker vs releases — direction of truth

## One rule

**Docker images update from our releases (and git). Releases do not come from Docker.**

```text
                    ┌─────────────────────┐
                    │  git commit + tag   │
                    │  (source of truth)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
   ┌─────────────────────┐           ┌─────────────────────┐
   │  Publish Release    │           │  Docker image job   │
   │  AppImage DMG MSI   │           │  (optional artifact)│
   │  APK / extensions   │           │  optn-docker-dev    │
   └─────────────────────┘           └─────────────────────┘
         Users install                    Devs / labs pull
```

| Question | Answer |
|----------|--------|
| Do we update Docker from releases? | **Yes** — same tag/commit builds the image |
| Do we ship the wallet only as Docker? | **No** |
| Does Docker speed multi-arch installers? | **No** — native runners still own those |
| Does Docker speed contributor setup? | **Yes** |

## What gets published (target)

| Image | Audience | When |
|-------|----------|------|
| `optn-docker-dev` | Contributors, auditors | Tag `v*.*.*` + manual dispatch; optional PR smoke build |

Suggested registry: **GHCR** (`ghcr.io/<owner>/optn-docker-dev`).

Suggested tags:

- `v1.7.0` / `1.7.0` — matches release
- `latest` — latest **released** dev image (not every commit on `dev` unless we choose nightlies later)

## Workflow split

| Workflow | Role |
|----------|------|
| `Publish Release` (existing) | Native / store artifacts — **primary ship** |
| `Docker dev image` (this package) | Build/push **lab** image from same tag |

They may share a tag trigger. They must not block each other forever: a Docker
registry blip should not fail shipping installers (and vice versa, ideally).

## Security notes

1. Dev image is for **tests and tooling**, not “put your life savings seed here.”
2. Pin base image digests when publishing long-lived tags.
3. Chipnet / mocks for fusion experiments; document any always-on profile as
   advanced ops.

## Related

- Package: [packages/docker-dev/](../packages/docker-dev/)
- Scope checklist: [packages/docker-dev/SCOPE.md](../packages/docker-dev/SCOPE.md)
- Contributor how-to: [docker-dev.md](./docker-dev.md)
