# P2P CashFusion Protocol — Exact Mechanism

This document describes **how OPTN Wallet’s peer-to-peer CashFusion works in
this repository**, as implemented today. It is the authoritative contributor
reference for the P2P path. It is **not** a marketing overview and **not** a
substitute for reading the source.

**Companion docs**

| Doc | Role |
|-----|------|
| [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md) | **Start here for naming** — Tor vs NIP-59 vs Pedersen vs blind Schnorr vs **output onion** (PR #12 committed stack) |
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Adversaries and what each can/cannot do |
| [cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md) | Server (classic) CashFusion Rust client scope |
| Source under `src/platform/desktop/nostr/` | Normative behaviour for P2P |

**Design goal (non-negotiable):** P2P is a **different transport**, not a weaker
protocol. Cryptography that server CashFusion uses (Pedersen commitments, blind
Schnorr credentials, Tor, **output-onion** unlinkability of outputs) must carry over.
There is **no dedicated fusion server** and **no extra infrastructure** beyond
public Nostr relays, Tor, and the Bitcoin Cash network (Chipnet in development).

> **Naming:** “Onion” in this doc means the **peer peel chain** (`onionCrypto.ts`),
> **not** Tor. See [privacy layers](./p2p-cashfusion-privacy-layers.md).

---

## 1. Code map (where truth lives)

| Concern | Primary files |
|---------|----------------|
| Pool discovery & group selection | `src/platform/desktop/nostr/fusion.ts` |
| Coordinator election | `fusion.ts` → `electCoordinator` |
| Rendezvous (proposal / ack / start) | `fusionRendezvous.ts` |
| Round choreography (credentials → inputs → assemble → sign → final) | `fusionSession.ts` |
| Canonical tx assembly & signing safety | `fusionRound.ts`, `fusionSign.ts` |
| NIP-59 gift-wrap transport | `fusionTransport.ts` |
| Output onion (peer peel + shuffle) | `onionCrypto.ts` |
| Blind Schnorr issuer + requester (TS) | `fusionBlindSchnorr.ts` |
| Pedersen commits (TS) | `fusionPedersen.ts` |
| Rust issuer (server path parity + unit tests) | `src-tauri/src/fusion/schnorr.rs` → `BlindIssuer` |
| Rust server-fusion round (classic path) | `src-tauri/src/fusion/{run,components,pedersen,covert}.rs` |
| Service wiring (UI / auto-fusion) | `src/platform/desktop/FusionP2pService.ts` |

Protocol message version: **`ROUND_MSG_VERSION = 2`**
(`fusionRound.ts`). Messages with any other `version` are rejected.

---

## 2. High-level picture

```
┌─────────────┐     public Nostr      ┌─────────────┐
│  Peer A     │◄── kind 12230 pool ──►│  Peer B     │
│ (ephemeral  │     announcements     │ (ephemeral  │
│  identity)  │                       │  identity)  │
└──────┬──────┘                       └──────┬──────┘
       │  NIP-59 gift-wrap (kind 1059)       │
       │  to ephemeral round pubkeys         │
       └──────────────┬──────────────────────┘
                      │
              elected coordinator
              is also the blind-
              Schnorr *issuer*
                      │
                      ▼
              assembled CoinJoin
              → each peer signs own inputs
              → broadcast (any peer may)
                      │
                      ▼
                 BCH network
```

**Roles**

1. **Peer** — a wallet instance that joined the pool with a fresh secp256k1
   identity for this attempt only (not the long-term chat/wallet Nostr key).
2. **Coordinator** — one peer, elected deterministically from the participant
   set. Responsibilities:
   - Publish blind-issuer parameters (`credential_params`)
   - Answer blind challenges (`credential_response`) after Pedersen checks
   - Collect credentialed inputs and outputs
   - Assemble the CoinJoin template and distribute it
   - Collect input signatures and produce the final tx
   - Attempt broadcast (others also broadcast for liveness)
3. **Issuer** — the **same process** as the coordinator for that round. There is
   no separate credential server. The issuer holds a one-shot nonce pool;
   reusing a nonce would leak the round private key.

The coordinator **never receives other peers’ private keys**. Every peer
independently verifies the assembled template (`verifyFusionSafety` + BCH VM)
before signing **only its own inputs**.

---

## 3. Identities and transport

### 3.1 Ephemeral round identity

- Generated with `generateRoundIdentity()` / `generateSecretKey()` per fusion
  **attempt**.
- Pool announcements and round gift-wraps are signed / addressed under this key.
- Chat (NIP-06 wallet identity) uses a **different** pubkey; subscriptions do
  not overlap.

### 3.2 Pool announcement (public, replaceable)

| Constant | Value | Meaning |
|----------|-------|---------|
| `POOL_ANNOUNCE_KIND` | **12230** | NIP-01 **replaceable** kind (10000–19999) |
| `FUSION_POOL_PROTOCOL` | **1** | Content protocol number |
| `POOL_PEER_TTL_SECONDS` | **30** | Freshness window for announcements |
| Tag `t` | `optn-fusion-v1-{network}` | Network-scoped pool |

**Why replaceable 12230, not ephemeral 22230 (00-Wallet style):**  
Ephemeral kinds are not stored/replayed by relays. A peer that connects over Tor
*after* others announced would never see them. Replaceable + `since` lets late
joiners discover the rolling pool.

Announcement content (JSON) includes: `protocol`, `network`, `epoch`
(informational), `tiers[]`, `numInputs`, `expiresAt`.

### 3.3 Round messages (private, gift-wrap)

| Constant | Value |
|----------|-------|
| Wire kind | **1059** (NIP-59 gift-wrap — same as DMs) |
| Addressing | `#p` = recipient’s **ephemeral round** pubkey |

Layers: outer 1059 (random author + scrambled time) → seal → rumor JSON
(`RoundMessage`). On the wire, fusion traffic looks like ordinary private DMs;
disambiguation is by **who** is addressed, not a custom kind.

**Output registration** uses a **throwaway** sealing key (and, in production, a
fresh Tor circuit) so the coordinator cannot trivially link “this output event”
to the round identity that registered inputs.

---

## 4. Gathering and coordinator election

### 4.1 Group size

| Constant | Value | File |
|----------|-------|------|
| `MAX_PARTICIPANTS` | **6** | `fusion.ts` (and rendezvous) |
| `MIN_PARTICIPANTS` | **2** | `fusion.ts` |
| `GATHER_TIMEOUT_MS` | **30_000** | declared; gathering is driven by rendezvous timeouts in practice |
| `CREDENTIAL_SLOTS_PER_PEER` | **16** | `fusionBlindSchnorr.ts` |

### 4.2 Compatible tier selection

`selectFusionGroup(announcements, min, max)`:

1. Prefer the tier with the **largest** compatible set.
2. On a tie, prefer the **larger** tier amount.
3. Cap by `maxParticipants` and a component budget
   (`numInputs + MAX_OUTPUTS_PER_PEER` per peer ≤ `MAX_TOTAL_COMPONENTS`).

### 4.3 Election (set-bound, not grindable offline alone)

```
commitment = sort(unique pubkeys).join('|')
ticket(candidate) = FNV-1a style hash of `${commitment}#${candidate}`
winner = argmin(ticket), tie-break on pubkey string
```

Implemented in `electCoordinator`. Because the ticket is bound to the **full
set**, a peer cannot pick a key offline that always wins without knowing who
else will join. (This replaced an earlier “lowest pubkey” rule that was
grindable and desynced tests.)

### 4.4 Rendezvous messages

Before the credential round, peers run proposal/ack/start
(`fusionRendezvous.ts`):

| Type | Who | Purpose |
|------|-----|---------|
| `round_proposal` | Would-be coordinator | Offers `session`, `network`, `tier`, `epoch`, `participants[]` |
| `round_ack` | Peer | Accepts that proposal |
| `round_start` | Coordinator | Locks the set; everyone proceeds to `runFusionRound` |
| `abort` | Anyone | Ends the attempt with a reason |

Every message carries **message binding**: `version`, random 16-byte `nonce`
(hex), `timestamp` (reject if age &gt; 300s or skew &gt; 30s). Nonces are
tracked per peer to resist replay within a session.

---

## 5. Round phases (protocol v2) — exact order

Source of truth: `runFusionRound` → `runCoordinator` / `runParticipant` in
`fusionSession.ts`.

### Phase A — Credential parameters (coordinator = issuer)

1. Coordinator creates `BlindIssuer.create(participants.length * 16)`.
2. Self-issues credentials for **its own** inputs (same crypto path).
3. Self-checks Pedersen balance for its contribution.
4. Sends every other peer:

```json
{
  "type": "credential_params",
  "session": "...",
  "version": 2,
  "nonce": "<32 hex chars>",
  "timestamp": 0,
  "roundPubkey": "<33-byte compressed P = x·G, hex>",
  "blindNoncePoints": ["<R_i = k_i·G compressed hex>", "..."]
}
```

Slot layout: peers sorted lexicographically by pubkey; peer at sorted index
`i` owns slots `[i*16, i*16 + 16)`.

### Phase B — Credential request (every non-coordinator peer)

Each peer:

1. Builds **Pedersen** commitments for every input and output component
   (signed amounts: input `+value − fee`, output `−(value + fee)`), using
   Electron Cash size/fee formulas shared with `fusionRound.ts`.
2. For each **input**, builds a `BlindSignatureRequest` over:

```
msg = SHA256( UTF-8(
  "optn-p2p-input-v1|{prevTxid}|{prevIndex}|{value}|{pubkey}"
) )
```

(all hex fields lowercased in the payload).

3. Sends:

```json
{
  "type": "credential_request",
  "session": "...",
  "version": 2,
  "nonce": "...",
  "timestamp": 0,
  "requests": [{ "index": 0, "e": "<32-byte blinded challenge hex>" }],
  "amountCommitments": ["04… 65-byte uncompressed points"],
  "pedersenTotalNonce": "<32-byte hex Σ nonces>",
  "excessFee": 1234
}
```

### Phase C — Issuer response

Coordinator, for each `credential_request`:

1. Rejects duplicate requests from the same peer.
2. Verifies Pedersen:  
   `Σ amount_commitments == excess_fee · H + total_nonce · G`  
   with CashFusion H = compressed  
   `0x02 || "CashFusion gives us fungibility."`
3. Ensures each `index` lies in **that peer’s** reserved slot range.
4. For each request, `s = k_index + e·x`, then **destroys** `k_index`
   (second use → hard error — classic Schnorr nonce-reuse leak).
5. Replies:

```json
{
  "type": "credential_response",
  "session": "...",
  "responses": [{ "index": 0, "s": "<32-byte hex>" }]
}
```

Peer unblinds to a 64-byte BCH Schnorr signature `(R'.x || s')` and verifies it
under `roundPubkey` over the input message hash before continuing.

### Phase D — Component submission

**Inputs** (per component, with jitter 200–2000 ms by default):

```json
{
  "type": "inputs",
  "session": "...",
  "inputs": [{
    "prevTxid": "...",
    "prevIndex": 0,
    "value": 100000,
    "pubkey": "02…"
  }],
  "credentialSigs": ["<64-byte unblinded credential hex>"]
}
```

Coordinator **refuses** any input whose credential does not verify under the
round pubkey for that input’s domain-separated hash. Assembly cannot proceed
until every accepted input is in the credentialed set.

**Outputs**

- **Direct mode** (`onionEnabled !== true`): `outputs` messages to the
  coordinator (plaintext contribution list).
- **Onion mode** (`onionEnabled === true`, production default in
  `FusionP2pService`): each output is onion-wrapped through
  `mixOrder = sort(participants \ {coordinator})` (coordinator **assembles**,
  does **not** peel). Each hop peels one ECDH+AES-GCM layer, **CSPRNG**
  Fisher–Yates shuffles the batch, and forwards. Last peeler reveals plaintext
  outputs only to the coordinator.

Onion crypto: `onionCrypto.ts` (00-Wallet-compatible pad size 80, tiny-secp256k1
ECDH). Failure is **loud** — no silent fallback to plaintext.

**Ready signal:** `components_ready` from each peer.

### Phase E — Assemble, verify, sign

1. Coordinator flattens all inputs + output pool → `assembleFusionTx`
   (BIP69-style sort of inputs/outputs; rejects duplicate outpoints).
2. Sends `assembled` with full input/output lists to every peer.
3. Every peer runs `verifyFusionSafety` (own outputs present, fee bounds, etc.)
   then `signMyInputs` (SIGHASH_ALL|FORKID) **only for own keys**.
4. Peers return `signature` sets; coordinator checks the outpoint set matches
   that peer’s registered inputs, merges sigs, runs full BCH VM verification
   before broadcast.

### Phase F — Final and broadcast liveness

1. Coordinator broadcasts, then sends `final { txid, txHex }`.
2. Each peer verifies `final` against the template it signed.
3. Peers **also** broadcast after a random 2–8 s jitter so a dead coordinator
   connection cannot strand a fully signed CoinJoin.

---

## 6. Cryptography (exact)

### 6.1 BCH Schnorr (non-blind)

- Signature: 64 bytes = `R.x (32) || s (32)`.
- Challenge: `e = SHA256(R.x || compressed(P) || msg32) mod n`.
- Verify: reconstruct `R = s·G − e·P`, require `jacobi(R.y) = +1` and matching
  `R.x`.

### 6.2 Blind Schnorr (CashFusion / Electron Cash scheme)

Issuer holds `x`, publishes `P = x·G`, and for each slot `R = k·G`.

Requester:

```
a,b ← random
R' = ±(R + a·G + b·P)   // sign chosen so jacobi(R'.y)=+1
e' = SHA256(R'.x || compressed(P) || m)
e  = ±e' + b            // sent to issuer (blinded)
```

Issuer: `s = k + e·x` (then discard `k`).

Requester unblinds: `s' = ±(s + a)`; signature is `R'.x || s'`.

Issuer never sees `(R'.x, s')`, so it cannot link the request to the final
credential by value. **Nonce reuse across two different `e` values leaks `x`.**
Implementation enforces one-shot slots in both TS and Rust.

### 6.3 Pedersen

```
H = decompress( 0x02 || "CashFusion gives us fungibility." )
C = amount·H + nonce·G   // amount is signed (i64 as scalar)
```

Wire form: **65-byte uncompressed** point. Balance check uses the additive
homomorphism so the issuer/coordinator never needs individual amounts to verify
the peer’s declared excess fee.

### 6.4 What credentials do *not* do

- They do **not** hide the input→output map from the **coordinator** (same trust
  model as a classic fusion server that sees the final template).
- **Output onion** (not Tor) is what prevents *peers and intermediate peel hops*
  from linking which participant contributed which **output**. Full stack:
  [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md).
- Input ownership for spending is still ordinary BCH signatures at sign time;
  credentials authorize inclusion in **this round’s** CoinJoin under the round
  issuer key.

---

## 7. Message catalogue (v2)

All messages include binding fields: `version`, `nonce`, `timestamp`, and
usually `session`.

| `type` | Direction | Required fields (beyond binding) |
|--------|-----------|----------------------------------|
| `round_proposal` | → peers | `network`, `tier`, `epoch`, `participants` |
| `round_ack` | → coordinator | `network`, `tier`, `epoch` |
| `round_start` | → peers | `network`, `tier`, `epoch`, `participants` |
| `credential_params` | coordinator → peers | `roundPubkey`, `blindNoncePoints[]` |
| `credential_request` | peer → coordinator | `requests[]`, `amountCommitments[]`, `pedersenTotalNonce`, `excessFee` |
| `credential_response` | coordinator → peer | `responses[]` |
| `inputs` | peer → coordinator | `inputs[]`, `credentialSigs[]` (parallel, required) |
| `outputs` | peer → coordinator | `outputs[]` |
| `onion_output` | peer → next peeler | `onion` (base64), `mixOrder[]` |
| `components_ready` | peer → coordinator | (session only) |
| `assembled` | coordinator → peers | `inputs[]`, `outputs[]` |
| `signature` | peer → coordinator | `sigs[]` (`prevTxid`, `prevIndex`, `unlockingBytecode`) |
| `final` | coordinator → peers | `txid`, `txHex` |
| `abort` | any | `reason` (≤240 chars) |

Parsing is strict (`parseRoundMessage`): size caps, hex shapes, participant
sets, money bounds. Invalid messages surface as protocol errors.

---

## 8. Comparison: server CashFusion vs P2P

| Property | Server path (`src-tauri/src/fusion`) | P2P path (`nostr/*`) |
|----------|-------------------------------------|----------------------|
| Discovery | TCP fusion server / pool tags | Nostr replaceable announcements |
| Transport | Protobuf frames over TCP(+TLS)+Tor | NIP-59 gift-wrap over Nostr (+Tor) |
| Issuer | Dedicated fusion server | Elected peer coordinator |
| Pedersen | Full component model + blame | Per-peer commit at credential time |
| Blind Schnorr | Server signs; client requester in Rust | Coordinator `BlindIssuer`; TS requester |
| Covert / output privacy | Separate Tor circuits per component | Per-component jitter + **output onion** for outputs |
| Blame protocol | Full EC-style blame proofs | Not ported; abort + drop bad peer |
| Assembly trust | Server proposes; client checks | Coordinator proposes; **every** peer checks |
| Broadcast | Client/server paths | Coordinator + peer liveness broadcast |
| Network | Chipnet for tests; never mainnet in CI | Same rule |

P2P intentionally **does not** require running or trusting a long-lived fusion
daemon. It **does** require at least one honest **output-onion** peel hop for
peer-level output unlinkability when `onionEnabled` is on, and treats the
coordinator like a classic server for template visibility. Output onion needs
**no extra servers** — only the peers already in the round.

---

## 9. Safety gates (must not be weakened)

1. **Zero-touch upstream:** P2P lives under `src/platform/desktop/**` (and
   related desktop wiring). Do not “fix” by editing `src/services/*` upstream
   sources.
2. **Chipnet only in automated tests** — no mainnet fusion fixtures.
3. **Never log mnemonics / private keys / seed material.**
4. **Locked wallet is actually locked** — do not suppress auto-lock while a
   round runs (reverted design).
5. **CashToken coins are not fused** (`FusionRunnerService` / token filter).
6. **Unconfirmed coins** may fuse (BCH 0-conf policy; documented divergence from
   EC’s hard exclude).
7. **Output onion on failure fails the round** — no silent plaintext downgrade
   (not a Tor setting; see privacy-layers doc).
8. **Issuer nonce one-shot** — never “retry sign” on the same slot.

---

## 10. Testing the mechanism

| Suite | What it proves |
|-------|----------------|
| `nostr/__tests__/fusionBlindSchnorr.test.ts` | Blind round-trip, nonce reuse refusal, Pedersen balance |
| `nostr/__tests__/fusionSession.test.ts` | Multi-peer in-memory CoinJoin + onion + credential path |
| `nostr/__tests__/fusionRendezvous.test.ts` | Election / proposal convergence |
| `nostr/__tests__/fusionSign.test.ts` | Wire byte-order / signing invariants |
| `cargo test` `fusion::schnorr` | Rust `BlindIssuer` + requester parity |
| Chipnet live rounds | On-chain CoinJoin (manual / env-gated; not assumed green in CI) |

In-memory multi-peer success proves the **state machine and crypto wiring**.
It does **not** by itself replace a chipnet confirmation of the full stack
(relays + Tor + Electrum broadcast).

---

## 11. Glossary

| Term | Meaning here |
|------|----------------|
| **Credential** | Unblinded BCH Schnorr signature under the **round** issuer key over an input’s domain-separated hash |
| **Issuer** | Holder of `x` and one-shot `k_i`; the elected coordinator |
| **Coordinator** | Peer that issues credentials and assembles the tx template |
| **Component** | One input, output, or (server path) blank slot in a fusion round |
| **Tier** | Target fused coin denomination (sats) peers advertise compatibility with |
| **Mix order** | Ordered list of peelers for **output onion**; excludes coordinator |
| **Output onion** | ECDH+AES-GCM peel/shuffle among peers (`onionCrypto.ts`) — **not Tor** |
| **Tor transport** | SOCKS path for Nostr sockets — network IP privacy |
| **NIP-59 gift-wrap** | Relay-facing encryption of round messages |
| **Session** | Round id string bound into every message for that attempt |

Privacy layer roles (Tor / gift-wrap / Pedersen / blind Schnorr / output onion):
[p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md).

---

## 12. Change control

When you change the wire format or crypto:

1. Bump `ROUND_MSG_VERSION` if old clients must not parse new messages.
2. Update **this document** in the same PR.
3. Add or extend sabotage-style tests (break the invariant → that test fails).
4. Keep Electron Cash / 00-Wallet references honest: cite files, do not invent
   “EC does X” without reading their tree under `D:\OPTN wallet work\electron-cash`
   or the vendored protocol notes.

---

*Last updated to match protocol v2 (blind credential phase + Pedersen gate on
the coordinator issuer path).*
