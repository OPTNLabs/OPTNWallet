# PR12 CashFusion — production plan for Claude (manager: Grok)

**Paste this whole file into Claude Code.**  
Work only under this worktree. Report evidence, not vibes. Do not push unless the user explicitly says push.

---

## 0. Authority and roles

| Role | Who | Does |
|------|-----|------|
| **Manager** | Grok (user returns to Grok for review) | Plan, accept/reject, next task, keep/revert decisions |
| **Implementer** | You (Claude) | Code, tests, sabotage checks, local commits when green |
| **Owner** | User | Unlocks wallets, Chipnet soak, push approval, PR close |

You are **not** free to redesign architecture, claim production-ready, or reopen settled privacy trade-offs. Implement the tracks below. When stuck or rate-limited, leave a clean handoff in `CODEX-HANDOFF.md` (update in place) and stop.

**Team rule (non-negotiable):** PR #12 must **not** close until CashFusion (server + P2P) is **production-ready**. “Green CI + good enough privacy checkpoint” was refused. Finish the real gate.

---

## 1. Workspace and git facts (verify before coding)

```
Worktree:  D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability
PR:        https://github.com/OPTNLabs/OPTNWallet/pull/12
PR branch: agent/fusion-release-reliability
PR head:   d9accdbd  (input/signature unlinkability) — CI was green on this tip
Local HEAD may be ahead: fed69c95 (option-3 partial; unpushed)
```

Verify now:

```powershell
cd "D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability"
git status -sb
git log --oneline -12
git rev-parse HEAD
```

Rules:

1. **Only this worktree.** Never `D:\OPTNWallet-Desktop` alone or other paths unless user says so.
2. Prefer landing commits that can push to **`fork/agent/fusion-release-reliability`** (PR12). Local branch may be named `agent/derivation-discovery` — that is historical noise; PR tip is fusion-release-reliability.
3. **Do not push** without explicit user approval.
4. **Do not reset / clean / force-checkout** the dirty tree. Preserve intentional work.
5. Untracked: `CODEX-HANDOFF.md`, `VERIFIED-AGENT-GRAPH.json`, `target-review/`, this plan — do not delete. Stage handoff/graph only if user wants them in the PR.
6. Product source = **TypeScript + Rust only**. No new handwritten app `.js` / `.mjs` runtime. Build scripts left alone unless required.
7. Crypto: **Chipnet only** in live tests. Never log mnemonics/private keys. Never mainnet funds for fusion soak.

---

## 2. Settled architecture (do not reopen)

### 2.1 Standards

- **Server CashFusion:** Electron Cash is the golden standard. Match EC behavior unless a documented platform reason forces a change.
- **P2P CashFusion:** Same crypto / component accounting / credentials / signing / blame *ideas* as EC. Differs in discovery, transport (Nostr NIP-44/59), coordinator election, onion outputs. Do **not** throw away Grok’s onion / ephemeral-round design.

### 2.2 Three Schnorr roles (keep distinct)

| Role | Construction |
|------|----------------|
| BCH **transaction** signatures | Electron Cash **modified RFC6979** with domain `Schnorr+SHA256  ` (libauth P2P; native `schnorr.rs` deterministic path) |
| **Blind credential** issuer nonces | **Random one-shot CSPRNG**, never RFC6979, never reuse slots |
| **Nostr** events | BIP340 / Nostr signing — not BCH tx Schnorr |

### 2.3 Control plane vs anonymous component plane

**Round identity (ephemeral A₁)** — control only:

- Rendezvous / ACKs  
- Pedersen registration / credential_request  
- Expected counts, abort, components_ready, assembled  
- Blame **disclosure** messages (control plane; attributable)

**Never under round identity on the happy path:**

- Input submission  
- Output / onion submission  
- Transaction **signature** submission  

Those use throwaway Nostr keys + one-shot Tor isolation (already partially done in `d9accdbd` / transport).

### 2.4 Blame honesty (user corrected this — obey)

Blame is **fail-fast provable diagnosis**, not durable DoS protection.

- Accused = ephemeral round key A₁ → griefer returns as A₂.  
- **Cannot** ban across rounds without Sybil resistance (out of scope).  
- Useful for: abort reason, auto-fusion retry vs reselect, proof via openings.  
- Docs must **not** say “closes anonymous DoS hole.”

**Option 2** (no blame) rejected. **Option 3** (abort-only component disclosure + cross-check) approved. Successful rounds disclose nothing.

### 2.5 F1 / F2 status (do not re-litigate as open product holes)

- **F1** (ambiguous P2P broadcast finalized as success / reservations released): **FIXED in product code** (`c0f2de1c` era). You still must write the **regression test** (Track A1).  
- **F2** (Pedersen vs blind credential binding): re-checked as **not a value-steal soundness hole** (balance + assembly fee checks). Residual robustness nit. Do **not** put commitment into credential message (destroys unlinkability). Do not block production solely on inventing ZK for this nit unless manager reopens it.

### 2.6 Intentional residual from unlinkability (`d9accdbd`)

Three blame codes lost happy-path attribution (anonymous components have no accused):

| Code | After unlinkability | Option 3 goal |
|------|---------------------|---------------|
| `pedersen_unbalanced` | still blames | keep |
| `credential_slot_oob` | still blames | keep |
| `invalid_input_credential` | throws, no accused | restore via disclosure |
| `duplicate_outpoint` | throws, no accused | restore via disclosure |
| `invalid_signature_set` | drop frame, no accused | restore via disclosure |

**Do not** restore old `blameAndFail(from, …)` on anonymous senders — reports would fail verification and are worse than no blame.

---

## 3. What is already done (build on this — do not rewrite)

Landed on PR tip / ancestors (verify in tree):

1. Server + P2P harden, leases, Auto runner, Tor ownership work (`c0f2de1c` and earlier).  
2. One Tor socket per anonymous component + linger (`0187b34c`, `a066081d`).  
3. sql.js runtime so wallet opens (`ae06a35f`).  
4. **Input + signature unlinkability** (`d9accdbd`) — sabotage-verified in prior session; CI green on that tip.  
5. Local (may be on HEAD): option-3 **partial**  
   - `dbcd1bb3` — `component_disclosure` + peer disclose on abort + `findFaultInDisclosures`  
   - `fed69c95` — credential opening `a||b` + coordinator **collection**  
   - **Emit path attempted and REVERTED** — abort tests failed (`expected 1 to be +0`). Do not re-apply the keep-subscription flag without fixing cancel semantics.

Preserve Grok design: fresh per-round identities, kind 12230, NIP-44/59, onion peel anonymity, independent verify-before-sign, any peer may broadcast after coordinator timeout.

---

## 4. Production definition of done (team bar)

All of the following must be true before anyone says PR12 is ready to close:

1. **P2P:** inputs and signatures anonymous + credential-authorized; outputs anonymous + credential/serial authorized; happy path no disclosure.  
2. **Server:** EC-aligned crypto and protocol behavior with evidence (tests / golden vectors / Chipnet EC-compatible server if available).  
3. **Blame option 3:** three restored codes via abort disclosure + verified openings; abort paths still green; no DoS overclaim in docs.  
4. **F1 regression test** exists and passes (and fails under deliberate sabotage).  
5. **Onion stall** diagnosed and fixed or proven non-blocking with a tracked residual the team accepts (default: fix it).  
6. **Adversarial tests** for: unauthorized output inject, serial replay, wrong round/network, over-quota, grouped-input correlation regression, fee theft, missing outputs, stale outpoints, ambiguous broadcast.  
7. **Tor gates:** managed child only; no occupied-port adoption; no direct network fallback on fusion paths.  
8. **Chipnet multi-wallet soak** (wallets 5/6/7 if available): repeated Auto/P2P rounds; logs without secrets; success and recovery observed.  
9. **Docs** (protocol, privacy layers, threat model, README tail, PR body): match reality; no false “production shipped / full EC parity” until true.  
10. **CI green** on the final pushed head of `agent/fusion-release-reliability`.  
11. **`VERIFIED-AGENT-GRAPH.json`** updated with real commands/results (if present in tree).

Until then: fail-closed experimental language is fine in UI/docs; **do not** claim production.

---

## 5. Execution order (strict)

Work **one track at a time**. Commit when that track’s exit criteria pass. Run focused tests after each change. Full suites before claiming a track done.

### Track A — Safety locks (first coding day)

| ID | Task | Exit criteria |
|----|------|----------------|
| **A1** | Write **F1 regression test**: unverified P2P Tor broadcast must not report success / must not release input reservations | Test fails if old bug reintroduced; passes on current code; sabotage once |
| **A2** | Confirm multi-window lease / cooldown atomicity still green after any edit | Existing lease/auto tests pass |
| **A3** | Tor trust regression: child-only, no spoof ready, no direct fallback on fusion paths | Existing Tor tests + fix only if red |

### Track B — P2P component plane (verify + close gaps)

| ID | Task | Exit criteria |
|----|------|----------------|
| **B1** | Re-verify inputs: accepted on credential/outpoint/nullifier, not `others.includes(from)` / not grouping via `inputsByPeer` for acceptance | Code review + tests; sabotage grouping regression |
| **B2** | Re-verify signatures: per-input anonymous delivery; completion = signatures for all assembled outpoints | Same |
| **B3** | Output onions: credential + serial; reject bad batch before assembly; peeler stays anonymous | Adversarial tests |
| **B4** | Nullifier persistence across abort/retry/reload as designed | Tests |
| **B5** | Happy path: zero component disclosure / no blame report | Test |

### Track C — Option 3 blame (finish incomplete local work)

Current: 5/6. Missing: safe **emit** + opening **verify** + non-disclosure blame.

| ID | Task | Exit criteria |
|----|------|----------------|
| **C1** | Diagnose abort regression that broke emit (prior: keep subscription past settled → extra messages, 4 abort tests `expected 1 to be +0`). Fix without changing cancel semantics | Abort suite green with blame window |
| **C2** | Coordinator: after abort, bounded blame window; collect disclosures; `findFaultInDisclosures`; `createBlameReport` + `verifyBlameReport`; `onBlame`; optional broadcast; **do not block UI** on `reject` | Integration tests |
| **C3** | Verify credential openings cryptographically before trusting claims (`R' = R_i + a·G + b·P`, challenge matches slot). Disclose **disputed** components only | Unit + sabotage |
| **C4** | Restore three codes: `invalid_input_credential`, `duplicate_outpoint`, `invalid_signature_set` | Each has test; sabotage each |
| **C5** | Non-disclosure is blameable (absence) | Test + sabotage |
| **C6** | Docs/handoff: diagnosis only, not ban; no DoS overclaim | Grep clean |

**Do not** invent new primitives if `fusionBlame.ts`, ECIES, openings already exist.  
**Do not** put full input sets in disclosure if disputed-component path works.  
**Coordinator-only audience** for reports = optional later design; default remains gift-wrap to round participants unless user asks to scope narrowing first.

### Track D — Server Electron Cash parity

| ID | Task | Exit criteria |
|----|------|----------------|
| **D1** | Confirm native tx Schnorr = modified RFC6979; add/confirm golden vectors vs EC | Tests green |
| **D2** | Components, salts, Pedersen, blind issuance, fees, blanks as applicable | EC-shaped tests |
| **D3** | Covert paths + Tor for server remote work | No direct fallback |
| **D4** | Live or recorded interop with EC-compatible **Chipnet** server when available | Evidence logged without secrets |

### Track E — Live reliability and release honesty

| ID | Task | Exit criteria |
|----|------|----------------|
| **E1** | **Onion stall** (`outputSlots=0/4` or equivalent): root cause + fix or proven residual | Diagnosis written + test or soak evidence |
| **E2** | Auto timing: prefer fail retry **10s**, success cooldown **20s** (shared constants, P2P + server). Current code may be ~8s/~15s — align to user preference unless tests require otherwise | Constants + tests updated |
| **E3** | Chipnet soak wallets 5/6/7: Auto P2P multi-round; observe rendezvous, Tor, fuse, broadcast, recovery | Written soak notes in handoff |
| **E4** | Full adversarial suite from §4 item 6 | All new tests green + sabotage samples |
| **E5** | Docs + `VERIFIED-AGENT-GRAPH.json` + PR description accuracy | Matches HEAD |
| **E6** | `npm` lint/typecheck + focused fusion suites + CI green after push (when user allows push) | Evidence |

### Track F — Non-fusion PR12 items

Only after Tracks A–E meet the production bar **or** user explicitly prioritizes:

- Watch-only / PSBT-UR  
- OneKey / packaging  

Do not let packaging block fusion production gate unless team says so in writing.

---

## 6. How you work each iteration

1. State which **ID** you are doing (e.g. `A1`).  
2. Read the relevant files **before** editing.  
3. Smallest correct change.  
4. Tests: add/adjust; **sabotage once** for new security tests (break production path, confirm that test fails, restore).  
5. Commands to run often:

```powershell
cd "D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability"
npm.cmd run lint:core
npx tsc --noEmit
npx vitest run src/platform/desktop/nostr src/platform/desktop/__tests__
```

Known noise: occasional parallel flakiness in `FusionP2pInputRefresh` / `OptnKeyManager` — re-run those files in isolation before blaming product.

6. Commit message style: focused conventional commits (`fix(p2p-fusion): …`, `test(fusion): …`, `docs(cashfusion): …`).  
7. After each track chunk, update `CODEX-HANDOFF.md` status table (truthful).  
8. If a change breaks abort/cancel paths: **revert immediately**, then redesign. Do not stack speculative fixes.

---

## 7. Forbidden

- Claiming production-ready without §4 checklist evidence  
- Restoring attributable `from` checks on anonymous inputs/signatures/outputs  
- Putting Pedersen commitment into blind credential message to “fix F2”  
- Authenticating final onion peeler with round identity  
- Force-push, hard reset, deleting user scripts  
- Mainnet fusion tests  
- Broad drive-by refactors unrelated to current track  
- Inventing “ban griefer forever” using ephemeral keys  
- Pushing without user ask  

---

## 8. First tasks when you start (do in order)

1. Verify git state (§1). Summarize HEAD vs `d9accdbd` vs unpushed commits.  
2. **A1** — F1 regression test.  
3. **C1–C6** — finish option 3 properly (local commits already started; emit is the hard part).  
4. **E1** — onion stall.  
5. **B3–B5** adversarial gaps if any remain after read.  
6. **D** server parity evidence.  
7. **E2–E6** soak, docs, CI.

### 8.1 Approved redesign — P2P EC component plane (v4)

**Decision (owner, 2026-08-09):** Close F2 the Electron Cash way on P2P — **option (1)**, not ZK.

- Design note (normative for implementers): [`docs/p2p-ec-component-plane-v4.md`](docs/p2p-ec-component-plane-v4.md)
- Blind-sign `sha256(full EC Component)`; unlinkability from anonymous transport only
- Beta → **no migration**; hard-reject v3 at cutover
- **Do not** paste Pedersen into the v3 string credential
- Phases B→F in that doc; do not bump `ROUND_MSG_VERSION` to 4 until redeem path works
- Can run **in parallel** with C1–C5 blame emit; identity isolation test must stay green

If usage limit hits mid-task: commit only green work; write “STOPPED AT: IDx — next step …” in `CODEX-HANDOFF.md`; leave tree buildable.

---

## 9. Report format (every time you pause or finish a track)

```text
TRACK: <id>
HEAD: <short sha>
CHANGED: <files>
TESTS: <commands + pass/fail counts>
SABOTAGE: <what you broke, expected fail, restored>
BLOCKERS: <none | description>
NEXT: <next id>
PUSHED: no
```

User will bring this (or the session) back to **Grok** for manager review.

---

## 10. One-line mission

**Make PR12 CashFusion production-ready: EC-standard server crypto/behavior, fully anonymous+authorized P2P component plane, abort-safe option-3 blame diagnosis, locked regressions, Chipnet soak, honest docs — without undoing unlinkability or inventing Sybil resistance.**

Start at §8 step 1, then **A1**.
