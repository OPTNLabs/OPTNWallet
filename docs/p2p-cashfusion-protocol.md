# P2P CashFusion Protocol — Comprehensive Reference

**Status:** **Implemented and under production hardening** for PR #12 desktop
(not a marketing “production shipped” claim until Chipnet soak + remaining
v4/EC gates in `docs/p2p-ec-component-plane-v4.md` / `CLAUDE-A-TO-Z.md`).
This document describes **how OPTN Wallet’s peer-to-peer CashFusion works in
this repository**. It is the authoritative contributor and audit-oriented
reference for the P2P path: wire format, phases, wallet outer loop, Auto
behaviour, and safety gates.

**Companion docs**

| Doc                                                                        | Role                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md)     | Naming map: Tor vs NIP-59 vs Pedersen vs blind Schnorr vs **output onion** |
| [THREAT_MODEL.md](./THREAT_MODEL.md)                                       | Adversaries and what each can/cannot do                                    |
| [cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md) | Ship status — **both** P2P and classic server paths **done**               |
| Source under `src/platform/desktop/nostr/` + `FusionP2pService.ts`         | Normative behaviour                                                        |

**Design goal (non-negotiable, and met in code):** P2P is a **different
transport**, not a weaker protocol. Cryptography that server CashFusion uses
(Pedersen commitments, blind Schnorr credentials, Tor, **output-onion**
unlinkability of outputs) carries over. There is **no dedicated fusion server**
and **no extra infrastructure** beyond public Nostr relays, Tor, and the
Bitcoin Cash network (Chipnet for development dogfood).

> **Naming:** “Onion” in this doc means the **peer peel chain**
> (`onionCrypto.ts`), **not** Tor. See
> [privacy layers](./p2p-cashfusion-privacy-layers.md).

---

## 1. Code map (where truth lives)

| Concern                                                            | Primary files                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Pool discovery, live filter, group selection                       | `src/platform/desktop/nostr/fusion.ts`                                              |
| Coordinator election                                               | `fusion.ts` → `electCoordinator`                                                    |
| Rendezvous (proposal / full-set ACK / start)                       | `fusionRendezvous.ts`                                                               |
| Round choreography (credentials → onion → assemble → sign → final) | `fusionSession.ts`                                                                  |
| Canonical tx assembly & pre-sign safety                            | `fusionRound.ts`, `fusionSign.ts`                                                   |
| NIP-59 gift-wrap transport                                         | `fusionTransport.ts`                                                                |
| Output onion (peer peel + shuffle)                                 | `onionCrypto.ts`                                                                    |
| Blind Schnorr issuer + requester (TS)                              | `fusionBlindSchnorr.ts`                                                             |
| Pedersen commits (TS)                                              | `fusionPedersen.ts`                                                                 |
| Phase budgets / server parity timing                               | `fusionTiming.ts`                                                                   |
| Auto policy (cooldown, rendezvous tick)                            | `fusionAutoEngine.ts`                                                               |
| Per-coin fuse depth (rounds-per-coin)                              | `fusionCoinDepth.ts`, `FusionCompletionService.ts`                                  |
| Cross-window lease + Auto cooldown stamp                           | `fusionWalletLease.ts`                                                              |
| Outer runner (manual + Auto; same path)                            | `FusionRunnerService.ts`                                                            |
| Wallet / Tor / gather / completion                                 | `FusionP2pService.ts`                                                               |
| Auto clock + UTXO wake                                             | `useAutoFusion.ts`                                                                  |
| UI (P2P panel, Auto controls)                                      | `P2pFusionTransportPreview.tsx`, `AutoFusionControls.tsx`, `CashFusionSettings.tsx` |

Protocol message version: **`ROUND_MSG_VERSION = 4`** (`fusionRound.ts`).
Version 4 is incompatible with v3/v2 and rejects other versions.

**v4 credential binding (Electron Cash F2):** blind-sign
`sha256(serialized EC Component)` with a per-component `salt_commitment`
(see `fusionComponentV4.ts`, `docs/p2p-ec-component-plane-v4.md`). Inputs
carry `saltCommitments[]` next to credentials; outputs carry
`saltCommitment` inside the onion payload. Serial remains a separate
nullifier. Unlinkability stays on throwaway Nostr + Tor, not on stripping
commitments.

---

## 2. High-level picture

```
┌─────────────┐     public Nostr      ┌─────────────┐
│  Peer A     │◄── kind 12230 pool ──►│  Peer B     │
│ (ephemeral  │     announcements     │ (ephemeral  │
│  identity)  │   (+ local BC stress) │  identity)  │
└──────┬──────┘                       └──────┬──────┘
       │  NIP-59 gift-wrap (kind 1059)       │
       │  to ephemeral round pubkeys         │
       └──────────────┬──────────────────────┘
                      │
              elected coordinator
              = blind-Schnorr issuer
                      │
         credentials → onion outputs
         → assemble → sign own inputs
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
   - Publish blind-issuer parameters (`credential_params`), re-sending until
     peers request credentials (Tor gift-wrap drops are common)
   - Answer blind challenges (`credential_response`) after Pedersen checks
   - Collect credentialed inputs and onion-revealed outputs
   - Assemble the CoinJoin template and distribute it
   - Collect input signatures and produce the final tx
   - Attempt broadcast (others also broadcast for liveness)
3. **Issuer** — the **same process** as the coordinator for that round. There is
   no separate credential server. The issuer holds a one-shot nonce pool;
   reusing a nonce would leak the round private key.

The coordinator **never receives other peers’ private keys**. Every peer
independently verifies the assembled template (`verifyFusionSafety` + BCH VM)
before signing **only its own inputs**.

Server-based CashFusion and P2P share the **wallet outer loop** (manual/Auto
start, live UTXO refresh, fuse depth, cooldown, cross-window lease) via
`FusionRunnerService`. They do **not** share the on-wire protocol.

---

## 3. Identities and transport

### 3.1 Ephemeral round identity

- Generated per fusion **attempt** (`generateRoundIdentity` / `generateSecretKey`).
- Pool announcements and round gift-wraps are signed / addressed under this key.
- Chat (NIP-06 wallet identity) uses a **different** pubkey; subscriptions do
  not overlap.
- Abandoned keys are **retired** so a later gather cannot treat your own
  previous Start as a peer (ghost overcount).

### 3.2 Pool announcement (public, replaceable)

| Constant                   | Value                      | Meaning                                   |
| -------------------------- | -------------------------- | ----------------------------------------- |
| `POOL_ANNOUNCE_KIND`       | **12230**                  | NIP-01 **replaceable** kind (10000–19999) |
| `FUSION_POOL_PROTOCOL`     | **1**                      | Content protocol number                   |
| `POOL_PEER_TTL_SECONDS`    | **180**                    | Announcement expiry window                |
| `POOL_REANNOUNCE_SECONDS`  | ~refresh interval          | Live peers re-sign `created_at`           |
| `POOL_LIVE_ACTIVE_SECONDS` | **24**                     | Soft “last heard” window                  |
| Tag `t`                    | `optn-fusion-v1-{network}` | Network-scoped pool                       |

**Why replaceable 12230:** Ephemeral kinds are not stored/replayed. Late Tor
joiners would never see earlier announces. Replaceable + `since` + re-announce
keeps a rolling pool.

Announcement content (JSON) includes: `protocol`, `network`, `epoch`, `tiers[]`,
`numInputs`, `expiresAt`. Withdrawal publishes an already-expired announcement.

**Same-origin multi-window stress:** a `BroadcastChannel` may mirror pool events
locally. Production discovery remains Nostr over Tor.

### 3.3 Soft vs strict live peers

Gather maintains two views (`FusionP2pService.collectRolling`):

| View       | Rule                                                  | Use                               |
| ---------- | ----------------------------------------------------- | --------------------------------- |
| **Soft**   | Live filter without lock-strict `created_at`          | Approximate count / “expect more” |
| **Strict** | Must re-publish during **this** gather (`lockStrict`) | Lock / propose set                |

Ghosts (own retired keys, blamed session keys, stale announces) are dropped.
Status logs look like: `strict=3 soft=4 peak=3/4` (counts only — no pubkeys).

### 3.4 Round messages (private, gift-wrap)

| Constant   | Value                                                |
| ---------- | ---------------------------------------------------- |
| Wire kind  | **1059** (NIP-59 gift-wrap — same outer kind as DMs) |
| Addressing | `#p` = recipient’s **ephemeral round** pubkey        |

Layers: outer 1059 (random author + scrambled time) → seal → rumor JSON
(`RoundMessage`). On the wire, fusion traffic looks like ordinary private DMs;
disambiguation is by **who** is addressed, not a custom kind.

Every message carries **message binding**: `version`, random `nonce` (hex),
`timestamp` (reject if age &gt; 300s or skew &gt; 30s). Nonces are tracked per
peer to resist replay within a session.

---

## 4. Gathering and group selection

### 4.1 Group size

| Constant                    | Value  | Meaning                                  |
| --------------------------- | ------ | ---------------------------------------- |
| `MIN_PARTICIPANTS`          | **3**  | Anonymity floor + onion needs ≥2 peelers |
| `MAX_PARTICIPANTS`          | **6**  | Cap per round                            |
| `CREDENTIAL_SLOTS_PER_PEER` | **16** | Max inputs per peer per round            |

There is **no rule that excludes a fourth wallet**. Gather may **lock at 3**
once the set is stable so rounds do not wait forever for a late peer. If four
(or more, up to 6) are present **before** lock, the round includes them. Live
multi-window stress often produces 3-ways because Auto cooldowns stagger entry
(~40s after success); 4-ways happen when all four overlap in gather.

### 4.2 Gather budgets (`fusionTiming.ts`)

| Constant                    | Value                  | Role                                           |
| --------------------------- | ---------------------- | ---------------------------------------------- |
| `P2P_GATHER_MAX_MS`         | **120s** (`JOIN_WAIT`) | Max discover when peers seen                   |
| `P2P_GATHER_ALONE_MS`       | **35s**                | Manual alone abort                             |
| `P2P_GATHER_ALONE_AUTO_MS`  | **120s**               | Auto alone wait for peers                      |
| `P2P_GATHER_MIN_MS`         | **10s**                | Min gather before locking a partial set (3…5)  |
| `P2P_GATHER_FAST_WARMUP_MS` | **5s**                 | Warm-up when already at MAX                    |
| `P2P_SMALL_SET_HOLD_MS`     | **20s**                | Extra hold after MIN to allow more peers       |
| `P2P_PEER_SET_STABLE_MS`    | **4s**                 | Membership must be stable before lock          |
| `P2P_PEAK_GRACE_MS`         | **15s**                | Grace after peak drops before accepting shrink |

**Lock policy (summary):**

- `n < 3`: never lock; wait or fail alone budget.
- `3 ≤ n < 6`: after min gather + stable + short hold (unless soft/strict still
  disagree or peak not met), **lock partial set**.
- `n ≥ 6`: fast lock after short warm-up + short stable.

### 4.3 Compatible tier selection

`selectFusionGroup(announcements, min, max)`:

1. Prefer the tier with the **largest** compatible set.
2. On a tie, prefer the **larger** tier amount.
3. Cap by `maxParticipants` and a component budget
   (`numInputs + MAX_OUTPUTS_PER_PEER` per peer ≤ `MAX_TOTAL_COMPONENTS`).

### 4.4 Election (set-bound)

```
commitment = sort(unique pubkeys).join('|')
ticket(candidate) = hash of `${commitment}#${candidate}`
winner = argmin(ticket), tie-break on pubkey string
```

Implemented in `electCoordinator`. Bound to the **full set**, so a peer cannot
pick a key offline that always wins without knowing who else will join.

### 4.5 Rendezvous messages (full-set ACK)

| Type             | Who                  | Purpose                                                        |
| ---------------- | -------------------- | -------------------------------------------------------------- |
| `round_proposal` | Would-be coordinator | Offers `session`, `network`, `tier`, `epoch`, `participants[]` |
| `round_ack`      | Every proposed peer  | Accepts that proposal                                          |
| `round_start`    | Coordinator          | Locks the set; everyone proceeds to `runFusionRound`           |
| `abort`          | Anyone               | Ends the attempt with a reason                                 |

**Full-set ACK:** the round **must not start** until every proposed participant
ACKs (or the proposal times out). Partial ACK must **not** fuse a 2-of-4 subset
and leave others stranded. Timeouts:

| Constant                   | Value                      |
| -------------------------- | -------------------------- |
| `P2P_RENDEZVOUS_MS`        | **60s**                    |
| `P2P_PROPOSAL_TIMEOUT_MS`  | **20s**                    |
| `P2P_RENDEZVOUS_RESEND_MS` | **1.2s** re-offer / re-ACK |

---

## 5. Round phases (protocol v3) — exact order

Source of truth: `runFusionRound` → `runCoordinator` / `runParticipant` in
`fusionSession.ts`.

### Phase budgets (active round body)

| Constant                           | Value         | Role                                              |
| ---------------------------------- | ------------- | ------------------------------------------------- |
| `P2P_ROUND_TIMEOUT_MS`             | **80s**       | Overall active-round ceiling (server blame close) |
| `P2P_CREDENTIAL_WAIT_MS`           | **35s**       | Wait for `credential_params` / response over Tor  |
| `P2P_CREDENTIAL_PARAMS_RESEND_MS`  | **1.5s**      | Coordinator re-sends params to lagging peers      |
| `P2P_CREDENTIAL_PARAMS_RESEND_MAX` | **12**        | Cap resends                                       |
| `P2P_MISSING_OUTPUTS_ONION_MS`     | **28s**       | Onion / missing outputs                           |
| `P2P_COMPONENT_JITTER_MS`          | **30–250 ms** | Per-component send jitter                         |
| Onion declare / output resends     | bounded       | Tor drop recovery without open-ended spam         |
| `P2P_SIG_RESEND_MS`                | **1.5s**      | Signature re-send                                 |

### Phase A — Credential parameters (coordinator = issuer)

1. Coordinator creates `BlindIssuer.create(participants.length * 16)`.
2. Self-issues credentials for **its own** inputs (same crypto path).
3. Self-checks Pedersen balance for its contribution.
4. Sends every other peer `credential_params` (`roundPubkey`,
   `blindNoncePoints[]`), and **re-sends** to peers that have not yet
   requested credentials (Tor gift-wrap often drops the first delivery).

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

3. Sends `credential_request` with blinded challenges + Pedersen fields.

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
5. Replies `credential_response`.

Peer unblinds to a 64-byte BCH Schnorr signature and verifies it under
`roundPubkey` over the input message hash before continuing.

### Phase D — Component submission

**Inputs** (with credential sigs, jittered):

Coordinator **refuses** any input whose credential does not verify under the
round pubkey. Assembly cannot proceed until every accepted input is credentialed.

**Outputs (onion only — no direct/2-party path)**

Every output is onion-wrapped through  
`mixOrder = sort(participants \ {coordinator})`  
(coordinator **assembles**, does **not** peel). Each hop peels one ECDH+AES-GCM
layer, **CSPRNG** Fisher–Yates shuffles the batch, and forwards. Last peeler
reveals plaintext outputs only to the coordinator. Rounds require ≥3 peers so
there are always ≥2 peelers.

Supporting messages: `onion_declare` (output counts), `onion_output` (blobs),
`components_ready`.

Before wrapping, each output is encoded with a fresh 32-byte serial and a
64-byte blind Schnorr credential. The credential message commits to the
network, session, tier, component role (`output`), canonical script/value, and
serial. Every layer carries the same fixed 384-byte plaintext block, so the
credential does not introduce output-size fingerprints. The final peeler stays
anonymous: it reveals authorizable outputs, not its round identity.

The coordinator issues exactly the declared input/output credential quota only
after the peer's Pedersen balance proof succeeds. Before assembly it verifies
every output credential, requires the exact aggregate output count, and
atomically records the serial nullifiers. Replays remain rejected across an
active-round retry or reload; nullifiers clear only when that round succeeds or
conclusively aborts. Failure is **loud** — no silent fallback to plaintext.

**Transport isolation per anonymous component.** Sealing each output under a
fresh throwaway key defeats the *coordinator*, not the *relay*: if every output
of a round leaves over one shared socket, the relay groups them by connection
and the fresh keys buy nothing against that observer. Each anonymous component
(`outputs`, `onion_output`) therefore publishes on its own short-lived pool,
closed immediately after (`createComponentPool`, `nostr/fusionTransport.ts`).
The Tor WebSocket implementation is installed globally, so one pool means one
connection and one circuit with its own SOCKS isolation token — the same
property Electron Cash obtains from a separate covert connection per component.
Subscriptions keep the persistent pools; only publishing is one-shot.

Scope, stated plainly: this covers **outputs**. Input registration and the later
signature messages still travel under the peer's round identity, so a
coordinator learns which inputs share a participant. That is deliberate, not an
oversight — every code in `nostr/fusionBlame.ts` binds to an `accused`
participant pubkey and `verifyBlameReport` rejects an accused outside the
participant set, so anonymising those channels removes the input blame is built
on and requires the EC covert-component blame model. Tracked as a residual.

### Phase E — Assemble, verify, sign

1. Coordinator flattens all inputs + output pool → `assembleFusionTx`
   (BIP69-style sort; rejects duplicate outpoints / bad fees).
2. Sends `assembled` with full input/output lists to every peer.
3. Every peer runs `verifyFusionSafety` (own outputs present, fee bounds, etc.)
   then `signMyInputs` (SIGHASH_ALL|FORKID = `0x41`) **only for own keys**.
4. Peers return `signature` sets; coordinator checks the outpoint set, merges
   sigs, runs full BCH VM verification before broadcast.

### Phase F — Final and broadcast liveness

1. Coordinator broadcasts, then sends `final { txid, txHex }`.
2. Each peer verifies `final` against the template it signed.
3. Peers **also** broadcast after a random 2–8 s jitter so a dead coordinator
   connection cannot strand a fully signed CoinJoin.

Post-broadcast: `FusionCompletionService.completeFusionBroadcast` tracks the
outbound tx, refreshes UTXOs, and **records fuse depth** for Auto stopping.

---

## 6. Message catalogue (v3; incompatible with v2)

All messages include binding fields: `version`, `nonce`, `timestamp`, and
usually `session`.

| `type`                | Direction                            | Required fields (beyond binding)                                                                    |
| --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `round_proposal`      | → peers                              | `network`, `tier`, `epoch`, `participants`                                                          |
| `round_ack`           | → coordinator                        | `network`, `tier`, `epoch`                                                                          |
| `round_start`         | → peers                              | `network`, `tier`, `epoch`, `participants`                                                          |
| `credential_params`   | coordinator → peers                  | `roundPubkey`, `blindNoncePoints[]`                                                                 |
| `credential_request`  | peer → coordinator                   | `inputCount`, `outputCount`, `requests[]`, `amountCommitments[]`, `pedersenTotalNonce`, `excessFee` |
| `credential_response` | coordinator → peer                   | `responses[]`                                                                                       |
| `inputs`              | peer → coordinator                   | `inputs[]`, `credentialSigs[]` (parallel, required)                                                 |
| `outputs`             | anonymous final peeler → coordinator | `outputs[]`, each with canonical output, serial, and blind credential                               |
| `onion_declare`       | peer → peelers                       | `outputCount`                                                                                       |
| `onion_output`        | peer → next peeler                   | `onion` (base64), `mixOrder[]`                                                                      |
| `components_ready`    | peer → coordinator                   | (session only)                                                                                      |
| `assembled`           | coordinator → peers                  | `inputs[]`, `outputs[]`                                                                             |
| `signature`           | peer → coordinator                   | `sigs[]` (`prevTxid`, `prevIndex`, `unlockingBytecode`)                                             |
| `final`               | coordinator → peers                  | `txid`, `txHex`                                                                                     |
| `abort`               | any                                  | `reason` (≤240 chars)                                                                               |
| `blame`               | any (verifiable)                     | `accused`, `code`, `evidence` — **prove-or-don't-blame**                                            |

Parsing is strict (`parseRoundMessage`): size caps, hex shapes, participant
sets, money bounds. Invalid messages surface as protocol errors.

Version 3 is fail-closed: a v2 message is rejected rather than downgraded. This
wire-version change does not alter the deliberate chain transaction profile:
P2P transactions remain version 2 and do not add the classic `FUZ` OP_RETURN.

---

## 7. Cryptography (exact)

### 7.1 BCH Schnorr (non-blind)

- Signature: 64 bytes = `R.x (32) || s (32)`.
- Challenge: `e = SHA256(R.x || compressed(P) || msg32) mod n`.
- Verify: reconstruct `R = s·G − e·P`, require `jacobi(R.y) = +1` and matching
  `R.x`.

### 7.2 Blind Schnorr (CashFusion / Electron Cash scheme)

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

### 7.3 Pedersen

```
H = decompress( 0x02 || "CashFusion gives us fungibility." )
C = amount·H + nonce·G   // amount is signed (i64 as scalar)
```

Wire form: **65-byte uncompressed** point. Balance check uses the additive
homomorphism so the issuer/coordinator never needs individual amounts to verify
the peer’s declared excess fee.

### 7.4 What credentials do _not_ do

- They do **not** hide the input→output map from the **coordinator** (same trust
  model as a classic fusion server that sees the final template).
- **Output onion** (not Tor) is what prevents _peers and intermediate peel hops_
  from linking which participant contributed which **output**.
- Input ownership for spending is still ordinary BCH signatures at sign time;
  credentials authorize inclusion in **this round’s** CoinJoin under the round
  issuer key.

---

## 8. Wallet outer loop (shared by manual + Auto)

Both **Start P2P** and **Auto** call `startFusionRound` → `runP2pFusion`. There
is one spending path so cooldowns, depth, and leases cannot diverge.

### 8.1 Pre-round coin selection

1. Exclusive Electrum UTXO refresh (`reconcileActiveWalletUtxosForSpend`).
2. Drop CashToken UTXOs.
3. **Auto only:** keep coins with fuse depth **&lt; rounds-per-coin**
   (`coinsBelowDepth`). Manual Start may re-fuse at any depth.
4. Cap inputs per peer (`selectFusionInputs`, largest first) to credential slots.

Unconfirmed (0-conf) coins **are** eligible (documented BCH divergence from
Electron Cash’s hard exclude).

### 8.2 Fuse depth (rounds-per-coin)

| Concept       | Behaviour                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Setting       | UI **Rounds per coin** (`fuseDepth`, default **3**, clamped 1–10)                                            |
| Meaning       | Auto stops once **each coin** has been through that many completed fuses                                     |
| Inheritance   | New outputs get `min(input depths) + 1` (Electron Cash–style MIN ancestry)                                   |
| Storage       | Per-outpoint map + **per-CoinJoin txid** depth (resists key remap); memory + localStorage + BroadcastChannel |
| Change number | Clears Auto depth-met idle and **restarts** evaluation toward the new target                                 |
| New funds     | Send/receive/change → depth 0 coins → Auto may run again                                                     |

After a verified broadcast, `completeFusionBroadcast` records depth (script
match and/or Electrum outpoints for this CoinJoin). Logs include:

```text
depth: recorded N output(s) for fuse <txid>… wallet now depths min–max (K coin(s))
depth gate: E eligible of target T (coin depths min–max)
OUTCOME idle: … already at rounds-per-coin depth ≥ T …
```

### 8.3 Auto cooldowns (`fusionAutoEngine` / `fusionWalletLease`)

| Outcome                               | Wait                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Successful paid fuse                  | **40s**                                                                                          |
| Fail / cancel / empty pool / no peers | **25s**                                                                                          |
| All coins at depth (or no BCH coins)  | Long **depth-met idle** (wake on UTXO activity with below-depth coins, or raise rounds-per-coin) |

Never multi-minute fee cooldowns for ordinary fail/success.

### 8.4 Cross-window exclusivity

- Durable **round lease** + Web Locks + heartbeat so two windows of the same
  wallet cannot both pay fees.
- Stale leases (no heartbeat) are reclaimed; no “stuck forever” grey UI.

### 8.5 Auto engine (`useAutoFusion`)

- Mounted app-wide (not only on the CashFusion screen).
- **UTXO refresh** (send/receive/any tx) wakes Auto; if coins are below depth,
  clears long depth-met idle and starts without waiting for the tick slot.
- Poll/rendezvous open window clusters independent clients for gather entry;
  activity-driven ticks skip that wait.
- Changing **Rounds per coin** clears cooldown and re-ticks Auto.

### 8.6 Blame

`fusionBlame.ts`: **prove-or-don't-blame**. Only verifiable protocol faults
mark an ephemeral session key. **Never** blame for Tor lag, relay timeout, or
late join.

---

## 9. Comparison: server CashFusion vs P2P

| Property                | Server path (`src-tauri/src/fusion`)   | P2P path (`nostr/*`)                        |
| ----------------------- | -------------------------------------- | ------------------------------------------- |
| Discovery               | TCP fusion server / pool tags          | Nostr replaceable announcements             |
| Transport               | Protobuf frames over TCP(+TLS)+Tor     | NIP-59 gift-wrap over Nostr (+Tor)          |
| Issuer                  | Dedicated fusion server                | Elected peer coordinator                    |
| Pedersen                | Full component model + blame           | Per-peer commit at credential time          |
| Blind Schnorr           | Server signs; client requester in Rust | Coordinator `BlindIssuer`; TS requester     |
| Covert / output privacy | Separate Tor circuits per component    | **One-shot socket per anonymous component** + jitter + **output onion** |
| Blame                   | Full EC-style component blame          | P2P prove-or-don't-blame                    |
| Assembly trust          | Server proposes; client checks         | Coordinator proposes; **every** peer checks |
| Broadcast               | Client/server paths                    | Coordinator + peer liveness broadcast       |
| Outer wallet loop       | Same `FusionRunnerService`             | Same                                        |
| Network                 | Chipnet for tests; never mainnet in CI | Same rule                                   |

---

## 10. Safety gates (must not be weakened)

1. **Zero-touch upstream:** P2P lives under `src/platform/desktop/**` (and
   related desktop wiring). Do not “fix” by editing upstream mobile sources
   for convenience.
2. **Chipnet only in automated tests** — no mainnet fusion fixtures.
3. **Never log mnemonics / private keys / seed material.**
4. **Locked wallet is actually locked** — do not suppress auto-lock while a
   round runs.
5. **CashToken coins are not fused.**
6. **Output onion on failure fails the round** — no silent plaintext downgrade.
7. **Issuer nonce one-shot** — never “retry sign” on the same slot.
8. **Full-set ACK** — never fuse a shrunk subset of the proposed participant list.
9. **MIN ≥ 3** — onion privacy floor; no 2-party CoinJoin path.
10. **Tor fail-closed for P2P** — no clearnet Nostr for fusion.
11. **Depth claims use MIN ancestry** — never overstate privacy.
12. **Manual Start may re-fuse; Auto respects rounds-per-coin.**

---

## 11. Testing the mechanism

| Suite                                        | What it proves                                          |
| -------------------------------------------- | ------------------------------------------------------- |
| `nostr/__tests__/fusionBlindSchnorr.test.ts` | Blind round-trip, nonce reuse refusal, Pedersen balance |
| `nostr/__tests__/fusionSession.test.ts`      | Multi-peer in-memory CoinJoin + onion + credentials     |
| `nostr/__tests__/fusionRendezvous.test.ts`   | Election / proposal / full-set behaviour                |
| `nostr/__tests__/fusionSign.test.ts`         | Wire byte-order / signing invariants                    |
| `nostr/__tests__/fusion.test.ts`             | Pool live filter, soft vs strict ghosts                 |
| `__tests__/fusionCoinDepth.test.ts`          | Depth inheritance, stop at target, txid fallback        |
| `__tests__/FusionRunnerService.test.ts`      | Auto vs manual depth, cooldown, no-eligible idle        |
| `__tests__/fusionWalletLease.test.ts`        | Lease + Auto cooldown claim / wake                      |
| `cargo test` `fusion::schnorr`               | Rust `BlindIssuer` + requester parity                   |
| Chipnet live multi-window                    | On-chain CoinJoin (manual; not assumed green in CI)     |

In-memory multi-peer success proves the **state machine and crypto wiring**.
It does **not** replace a chipnet confirmation of relays + Tor + Electrum.

---

## 12. Glossary

| Term                             | Meaning here                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Credential**                   | Unblinded BCH Schnorr signature under the **round** issuer key over an input’s domain-separated hash |
| **Issuer**                       | Holder of `x` and one-shot `k_i`; the elected coordinator                                            |
| **Coordinator**                  | Peer that issues credentials and assembles the tx template                                           |
| **Component**                    | One input or output in a fusion round                                                                |
| **Tier**                         | Target fused coin denomination (sats) peers advertise                                                |
| **Mix order**                    | Ordered list of peelers for **output onion**; excludes coordinator                                   |
| **Output onion**                 | ECDH+AES-GCM peel/shuffle among peers — **not Tor**                                                  |
| **Tor transport**                | SOCKS path for Nostr sockets — network IP privacy                                                    |
| **NIP-59 gift-wrap**             | Relay-facing encryption of round messages                                                            |
| **Session**                      | Round id string bound into every message for that attempt                                            |
| **Rounds-per-coin / fuse depth** | Auto stop condition: how many completed fuses per coin                                               |
| **Strict / soft peers**          | Lock set vs approximate live set during gather                                                       |
| **Full-set ACK**                 | Every proposed peer must acknowledge before round start                                              |

Privacy layer roles (Tor / gift-wrap / Pedersen / blind Schnorr / output onion):
[p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md).

---

## 13. Change control

When you change the wire format, crypto, gather policy, or Auto depth/cooldown:

1. Bump `ROUND_MSG_VERSION` if old clients must not parse new messages.
2. Update **this document** and, if naming/layers change,
   [privacy-layers](./p2p-cashfusion-privacy-layers.md) in the same PR.
3. Add or extend sabotage-style tests (break the invariant → that test fails).
4. Keep Electron Cash / 00-Wallet references honest: cite files, do not invent
   behaviour without reading their tree.

---

_Last updated for PR #12 **ship**: protocol v3 (blind input/output credentials + Pedersen +
mandatory output onion), MIN=3 / MAX=6, full-set ACK, Auto 40s/25s cooldowns,
fuse-depth stop, Tor fail-closed — **implemented**, not planned._
