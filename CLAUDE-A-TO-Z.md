# PR12 CashFusion — full A→Z plan for Claude (autonomous)

**Read this entire file. Execute in order. Do not wait for Grok between steps unless a hard blocker appears or the user says stop.**

Worktree only:
`D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability`

**Do not push** unless the user explicitly says push.  
**Do not claim production-ready** until §Z exit criteria are all true.

---

## Snapshot (verify with `git log -8` before coding)

| Item | State |
|------|--------|
| PR #12 public tip (approx) | `d9accdbd` unlinkability — was CI green |
| Local stack (may grow) | F1 lock, threat-model honesty, Phase B v4 encode, C1 emit, C2 emit tests |
| Known good recent | `d5d39124` C2, `f553a331` C1, `0a504e0f` Phase B, `bd2407ae` F1, `72564af2` blame≠DoS |
| Live wire | `ROUND_MSG_VERSION = 3` until v4 Phases C–F complete |
| Untracked ok | `CODEX-HANDOFF.md`, `CLAUDE-PRODUCTION-PLAN.md`, `VERIFIED-AGENT-GRAPH.json`, `target-review/` |

If HEAD differs, re-verify; do not reset/clean.

---

## Permanent rules (never violate)

1. **Only this worktree.**  
2. **Chipnet only** for live funds; never log seeds/keys.  
3. **Product source = TypeScript + Rust** — no new app `.js`.  
4. **No social npub in fusion** — keep `fusionIdentityIsolation.test.ts` green.  
5. **Two fusion key layers:** round throwaway (control) + per-component throwaway (anonymous). Chat identity is separate and unused.  
6. **Blame = diagnosis only**, not ban/DoS mitigation. No Sybil systems (PoW, bonds, membership).  
7. **Do not** restore `blameAndFail(from)` on anonymous component senders.  
8. **Do not** put Pedersen into v3 string credentials (breaks unlinkability).  
9. **v4 F2 fix** = EC `sha256(Component)` only (option 1). **No ZK.** Beta → hard cutover, no dual-stack migration.  
10. **Sabotage-check** every new security test (break prod, confirm fail, restore).  
11. **Revert** abort/handler regressions immediately (`activeHandlerCount()===0` at settle).  
12. **Do not touch** Grok Phase B files except to *call* them: `p2p_component.rs`, `fusionComponentV4.ts`, isolation test — unless fixing a real compile break you caused.  
13. Small commits; report format at end of each letter section.

### Report block (every section stop)

```text
TRACK: <letter/id>
HEAD: <sha>
CHANGED: <files>
TESTS: <commands + results>
SABOTAGE: <what / result / restored>
BLOCKERS: <none|...>
NEXT: <next letter>
PUSHED: no
```

### Commands

```powershell
cd "D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability"
npm.cmd run lint:core
npx tsc --noEmit
npx vitest run src/platform/desktop/nostr src/platform/desktop/__tests__
# isolation + known flaky isolation re-run if needed:
npx vitest run src/platform/desktop/__tests__/FusionP2pInputRefresh.test.ts src/platform/desktop/__tests__/OptnKeyManager.test.ts
# native when you touch Rust:
cd src-tauri; cargo test --lib fusion::p2p_component::
```

---

## Already DONE — do not redo

| ID | What | Evidence |
|----|------|----------|
| **A1** | F1 regression: unresolved broadcast ≠ success / hold reservations | `bd2407ae` |
| **A2/A3** | Lease + Tor still green at that time | prior report |
| **C6** | Threat model: blame ≠ DoS mitigation; EC no ban list honesty | `72564af2` |
| **Phase B** | EC component encode + `sha256(component)` + Tauri `fusion_p2p_encode_component` + TS golden | `0a504e0f`, design `docs/p2p-ec-component-plane-v4.md` |
| **Identity isolation** | Fusion* must not import identity/chat | test in `__tests__/fusionIdentityIsolation.test.ts` |
| **C1** | Emit: await disclosure window **before** cleanup/reject; gate if no anonymous traffic; verifyBlameReport before send | `f553a331` |
| **C2** | E2E: withheld sigs → `invalid_signature_set` on wire; control-plane abort no blame + fast; Hub drop hook; sabotage | `d5d39124` |

**Honest code status after C2:** `invalid_signature_set` restored with test.  
`invalid_input_credential` + `duplicate_outpoint` still **lost** until C4.  
Openings **not** verified yet → C3.

### Production finding from C2 (must fix in track E)

With **uniform** `timeoutMs`, all peers timeout with the coordinator → peers tear down before abort → no disclosures → blame window burns full ceiling and emits nothing.  
**Coordinator must lose first** (or peers use longer deadline / wait for abort before teardown). Track **E0** below.

---

## A→Z remaining work

### C3 — Credential opening verifier (BUILD, not a checkbox)

**Why:** `openingHex()` produces `a||b` but nothing verifies. Emit currently **trusts** disclosure claims → griefer can forge/dodge.

**Do:**

1. Implement verifier next to blind Schnorr (TS and/or native):  
   given coordinator slot `R_i`, issuer `P`, opening `a||b`, recomputed challenge must match what was signed at that slot:  
   `R' = R_i + a·G + b·P` (with EC jacobi/c conventions already used in codebase).  
2. Change disclosure path to carry **(slotIndex, opening, disputed outpoint/component)** not “whole input set” if not already.  
3. `findFaultInDisclosures` / emit path: **reject** disclosures that fail opening verify before accusing anyone.  
4. Unit tests + sabotage (accept forged opening → test must fail).  
5. Wire coordinator to only trust verified openings.

**Exit:** forged opening cannot produce a accepted blame report; honest opening can.

---

### C4 — Restore remaining blame codes with tests each

| Code | Test scenario (sketch) |
|------|-------------------------|
| `duplicate_outpoint` | Two peers disclose same outpoint with valid openings → accuse per findFault rules |
| `invalid_input_credential` | Disclosure serial/slot never signed / opening fails / wrong credential → code fires |
| Keep | `invalid_signature_set` already locked in C2 — do not regress |

**Exit:** three codes each have a green sabotage-checked test; docs/handoff list them restored.

---

### C5 — Non-disclosure blameable (if design still wants it)

Peer never sends `component_disclosure` after abort while anonymous components existed → identified by absence (only if openings/rules make this sound; do not frame honest Tor lag without bound). Prefer: after window, missing disclosure from a peer who was expected to disclose is blameable **only** when protocol requires disclosure on abort and they were in the participant set.

**Exit:** test + sabotage; or document intentional skip with reason if unsafe.

---

### C6 — already done

Skip unless new DoS/blame wording appears — re-grep docs.

---

### E0 — Production timeout skew (from C2 finding)

**Must fix before soak claims blame works live.**

- Coordinator `timeoutMs` shorter than peers, **or** peers on timeout wait for abort/disclosure phase before unsubscribe, **or** explicit “blame wait” after local timeout when abort received.  
- Prefer one clear mechanism; test: three peers + coordinator same wall clock → disclosures still arrive when one withholds sigs.  
- Document in `CODEX-HANDOFF.md` / protocol doc.

**Exit:** no uniform-timeout dead blame phase; test covers it.

---

### E1 — Onion stall

Diagnose `outputSlots=0/N` / peel stall; fix or proven residual. Tests if possible.

---

### E2 — Auto timing (user preference)

Fail retry ~**10s**, success cooldown ~**20s**, shared constants for P2P + server (current may be ~8s/~15s). Update tests.

---

### B residual — v3 still on wire is OK until v4

No action beyond keeping Phase B API available.

---

### V4-C — Issuance uses EC component hash

Per `docs/p2p-ec-component-plane-v4.md` Phase C:

- PlayerCommit-equivalent / credential_request uses **native** `fusion_p2p_encode_component` / `sha256(component)` as blind messages.  
- Pedersen balance still required before issuing `s`.  
- Stop issuing on v3 string hashes for new code paths (feature or version gate).

**Exit:** unit/integration: issued blind sig verifies over `sha256(component_ser)`.

---

### V4-D — Anonymous redeem of full components

- Message carries `component_ser + unblinded sig` (+ serial if kept).  
- Transport: already anonymous for component types — extend allowlist; never round-key sign bodies.  
- Coordinator accepts only valid component sigs, uniqueness, quota.

**Exit:** adversarial inject/replay/over-quota tests green.

---

### V4-E — Assemble from verified components

- Build tx like server `FusionTx::from_components` semantics.  
- Keep verify-before-sign, native sign, F1 reservation rules.

---

### V4-F — Cutover

- `ROUND_MSG_VERSION = 4`.  
- Reject v3 round messages.  
- Delete or hard-dead v3 string credential redeem.  
- Update `p2p-cashfusion-protocol.md`, privacy layers, threat model F2 residual.  
- Full suite green.

---

### V4-G — Blanks / fixed component counts (EC metadata parity)

If not in D, add blanks for count privacy. Tests.

---

### D-server — Electron Cash server path evidence

- Golden vectors / RFC6979 native already present — extend if gaps.  
- Chipnet EC-compatible server if available; never invent fake mainnet.  
- Do not claim full replica without evidence.

---

### E3 — Chipnet soak

Wallets 5/6/7 if available: Auto P2P multi-round; logs without secrets; note success/fail and timeout skew.  
Server soak only with real EC-compatible Chipnet server.

---

### E4 — Adversarial suite completeness

Unauthorized output, serial replay, wrong round/network, over-quota, grouping under round key regression, fee theft, missing outputs, ambiguous broadcast (F1), blame forge with bad opening.

---

### E5 — Docs + VAG honesty

- No “production shipped” until §Z.  
- Update `VERIFIED-AGENT-GRAPH.json` if present with real commands/results.  
- Handoff residual list accurate.

---

### E6 — CI

When user allows: push `HEAD:agent/fusion-release-reliability`, confirm all PR12 checks green.

---

### Z — Production exit (team will not close PR12 before this)

All must be true:

1. P2P: anonymous + authorized components (v4 preferred; if still v3, F2 residual documented and team accepts — **default goal is v4 complete**).  
2. Blame: C3+C4 (+C5 if done); diagnosis only; E0 timeout skew fixed.  
3. F1 locked; identity isolation locked.  
4. Onion stall fixed or accepted residual.  
5. Adversarial suite green.  
6. Tor child-only / no direct fallback still holds.  
7. Chipnet soak notes.  
8. Docs honest.  
9. CI green on pushed head.  
10. Server path EC-aligned with evidence appropriate to claims.

---

## Suggested execution order (minimize thrash)

```text
C3 → C4 → C5(optional) → E0 → E1 → E2
  → V4-C → V4-D → V4-E → V4-F → V4-G
  → D-server evidence
  → E3 soak → E4 fill gaps → E5 docs → (user) E6 push/CI
  → Z checklist
```

You may **parallelize** only if files don’t conflict:

- C3–C5 touch blame/session/blindSchnorr.  
- V4-C+ touch credentials/session/transport + native.  
- Prefer finishing **C3–E0** before deep V4-D so abort/blame stays trustworthy during redesign.

---

## Forbidden shortcuts

- Claiming three blame codes restored without C3 openings + C4 tests.  
- Bumping to v4 version number before redeem works.  
- Dual-stack “support v3 forever.”  
- Sybil/ban features.  
- Pushing without user ask.  
- Broad unrelated refactors.

---

## If usage limit hits

1. Commit only green work.  
2. Append to `CODEX-HANDOFF.md`: `STOPPED AT: <id> — next: ...`  
3. Leave tree buildable; no half-applied abort changes.

---

## Start now

1. `git log -5 --oneline` and `git status -sb`  
2. Confirm C2 HEAD present.  
3. **Begin C3** — opening verifier + wire + tests + sabotage.  
4. Continue A→Z without waiting for Grok unless blocked.

**Mission one-liner:** Production-ready CashFusion on PR12: EC-true component credentials on P2P, abort-safe proven blame diagnosis, no social identity, no fake DoS claims, soak + CI — then stop.
