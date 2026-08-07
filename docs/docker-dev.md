# Docker contributor lab

**Package:** [`packages/docker-dev/`](../packages/docker-dev/)  
**Draft full scope:** [`packages/docker-dev/SCOPE.md`](../packages/docker-dev/SCOPE.md)  
**Release model:** [docker-release-model.md](./docker-release-model.md)  
  → **Docker updates from our tags/releases**, not the reverse.

Ship path for end users remains **native installers** (AppImage, DMG, MSI, APK).
This Docker setup is a **developer onboarding** aid: one Linux environment to
run `npm ci` and core tests without fighting local toolchains. CI can rebuild
and push the lab image when we cut a release tag.

See the package README for commands, ports, and safety rules:

→ **[packages/docker-dev/README.md](../packages/docker-dev/README.md)**

Workflow: [`.github/workflows/docker-dev.yml`](../.github/workflows/docker-dev.yml)

CashFusion product status (P2P + server) is documented separately (on ship
branches / main docs):

→ [cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md)  
→ [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md)
