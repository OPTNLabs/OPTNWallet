# PR12 CashFusion continuation handoff

Updated: 2026-08-09. Worktree: `D:\OPTN wallet work\OPTNWallet-Desktop-worktrees\fusion-release-reliability`.

## Non-negotiable state rules

- Preserve the dirty tree. Do not reset, checkout, revert, clean, or re-run broad formatters.
- Preserve the four untracked user scripts under `scripts/`; never stage or delete them.
- Current branch is `agent/derivation-discovery`, but the requested destination is PR12's remote branch `fork/agent/fusion-release-reliability`.
- Do not push until the final combined gate passes. `gh` was unauthenticated (401); never reuse or expose the PAT pasted in chat.
- `VERIFIED-AGENT-GRAPH.json` is the current work graph; update evidence/statuses and validate it before final publication.

## Implemented hard security/reliability work

1. Native server core now uses Electron Cash modified-RFC6979 BCH Schnorr, canonical component vectors, and live own-input revalidation before PlayerCommit and before signing.
2. Managed Tor never adopts an unowned listener; readiness belongs to the spawned child; status is observational; spoof-marker listener tests pass.
3. Electrum retries only failed transport members on another server, preserves successful members, and coalesces overlapping wallet scans.
4. Wallet seed bootstrap decrypts mnemonic/passphrase with one derived non-extractable key per scoped batch; Home's duplicate serial listunspent baseline was removed.
5. P2P protocol v3 authorizes each anonymous output using a round/network/tier/output-bound blind credential and serial nullifier; v2 is rejected; onion plaintext is uniform 384 bytes.
6. P2P production signing crosses the native Rust boundary (`fusion_p2p_sign`), validates the exact owned inputs/outputs/fee/template, uses modified-RFC6979, and renderer input buffers are wiped after use.
7. P2P broadcast is native Tor-only with durable outbound reservation before relay; no ordinary renderer Electrum broadcast.
8. Fusion completion now awaits SQL history persistence and Redux injection. Failure returns an explicit warning while outbound tracking/depth/refresh remain safe.
9. Server Auto timing is EC-shaped: immediate JoinPools, 5-second scheduler cadence, 600-second inactivity only without server besttime; manual has no Auto inactivity deadline. Auto passes native `joinInactiveTimeoutMs: 600000`.
10. Server coin selection now has a dedicated EC policy: confirmed/non-token/unfrozen whole-address buckets, max three/address, random normal-mode fraction 0.5, max 20 coins, and 99.9% eligible-value depth stop. P2P policy remains separate.
11. Each Fusion attempt now performs one spend-critical wallet reconciliation and reuses it for selection/depth/status.
12. Auto refuses to start without atomic Web Locks. Heartbeat ownership loss aborts the active round. Manual retains a bounded owner-checked storage fallback.
13. Server Auto preflights configured servers selected-first through Tor plus validated ServerHello, fails over only before round/key work, and never rotates after native round start.
14. Auto lifecycle cancellation is limited to wallet/network/master-Fusion/transport-mode boundaries; Auto, Tor, relay, or server preference edits affect the next round without cancelling an in-flight manual/Auto round.
15. Wallet Fusion policy exposes hydration readiness; DesktopAppShell gates Auto until the currently open wallet's policy has loaded.

## Most recent verified evidence

- `npm.cmd run typecheck:core`: PASS.
- Server combined focused suite: 8 files / 117 tests PASS.
- FusionRunnerService after one-scan/lease/policy changes: 26/26 PASS.
- Previous focused evidence in this same tree: Nostr 17 files / 107 tests PASS; P2P integration 4 files / 31 tests PASS; Electrum 45/45; Tor 7/7; responsiveness 18/18; native signer 10/10; native tx 7/7; native server run 16/16.
- A strict combined adversarial reviewer is currently running as `/root/combined_fusion_final_review`; consume its PASS/FAIL before claiming completion.

## Final-gate findings (Codex, carried forward by Claude 2026-08-09)

### F1 — Ambiguous P2P broadcast finalized as success. FIXED + LOCKED.

**Track A1 closed 2026-08-09 (`bd2407ae`, local, unpushed).** The fix below
now has a regression test:
`src/platform/desktop/__tests__/FusionP2pBroadcastReservation.test.ts`,
4 tests. It drives the real `runP2pFusion` (round runner mocked at the
`nostr/fusionSession` boundary so it calls the service's own `broadcast`
callback; verification steered through the `invoke` mock) and asserts all
three outcomes — never-reached-relay releases, verified releases, unresolved
HOLDS and reports `Fusion pending —`. Sabotage-checked on both halves
independently: an unconditional `finally` release fails the hold assertion,
and forcing the `Fused ✓` branch fails the pending assertion. Production file
restored to an empty `git diff` after each; 4/4 green.

Before this commit `broadcastAttempted`/`broadcastVerified` appeared in
exactly one file — `FusionP2pService.ts` itself — and in zero tests, so the
suite passed with or without the fix.


`broadcastP2pTransactionTorOnly` returns `{verified:false, warning:'…remains
reserved while wallet sync verifies it'}` when neither the relay observation nor
the Tor-routed `fusion_transaction_is_known` lookup can confirm visibility
(`FusionP2pService.ts:940`). `runP2pFusion` discarded `receipt.verified`, reported
`Fused ✓`, and its `finally` released the input reservations unconditionally —
contradicting the receipt's own promise and letting the next round build a
conflicting spend against a CoinJoin that may already be confirming.

Fix: `broadcastAttempted` / `broadcastVerified` are hoisted beside
`reservedForRound` (the `finally` is outside the broadcast `try`). Reservations
are released only when the round never reached the relay (so a failed round does
not strand coins) or was independently seen. An unresolved broadcast keeps the
lock until the stored TTL or wallet sync resolves it, and the status line reads
`Fusion pending —` instead of `Fused ✓`.

### F2 — Pedersen/credential binding. CLOSED BY REDESIGN (not a string-hash nit patch).

**Decision 2026-08-09:** P2P will move to **EC component plane v4** — blind-sign
`sha256(serialized Component)` like server `components.rs` / Electron Cash.
Unlinkability stays from per-component anonymous transport only. No ZK. No
migration (beta). Spec: `docs/p2p-ec-component-plane-v4.md`.

**Phase B landed (local):** `fusion/p2p_component.rs` + `fusion_p2p_encode_component`
+ TS `fusionComponentV4.ts` — encode EC components and `sha256(component)` blind
message; wire version still 3. Next implementer phases: C issuance, D redeem.

Until v4 cutover, the **interim** value story below still holds (do not weaken it).

### F2 interim (v3 still on wire) — value conservation, not EC-exact binding

Re-checked 2026-08-09 against the assembly path, which the original finding did
not consider. Value conservation is enforced three times, independently:

1. `fusionSession.ts:1764-1769` — a credential request must carry exactly one
   commitment per requested component (`amountCommitments.length ===
   requests.length === inputCount + outputCount`), so a peer cannot obtain more
   credentials than it committed to.
2. `:1770-1784` — `pedersenBalanceHolds(...)` must pass before ANY credential is
   issued; failure is a `pedersen_unbalanced` blame.
3. `:2034-2050` — before any peer signs, the coordinator recomputes
   `fee = Σ inputs.value − Σ outputs.value` on the PLAINTEXT assembled draft and
   refuses when `fee < 0 || fee > required * 3`.

So the attack the original finding implied — commit to balancing amounts, then
blind-request credentials for inflated outputs — cannot steal value. It produces
a negative fee and the round refuses to assemble.

Residual, honestly scoped: a peer can still lie in its commitment set relative
to its blinded requests, because the blinded message is opaque to the issuer.
The only consequence is that its own round fails at assembly. That is a
robustness/DoS nit, not a value-soundness gap, and it does not gate PR12.

Original (superseded) framing follows for the record:

`outputCredentialMessageHash` (`fusionBlindSchnorr.ts:338`) binds
`version|network|session|tier|output|script|value|serial`. No Pedersen commitment
appears in it, and `verifyAuthorizedOutputBatch` recomputes from the same fields.
`buildPlayerPedersen` (`fusionSession.ts:373`) separately produces
`amountCommitments`. The coordinator therefore checks value conservation over one
object set and blind-signs authorization over a different one, with nothing
linking credential *k* to commitment *k*.

**Do not "fix" this by putting the commitment in the credential message.** The
commitments are submitted **attributed** per peer with the credential request,
so revealing an output's commitment alongside the anonymous output would let the
coordinator map every shuffled output back to its submitter. That trades a
soundness gap for a total unlinkability break — strictly worse.

Closing it properly needs one of:
- a ZK proof that the credential's `value` equals the opening of a commitment in
  the round's committed multiset, revealed without identifying which; or
- moving to EC's structure, where the blind-signed object *is* the component
  (commitment included) and unlinkability comes from a per-component anonymous
  channel rather than from withholding the commitment.

Until then PR12 must not be described as production-ready, and the P2P value
soundness claim must not be stated without this caveat.

## Input unlinkability + per-input Tor — EXACT change set (approved, not yet built)

Per the Codex/Grok plan. Must land as ONE change: anonymising inputs while
signatures stay attributed gives zero privacy (the signature set names the
peer's own inputs) and anonymising senders before the coordinator stops
checking `from` rejects 100% of inputs. Line numbers are from `a066081d`.

1. `nostr/fusionTransport.ts:83` — rename `isAnonymousOutput` →
   `isAnonymousComponent` and extend to `'inputs'` and `'signature'`. The
   one-shot pool + deferred close (`ONE_SHOT_POOL_LINGER_MS`) then applies to
   every component automatically; nothing else in transport changes.

2. `nostr/fusionSession.ts:1583` — mirror the OUTPUT design, which already
   solves this. Beside `inputsByPeer` (keep, for the coordinator's own inputs)
   add `const anonymousInputs: FusionInputRef[] = []` and
   `const inputPool = () => [...inputsByPeer.values()].flat(), ...anonymousInputs]`,
   exactly parallel to `outputsByPeer` / `anonymousOutputBatches` / `outputPool`
   at `:1596-1601`.

3. `:1620 inputQuotaByPeer` — derive
   `expectedInputCount = params.myContribution.inputs.length + Σ inputQuotaByPeer.values()`.
   Quotas are still issued per peer at `:1806` (credential requests ARE
   attributed and stay that way — only components go anonymous).

4. `acceptInputs` `:1817` — drop the `from` parameter. Quota check becomes
   `inputPool().length + inputs.length > expectedInputCount`. Duplicate
   detection uses the existing `credentialedInputs` set instead of scanning
   `inputsByPeer`. The per-input credential verify at `:1830-1841` is unchanged
   and is what proves the sender was admitted.

5. `outputsReady` `:1947` — replace `inputsByPeer.size !== params.participants.length`
   with `inputPool().length !== expectedInputCount`, and take totals from
   `inputPool()`.

6. `:2113` inputs handler — remove `others.includes(from)`. Accept on session +
   valid credential + not-already-submitted.

7. `:2213` signature handler — remove `others.includes(from)` and the
   `inputsByPeer.get(from)` expected-set check. Validate each signature against
   its assembled input instead, and change the completion gate at `:1872` from
   `signedPeers.size !== others.length` to
   `signaturesByOutpoint.size !== assembled.inputs.length`. Retire `signedPeers`.

**Accepted consequence:** `duplicate_outpoint` and `invalid_signature_set` blame
lose attribution — `verifyBlameReport` rejects an accused outside the
participant set, and an anonymous component has no accused. Those two paths
become round-fail-without-blame. This matches Electron Cash, where covert
components are likewise unattributable. Do not try to keep them attributed.

## EC-style blame phase (APPROVED — option 3). Build on what exists.

Restores the three blame codes `d9accdbd` had to drop, WITHOUT giving back the
attribution that `d9accdbd` removed. Nothing here is invented: every primitive
already exists, only the disclosure message is new.

Why the three codes were dropped: `fusionBlame.ts:143` rejects any report whose
`accused` is outside the participant set, and an anonymous component's sender is
a one-time key. Restoring the old `blameAndFail(from, …)` calls verbatim would
emit reports every peer rejects as unverifiable — worse than not blaming.

**Reuse, do not rewrite:**
- `nostr/fusionBlame.ts` — `BlameCode`, `BlameReport`, `createBlameReport`,
  `verifyBlameReport`, and the abort wiring. Unchanged.
- `src-tauri/src/fusion/encrypt.rs` — EC blame ECIES, already implemented and
  currently used only on the server path.
- `src-tauri/src/fusion/components.rs` — already stores `(salt, pedersen_nonce)`
  per component "for the blame `Proof`".
- Credential serials: peers hold `outputSerials`; the coordinator holds the
  nullifier set (`nostr/fusionCredentialNullifiers.ts`).

**The one new message — `component_disclosure`, CONTROL PLANE.**
Sent under the round identity (NOT the anonymous set in
`fusionTransport.ts:83`), so it is attributable by construction. Contents: the
outpoints the peer registered plus the credential serials it used.

**Trigger:** only on round abort. A successful round discloses nothing, so
unlinkability on the happy path is exactly what `d9accdbd` delivers.

**Recovering each dropped code from cross-checked disclosures:**
- `duplicate_outpoint` — two peers disclose the same outpoint.
- `invalid_signature_set` — a peer's disclosed outpoints have no matching entry
  in `signaturesByOutpoint`.
- `invalid_input_credential` — a disclosed serial the issuer never signed.
- **Non-disclosure is itself blameable** and needs no new evidence type: a peer
  that never discloses is identified by absence.

**What this buys, stated accurately — it is NOT DoS protection.**

An earlier revision of this section claimed the blame phase "closes the
anonymous-DoS hole `d9accdbd` opened." That was wrong. Blame names the round
pubkey `A₁`, which is ephemeral and discarded when the round ends; the same
griefer returns as a fresh `A₂` that nothing can recognise. Identifying a
griefer is not excluding one.

Electron Cash gets teeth here because its coordinator is a SERVER that can
refuse a connection. Ours is a peer with no such lever, so P2P blame is
genuinely weaker than EC's and must not be described as parity.

What it actually delivers:
- fail fast on a provable fault instead of waiting out the 120s timeout;
- correct diagnosis — "a peer double-claimed a coin" vs "your own coins went
  stale", which is what auto-fusion needs to decide retry-now vs reselect;
- proof rather than accusation, via `BlindSignatureRequest.openingHex()`.

Durable exclusion needs something a fresh keypair cannot dodge — cost, stake or
reputation. That is Sybil resistance, a separate unsolved problem for both
architectures, and it is explicitly NOT in scope here.

**Accepted trade-off (same as Electron Cash):** an attacker can deliberately
fail rounds to force disclosures. EC answers this by blaming and excluding the
cause — which is the capability being bought back here. A failed round
broadcasts no transaction, so there is no on-chain linkage from a disclosure.

## Immediate remaining work (in order)

1. Run the updated ServerFusionRunner test after the new Auto timeout assertion, then full targeted TS + Rust suites and `typecheck:core`.
2. Fix only concrete combined-review failures; re-run the smallest load-bearing test then the combined gate.
3. Documentation consistency: `docs/p2p-cashfusion-protocol.md` must say v3 everywhere; README tail must accurately describe P2P NIP-44/NIP-59, kind 12230 ephemeral round identities, output credentials/nullifiers, Tor boundaries, native signing/broadcast, and the attributable input/signature-channel residual. Do not claim complete input unlinkability or EC wire parity for P2P.
4. Update/validate `VERIFIED-AGENT-GRAPH.json` with exact commands/results.
5. Launch the current worktree build (not an old install) and run a Chipnet multi-wallet P2P soak with wallets 5/6/7 if available. Observe logs without exposing keys/outpoints. Server live soak requires a real reachable EC-compatible Chipnet Fusion server; do not fabricate one and never test server Fusion with mainnet funds.
6. Stage only task files plus intentional docs/tests. Exclude the four user scripts and normally exclude this handoff/graph unless explicitly wanted in the PR.
7. Commit one coherent PR12 checkpoint and push explicit `HEAD:agent/fusion-release-reliability` only after final PASS. Preserve the existing PR body if updating it.

## Known honest residuals, not silent claims

- P2P input registration and later signature traffic remain attributable to the per-round identity. Output contributor unlinkability is protected; full input-channel unlinkability would require an incompatible signing-channel redesign.
- P2P nullifier persistence uses coordinator-local storage and relies on single coordinator ownership; it is not a cross-window transactional CAS.
- Native secret wiping is best effort because compiler/library internal scalar copies cannot be guaranteed without a broader secret-container API change.
- Server EC policy cannot yet enforce coinbase maturity or historical-txid semi-linkage because current UTXO inputs lack authoritative metadata. It fails closed on ordinary unconfirmed coins and keeps address buckets intact.
- No trustworthy public Chipnet Fusion server has been established. Code failover cannot manufacture server availability.

## Blame + timeout tracks COMPLETE (through C4 / E0)

| Track | Commit | Notes |
|-------|--------|--------|
| C1–C2 emit | `f553a331` / `d5d39124` | `invalid_signature_set` E2E |
| C3 openings | `b1c4db74` / `759c43e9` | verify before trust |
| E0 timeout skew | `8ed355e9` | peer margin from blame window |
| C4 | `94d13a06` | forged opening → `invalid_input_credential`; duplicate unit lock |

**Code status (all five):**

| Code | State |
|------|--------|
| `pedersen_unbalanced` | blames (never lost) |
| `credential_slot_oob` | blames (never lost) |
| `invalid_signature_set` | restored E2E |
| `invalid_input_credential` | restored E2E (forged opening) |
| `duplicate_outpoint` | rule + verifyBlameReport; live gate is registration throw |

**NEXT:** E1 onion stall, E2 auto timing, V4-C… (see `CLAUDE-A-TO-Z.md`). Optional C5.

## E0 done (`8ed355e9`). Next: C4 — and it is not test-only

Scoped C4 before stopping. The two remaining codes are NOT symmetric:

- **`duplicate_outpoint`** — the rule exists in `findFaultInDisclosures` and has
  a unit test (`fusionBlame.test.ts`). What is missing is the C2-style E2E proof
  through a real session. Route: give two peers the SAME input so both disclose
  it with valid openings. Obstacle to check first — if the coordinator rejects
  the duplicate at registration while it is still control-plane, the round
  aborts with `anonymousInputs.length === 0` and the C1 gate skips the blame
  window, so no report is emitted. Confirm where duplicate detection fires
  before writing the test.
- **`invalid_input_credential`** — `findFaultInDisclosures` has NO rule that
  ever returns this code. It returns only `duplicate_outpoint` and
  `invalid_signature_set`, then null. So this one is a BUILD like C3 was, not a
  test: decide the rule first (an outpoint disclosed with a slot that was never
  signed, or an opening that fails verification, is the natural candidate now
  that `verifiedDisclosures()` already drops unproven outpoints silently —
  dropping is not the same as accusing).

Keep both listed as LOST until each has a green sabotage-checked test.
