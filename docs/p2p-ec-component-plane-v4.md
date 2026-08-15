# P2P CashFusion — EC component plane (protocol v4)

**Status:** **Shipped.** `ROUND_MSG_VERSION = 4`. Adversarial component-opening
tests are in-tree. v3 clients are rejected.

**Audience:** Implementers. Wire details also summarized in
[p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md).

There is **no v3 compatibility path**. Mixed old/new windows cannot share a
round — restart every wallet after a protocol bump.

---

## 1. Problem

### What v3 does well

- Ephemeral **round identity** for control (never the wallet social npub).
- **Anonymous** delivery of inputs, outputs, signatures (throwaway Nostr key + one-shot Tor).
- Blind credentials + nullifiers authorize outputs/inputs without `others.includes(from)`.
- Value conservation enforced by Pedersen balance on `credential_request` + plaintext fee at assembly.

### What v3 does not do (F2 / EC parity)

v3 blind-signs a **domain-separated string hash**:

```text
optn-p2p-component-v3|network|session|tier|role|script|value|serial
```

Pedersen commitments live on a **separate** attributed object (`credential_request.amountCommitments`).  
They are **not** inside the signed message. That is **not** Electron Cash:

```text
// Server / EC (already in this repo: src-tauri/src/fusion/components.rs)
msg = sha256(serialized Component)   // full protobuf component
// InitialCommitment carries amount_commitment (Pedersen) + salted_component_hash
// Blind-sign the component; redeem the same bytes covertly / anonymously
```

**Naive fix forbidden:** stuffing the Pedersen point into the v3 string credential so the coordinator can match anonymous redeems to an attributed commit set → **destroys unlinkability**.

### Decision

Implement **option (1)** — EC structure on P2P:

| Piece                | Source of truth                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| What is blind-signed | `sha256(canonical EC Component bytes)`                                                         |
| Unlinkability        | Per-component **anonymous transport only** (throwaway + Tor) — same role as EC covert circuits |
| Shared crypto        | Prefer native FusionCore (`components`, `pedersen`, `schnorr`) over parallel TS-only hashes    |
| ZK multiset proofs   | **Out of scope**                                                                               |

ZK (option 2) is deferred indefinitely.

---

## 2. Goals and non-goals

### Goals

1. **EC-exact F2:** credential message = hash of full component (commitment-related fields as in EC component + InitialCommitment flow).
2. **Preserve happy-path unlinkability:** coordinator cannot group components by round identity.
3. **One component story** for server + P2P (serialize once, two transports).
4. **Fail closed** on old v3 credential redeem once v4 is on.
5. **Honest docs:** v4 + adversarial tests are in-tree; Chipnet 10-way dogfooded.

### Non-goals

- Sybil resistance / durable ban of griefers (ephemeral keys).
- Full Electron Cash **server wire** over Nostr (still Nostr rendezvous + peer coordinator).
- Using wallet social npub / `identity.ts` / `chat.ts` in any fusion path (see `fusionIdentityIsolation.test.ts`).
- Soft migration from v3 (beta — hard cutover).

---

## 3. Identities (unchanged model, clarified)

| Layer                      | Key                                                      | Used for                                                                                                |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A. Chat (optional product) | Seed-derived Nostr / npub                                | DMs only — **never fusion**                                                                             |
| B. Round (control)         | `generateRoundIdentity()` per attempt                    | Pool announce, ACK, PlayerCommit-equivalent, credential issuance control, abort, blame control messages |
| C. Component (anonymous)   | Fresh `generateSecretKey()` per publish (+ one-shot Tor) | Submitting each component and each tx signature                                                         |

Blame reports name **layer B** only. They are diagnosis, not DoS mitigation (`THREAT_MODEL.md`).

---

## 4. Protocol version

| Constant                             | Today                                      | v4                                                                                                     |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Round message `version`              | `ROUND_MSG_VERSION = 3` (`fusionRound.ts`) | **`4`**                                                                                                |
| Pool announce `FUSION_POOL_PROTOCOL` | `1`                                        | Keep `1` unless gather must filter v4-only peers; prefer capability in round start, not pool tag churn |
| Reject                               | v2 already rejected                        | **Reject v3 round messages** when local code is v4-only                                                |

Wire rule: any `version !== 4` → drop / fail closed for round messages.

---

## 5. EC component object (shared)

Use the same logical fields as Electron Cash / `pb::Component` in this repo:

### Input component

- prevout (wire txid order as EC)
- pubkey
- amount (sats)
- salt (32 bytes); `salt_commitment = sha256(salt)` on commitment path

### Output component

- scriptPubKey
- amount
- salt / salt_commitment as EC

### Blank component (parity target)

- zero amount component to pad to fixed `num_components` when tier requires it
- Required for full EC metadata parity; **padding follow-up** (not “fusion
  Phase 2”) if the first cut ships inputs+outputs only with an explicit residual

### InitialCommitment (attributed, control plane)

Per component, sorted as EC:

- `salted_component_hash = sha256(salt || component_ser)`
- `amount_commitment` (65-byte Pedersen uncompressed or EC encoding already used server-side)
- `communication_key` (compressed) — keep for EC server-path parity.
  Shipped P2P blame does **not** use abort openings.

### Blind message

```text
e_message = sha256(component_ser)   // NOT the v3 domain string
```

Issuer (coordinator) signs blinded challenges for one-shot nonce slots, same security rules as server: no slot reuse, CSPRNG nonces for blind (not RFC6979).

**F2 closed:** the only object that redeems is the component whose hash was signed; amount commitment is bound through EC’s commitment + component construction, not a parallel opaque token.

---

## 6. Round phases (v4)

```text
1. Gather + elect coordinator          [round key / public announce]
2. Round start (session, tier, fee, n) [control]
3. PlayerCommit-equivalent               [control, attributed]
     - initial_commitments (sorted)
     - excess_fee, pedersen_total_nonce
     - random_number_commitment
     - blind_sig_requests (one per component slot)
4. Credential response (blind s values)  [control]
5. Anonymous component redeem            [throwaway + Tor]
     - component_ser + unblinded blind sig (+ optional P2P serial/nullifier)
6. Outputs path
     - Preferred long-term: components redeemed anonymously; onion may wrap
       already-credentialed output components for shuffle
     - Must not re-introduce round-key signing of component bodies
7. Assemble tx from verified components  [same deterministic rules as peers]
8. Anonymous per-input signatures        [throwaway + Tor]
9. Final + Tor broadcast + reservation   [existing F1 rules]
10. Abort → no openings; optional `blame` for hard faults only [not a ban]
```

### Coordinator accept rules (component redeem)

Accept component **C** iff all hold:

1. `sha256(C)` has a valid unblinded blind signature under round issuer key.
2. **C** matches an issued commitment slot / commitment multiset rules (EC-consistent).
3. Outpoint / script uniqueness and nullifier (if used) not seen this session.
4. **Not** “sender round pubkey ∈ participants” for component messages.

Reject entire round (or refuse assembly) on missing/extra/duplicate/over-quota components.

---

## 7. Transport mapping (P2P-specific)

| EC server                             | P2P v4                                                 |
| ------------------------------------- | ------------------------------------------------------ |
| TLS/Tor to fusion server              | Nostr gift-wrap (NIP-44/59) + Tor SOCKS                |
| Covert TCP per component              | One-shot pool + throwaway signer per component message |
| Server sees IP (concurrency cap only) | No IP — no `ip_max_simul_fuse`                         |
| Covert domain/port from FusionBegin   | Relay URLs + local Tor                                 |

**Do not** “fix authorization” by requiring the final onion peeler’s round identity.

---

## 8. What v3 code is retired

| v3 artifact                                              | v4 fate                                              |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `outputCredentialMessageHash` / `optn-p2p-component-v3`  | Delete or dead-code after cutover; no dual support   |
| `inputCredentialMessageHash` string domain              | Replace with `sha256(input component_ser)`                              |
| Thin `{output, serial, credential}` as sole auth object | Replace with component + blind sig (+ serial if kept for P2P replay DB) |
| Accepting components via attributed path                | Already removed for inputs/sigs in `d9accdbd` — keep                    |

Keep for now if still useful as non-auth metadata: session id, tier, feerate on control messages.

---

## 9. Shipped implementation and maintenance

The v4 implementation described above is shipped in `dev`. The original phase
plan is retained here as historical context; it is not a pending rollout.

### Spec and shared encode/hash API

- [x] Design written
- [x] Reviewed in session
- [x] Native encode + `sha256(component)`: `src-tauri/src/fusion/p2p_component.rs`
- [x] Tauri command: `fusion_p2p_encode_component`
- [x] TS helpers + golden vector: `nostr/fusionComponentV4.ts` (+ tests)
- [x] Golden tests match `components.rs` Electron Cash protobuf wire vector

### Shipped behavior

- Issuance uses EC component blind messages (`buildComponentCredentialRequests`)
- Inputs redeem with `saltCommitments` + credential verify
- Outputs redeem with `saltCommitment` in onion payload
- `ROUND_MSG_VERSION = 4`; other versions rejected
- Credential request carries EC-style InitialCommitment:
  `sha256(salt || Component)` plus the Pedersen amount commitment
- Abort disclosures open the blind request, component salt, and Pedersen nonce
- Adversarial suite covers binding and honest-round completion

Remaining EC parity work, such as blank components for count-privacy parity, is
optional and does not change the shipped v4 authorization contract.

---

## 10. Blame and abort diagnosis

P2P blame is orthogonal to component authorization:

- Happy-path component messages remain anonymous; blame reports identify only the
  ephemeral round-control key when there is verifiable evidence.
- Proven cryptographic faults may be reported. Transport timeouts, missing
  signatures, and late joins remain ambiguous aborts and must not be treated as
  proof of misbehavior.
- Blame is diagnosis, not a durable ban or DoS mitigation.

---

## 11. Operational risks and safeguards

| Risk                                                  | Mitigation                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Larger implementation surface                         | Phased landings; sabotage tests each phase                          |
| Privacy regression if components sent under round key | Transport allowlist + isolation test + grouping regression test     |
| Fee/size mismatch vs EC                               | Reuse native fee formulas (`component_fee`, sizes)                  |
| Tor/relay load from full components                   | Already one socket per component; monitor soak                      |
| Protocol changes                                     | Bump the wire version only with a complete migration and test update |

The implementation has additional protocol surface, so keep the adversarial,
isolation, and golden-vector tests in the merge gate.

---

## 12. Acceptance criteria (production claim for this redesign)

1. P2P issues and verifies blind sigs only over `sha256(component_ser)`.
2. Happy path: no component body under round identity; isolation tests green.
3. Value conservation + unauthorized component injection tests green.
4. v3 messages rejected.
5. Server path still EC-aligned; shared vectors where possible.
6. Docs no longer describe F2 as an open soundness hole for P2P.
7. Chipnet multi-wallet soak notes recorded; CI green on PR tip.

---

## 13. Maintenance checklist

1. Keep `fusionIdentityIsolation.test.ts`, adversarial component tests, and
   golden vectors in the suite.
2. Update `ROUND_MSG_VERSION` only when a complete wire migration is ready;
   v4 clients must continue to reject v2/v3 round messages.
3. Keep the TypeScript and Rust component, credential, and transport references
   synchronized with this document and the protocol reference.

---

## 14. References in this repo

| Path                                               | Role                                          |
| -------------------------------------------------- | --------------------------------------------- |
| `src-tauri/src/fusion/components.rs`               | EC PlayerCommit / component build             |
| `src-tauri/src/fusion/schnorr.rs`                  | Blind issuer + modified RFC6979 tx sign       |
| `src-tauri/src/fusion/covert.rs`                   | Server covert isolation model                 |
| `src/platform/desktop/nostr/fusionTransport.ts`    | Anonymous component transport                 |
| `src/platform/desktop/nostr/fusionBlindSchnorr.ts` | Current TS blind issuer and v4 credential path |
| `src/platform/desktop/nostr/fusionSession.ts`      | Round choreography                            |
| `docs/THREAT_MODEL.md`                             | Blame ≠ DoS; throwaway keys                   |
| `docs/p2p-cashfusion-protocol.md`                  | Current v4 protocol reference                 |

---

**Maintenance rule:** do not introduce a partial protocol migration or sign v3
strings under a v4 version number.
