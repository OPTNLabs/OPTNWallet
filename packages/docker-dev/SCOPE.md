# Docker package — scope (PR #13)

**Status:** Implementation complete for **production-grade lab image**.  
**Not in scope:** production consumer wallet in Docker (see [PRODUCTION.md](./PRODUCTION.md)).

## Direction of truth

```text
git tag / GitHub Release  →  native installers (primary ship)
                         └→  build + push optn-docker-dev (lab) to GHCR
```

## Phases

### A — Contributor lab ✅
### B — CI + GHCR publish ✅ (multi-arch on tags, smoke on PRs)
### C — Dev polish ✅
### D — fusion-lab (Tor **mandatory** for fusion) ✅
- Tor service always started with profile `fusion-lab`
- `OPTN_TOR_REQUIRED=1`, `OPTN_TOR_SOCKS=tor:9050`, chipnet default
- Data volume for ops state; headless entrypoint TBD
### E — Non-goals documented ✅
### F — Production-grade lab hardening ✅ (this session)
- [x] Pin Node base by digest  
- [x] Non-root user + tini  
- [x] Compose security_opt / release compose  
- [x] Multi-arch push + SBOM/provenance on tag  
- [x] PRODUCTION.md honesty doc  

## Ready for review when

1. [x] Code complete  
2. [ ] CI “Build docker-dev” green on latest push (verify after this commit)  
3. [ ] Optional: first GHCR push via tag or workflow_dispatch  

Mark PR **Ready for review** after (2).  
