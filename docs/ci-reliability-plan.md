# CI reliability plan (PR #12 / desktop ship)

## Diagnosis (evidence)

### Class A — GitHub Actions infrastructure (most recent reds)

**Symptom (job log, before checkout):**

```text
Prepare all required actions
Getting action download info
Failed to resolve action download info. Error: Service Unavailable
##[error]Failed to resolve action download info.
```

**Not caused by our code.** Jobs die while resolving marketplace/API download info for `uses:` actions.

**Official status (2026-08-06):** [githubstatus.com](https://www.githubstatus.com) — **Actions = major_outage**, Pages = major_outage. Incident: “Workflow runs are still failing or delayed… some queued jobs may time out… Actions API returning errors.”

Same failure mode is widely reported (e.g. community discussion on unhelpful error text; other projects logging the same “Service Unavailable when resolving action download info”).

**What empty commits / re-runs do:** only wait for GitHub to recover; they do not fix app bugs.

### Class B — Real build defects (must stay fixed)

| Failure | Root cause | Fix status |
|---------|------------|------------|
| `Preview (ubuntu-24.04-arm)` `hidapi` | Missing `libudev` / pkg-config on ARM Linux | **Fixed** in `desktop-preview.yml` + `release.yml` (`libudev-dev`, `libusb-1.0-0-dev`, `pkg-config`) |
| CodeRabbit >300 files | Pro+ hard cap after path filters | **Fixed** `.coderabbit.yaml` whitelist (~250 ship-critical files) |
| Auto-review skipped on `dev` | CodeRabbit only auto-reviews default branch | **Fixed** `base_branches: [dev, …]` |

### Class C — Product CI matrix (ship requirements)

Must stay green once Actions is healthy:

- **CI:** secrets-scan, dependency-audit, web-ci (lint/typecheck/test)
- **Desktop Preview:** Windows x64, macOS arm + Intel, Linux x64, Linux ARM64 AppImage path
- **Android Preview:** debug APK
- **Extension Preview:** Chrome/Firefox bundles
- **Release (tag):** multi-arch installers + APK/AAB when secrets exist; AppImage = portable Linux for all distros

---

## Plan — make it work properly

### Phase 0 — Wait for GitHub Actions (now)

1. Watch [GitHub Status — Actions](https://www.githubstatus.com) until **Actions is operational** (not major/partial outage).
2. Do **not** thrash with more empty commits while status is red (wastes queue, confuses checks).
3. When operational: `gh run rerun <id> --failed` for the latest head, or one clean re-trigger if checks are stuck.

### Phase 1 — Auto-retry failed jobs (workflow-level)

GitHub has **no built-in** “retry job N times on failure.” Community pattern: a `workflow_run` listener that re-runs failed jobs (limited attempts).

**Implement:** `.github/workflows/ci-auto-retry.yml`

- Trigger on completion of: `CI`, `Desktop Preview`, `Android Preview (Debug APK)`, `Extension Preview`
- If `conclusion == failure` and `run_attempt < 3` → `gh run rerun <run_id> --failed`
- Permissions: `actions: write` on base repo
- Cap at 3 attempts to avoid infinite loops
- Does **not** mask permanent reds: attempt 3 still fails the PR

### Phase 2 — Harden workflows (real resilience)

1. **Linux deps on every Ubuntu job** (done for desktop): keep `libudev-dev` + `libusb-1.0-0-dev` forever.
2. **Pin all `uses:` to full SHAs** (release already does; bring `ci.yml` / previews in line) — supply-chain + fewer “floating tag” resolve issues.
3. **npm install retries** already on web-ci `npm ci`; mirror that pattern for any network-sensitive step.
4. **`fail-fast: false`** on matrices (already desktop) so one OS flake doesn’t cancel others.
5. **Concurrency:** keep `cancel-in-progress: true` on PR previews; avoid stacking 4 half-dead matrices during outages.
6. **Optional later:** self-hosted or larger runners only if hosted keeps failing after Actions is green.

### Phase 3 — Prove green on PR #12

When Actions is healthy, require:

| Check | Expect |
|-------|--------|
| CI / web-ci | success |
| dependency-audit | success (critical+) |
| Desktop all 5 platforms | success (ARM past hidapi) |
| Android debug-apk | success |
| Extension Preview | success |

If a job fails **after** checkout with a compile/test error → fix product code (non-zero-touch allowed on this PR).  
If it fails only at “Getting action download info” → re-run / wait; do not change app logic.

### Phase 4 — Release ship

- AppImage x64 + ARM64 = portable **all-distro** Linux
- Windows exe64, macOS arm + Intel DMG, APK/AAB when production secrets set
- Tag only after Phase 3 is green on the merge commit

---

## What we will **not** do

- Treat CDN/Service Unavailable as a product bug
- Infinite empty commits during a published major_outage
- Disable required checks permanently to “look green”
- Drop Linux ARM / AppImage requirements to hide failures

---

## Immediate next steps (operator)

1. Open https://www.githubstatus.com — wait until **Actions: operational**.
2. On PR #12 head, re-run failed workflows:  
   `gh run list --branch agent/fusion-release-reliability --limit 8` then `gh run rerun <id> --failed`
3. Confirm ARM log no longer mentions `libudev`.
4. Land auto-retry workflow (Phase 1) so the next flake self-heals up to 2 times.
