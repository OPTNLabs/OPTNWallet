# P2P CashFusion — Privacy Layers (PR #12 committed design)

This is the **canonical naming and role map** for every privacy piece in the
P2P CashFusion path. Read this before the protocol or threat-model docs if you
are confused about “onion vs Tor vs blind Schnorr.”

**Authoritative companions**

| Doc | Role |
|-----|------|
| [p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md) | Wire format, phases, messages, code map |
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Adversary classes and mitigations |
| Source under `src/platform/desktop/nostr/` | Normative behaviour |

**Committed production defaults (P2P path)**

| Setting | Value | Where |
|---------|--------|--------|
| Tor required | **Yes** — fail closed if Tor is down | `FusionP2pService`, `fusionAutoEngine` |
| NIP-59 gift-wrap for round traffic | **Yes** | `fusionTransport.ts` |
| Pedersen + blind Schnorr credentials | **Yes** | `fusionPedersen.ts`, `fusionBlindSchnorr.ts` |
| Credential slots per peer | **16** inputs max per peer per round | `CREDENTIAL_SLOTS_PER_PEER`; `selectFusionInputs` in `FusionP2pService` |
| Min / max participants | **3 / 6** | `MIN_PARTICIPANTS` / `MAX_PARTICIPANTS` in `fusion.ts` |
| Full-set ACK | **Yes** — refuse partial rounds | `fusionRendezvous.ts` |
| Credential wait / params resend | **35s** / **1.5s × 12** | `P2P_CREDENTIAL_*` in `fusionTiming.ts` |
| Rendezvous timeout | **60s** + **20s** proposal | `P2P_RENDEZVOUS_MS`, `P2P_PROPOSAL_TIMEOUT_MS` |
| Output onion | **Always on** (mandatory; no toggle) | `runFusionRound` — ≥3 peers so ≥2 peelers |
| Auto success / fail cooldown | **40s / 25s** | `fusionAutoEngine.ts` |
| Rounds-per-coin (fuse depth) | Default **3**; Auto stop condition | `fusionCoinDepth.ts`, UI **Rounds per coin** |
| P2P blame | **Prove-or-don't-blame** (ephemeral session key only) | `fusionBlame.ts` — never for Tor/relay timeout or late join |
| Extra mixnet / onion *servers* | **None** | — |

**Regression note (why live P2P can fail after credentials landed):** when the
coordinator became a real blind-Schnorr issuer (`5b00b65d`), each peer got a
fixed slot budget. Submitting **more than 16 UTXOs** aborts the round with
`too many inputs for credential slots`. That is **not** an upstream mobile bug;
it is a desktop P2P wiring bug if the service passes the whole wallet UTXO set.
Cap inputs with `selectFusionInputs` (largest first).

There is **no dedicated fusion server** and **no extra privacy infrastructure**
beyond: the peers in the round, public Nostr relays, Tor (user or integrated),
and the Bitcoin Cash network (Chipnet in development).

---

## One-sentence stack

> **Tor** hides *where you are*. **NIP-59** hides *round content from relays*.
> **Pedersen + blind Schnorr** run the *CashFusion credential math*.
> **Output onion** stops *peer hops* from linking *who contributed which output*.

These four layers are **not alternatives**. Each covers a different adversary.
Removing one does not make the others “do its job.”

---

## Naming trap (read this twice)

| Phrase people say | What they often mean | What it is **not** |
|-------------------|----------------------|--------------------|
| “Onion” / “onion wrap” / “onion mixnet” | **Output onion** — layered ECDH+AES-GCM among fusion peers (`onionCrypto.ts`) | Tor, Tor onion services, or a public mixnet product |
| “Onion routing” (Tor sense) | **Tor** SOCKS path for Nostr/WebSocket | The peel/shuffle of fusion outputs |
| “Blind signature” | **Blind Schnorr credential** under the round issuer key | Ordinary BCH input signatures on the CoinJoin |
| “Gift wrap” / “onion package” (Nostr) | **NIP-59** kind-1059 wrapping of events | Output onion peel chain |

In this repository, prefer these fixed names:

1. **Tor transport**
2. **NIP-59 gift-wrap transport**
3. **Pedersen commitments**
4. **Blind Schnorr credentials**
5. **Output onion** (peer peel chain)

Do **not** call Tor “the onion mixnet.” Do **not** call output onion “Tor.”

---

## Layer 1 — Tor transport

| | |
|--|--|
| **What** | All remote P2P fusion traffic (Nostr WSS, etc.) goes through Tor SOCKS. |
| **Why** | Network observers and relays must not see the wallet’s clearnet IP tied to fusion timing. |
| **Infrastructure** | System Tor (preferred, ports 9050/9150) or app-integrated Tor. **No** custom mixnet operators. |
| **Essential?** | **Yes for P2P.** Fail closed: no Tor → no P2P fusion. |
| **Code** | `FusionStatusService`, `nostr/torWebSocket.ts`, `FusionP2pService` (`armTorRouting`, `TorWebSocket`) |
| **Does not do** | Does not shuffle outputs, hide amounts, or replace blind credentials. |

---

## Layer 2 — NIP-59 gift-wrap (Nostr transport privacy)

| | |
|--|--|
| **What** | Round and coordination messages are sealed/gift-wrapped (kind **1059**), same family as NIP-17 DMs. |
| **Why** | Public relays must not store/read plaintext proposals, inputs, outputs, signatures. |
| **Infrastructure** | **None** beyond ordinary Nostr relays already used for discovery. |
| **Essential?** | **Yes** for anything sensitive on a public relay. Pool *announcements* may still be replaceable public metadata (kind 12230); round control is gift-wrapped. |
| **Code** | `fusionTransport.ts`, `nostr/chat.ts` (NIP-17/44/59 helpers) |
| **Does not do** | Does not provide CashFusion amount/credential crypto. Does not hide IP (Tor does). Does not peel-mix outputs among peers. |

---

## Layer 3 — Pedersen commitments

| | |
|--|--|
| **What** | `C = amount·H + nonce·G` with fixed H from the CashFusion tag string. Wire: **65-byte uncompressed** point. |
| **Why** | Peers prove contribution balance to the issuer/coordinator **homomorphically** without handing every amount as naked plaintext in the credential step. |
| **Infrastructure** | **None** — pure local crypto. |
| **Essential?** | **Yes** for CashFusion-style credential issuance (parity with Electron Cash math). |
| **Code** | `fusionPedersen.ts` (P2P TS); `src-tauri/src/fusion/pedersen.rs` (server path / parity tests) |
| **Does not do** | Does not hide the final assembled template from the coordinator. Does not replace Tor or NIP-59. |

---

## Layer 4 — Blind Schnorr credentials

| | |
|--|--|
| **What** | Electron Cash–compatible **blind Schnorr**: requester blinds, issuer signs without seeing the final `(R'.x, s')`, requester unblinds a valid BCH Schnorr credential under the **round issuer** key. |
| **Why** | Authorize inputs into *this* CoinJoin under a one-shot round key without letting the issuer link the blind *request* to the unblinded *credential* by signature value. |
| **Infrastructure** | **None** — issuer is the **elected peer coordinator** for that round (not a long-lived server). |
| **Essential?** | **Yes** for the fusion credential model (server and P2P). |
| **Code** | `fusionBlindSchnorr.ts`; Rust `BlindIssuer` in `src-tauri/src/fusion/schnorr.rs` |
| **Does not do** | Does **not** hide the full input→output map from the coordinator once the template is assembled (same class of trust as a classic fusion server). Does not hide IP or relay metadata. Does not shuffle peer outputs. |

Issuer nonce slots are **one-shot**. Retrying sign on the same slot is forbidden (can leak the issuer key).

---

## Layer 5 — Output onion (peer peel chain)

| | |
|--|--|
| **What** | Each **output** is layered with ECDH + AES-GCM for every peeler in `mixOrder`. Each hop **peels one layer**, **CSPRNG Fisher–Yates shuffles** the batch, and **forwards**. Last peeler reveals plaintext outputs **only to the coordinator**. |
| **Why** | Intermediate peers must not learn which participant contributed which output. **One honest hop** is enough for that unlinkability property. |
| **Infrastructure** | **None.** Only the wallets already in the round. No mixnet servers, no Tor onion service requirement for this layer. |
| **Essential?** | **Yes — mandatory.** There is no plaintext/direct output path and no `onionEnabled` flag. Failure is **loud** — round aborts. |
| **Code** | `onionCrypto.ts`, peel/forward in `fusionSession.ts`, `FusionP2pService` |
| **Does not do** | Is **not Tor**. Does not hide that a CoinJoin happened on-chain. Does not stop the **last peeler** (or the **coordinator**) from seeing the full plaintext **output list** — only the *contributor→output* link is what the shuffles protect. |

### mixOrder and who peels

```
mixOrder = sort(participants \ { coordinator })
// Coordinator assembles the CoinJoin. It does NOT peel.
```

Flow:

1. Each peer `onionWrap`s its outputs through `mixOrder` (outer layer = first peeler).
2. Peer sends `onion_output` to `mixOrder[0]` (still under NIP-59 for transport).
3. Hop *i*: peel with own private key → shuffle batch → forward to `mixOrder[i+1]`.
4. Last hop: peel → shuffle → send revealed outputs to coordinator.
5. Coordinator assembles inputs + output pool → `assembled` → every peer verifies and signs own inputs.

There is **no direct/plaintext output path** and **no 2-party fuse**. Rounds
require ≥3 participants (onion needs ≥2 peelers). Revealed `outputs` messages
exist only as the last peeler → coordinator handoff after the mix.

### Complexity / failure modes (honest assessment)

Output onion needs no infrastructure, but it **does** add protocol surface:

| Failure | Result |
|---------|--------|
| Peeler missing round private key | Round aborts (`private key not found for onion peeling`) |
| ECC/WASM unavailable | Round aborts (no silent fallback) |
| Peer drops mid-peel | Round fails |
| Wrong `mixOrder` | Stuck or invalid peel |

That is **implementation/protocol risk**, not operational infrastructure.

---

## Who sees what (summary)

| Actor | Sees | Blocked by |
|-------|------|------------|
| Network / ISP | Tor exit-ish timing only, not clearnet wallet IP | **Tor** |
| Nostr relay | Encrypted gift-wraps; limited public announce metadata | **NIP-59** (+ Tor for IP) |
| Intermediate peeler | Batches of still-layered (or later plaintext at last hop) blobs; **not** reliable contributor map if ≥1 honest hop shuffled | **Output onion** |
| Last peeler | All outputs plaintext after final peel | Acceptable; still no reliable contributor map if prior hop shuffled |
| Coordinator | Full template (inputs + outputs) for assembly | Same model as classic fusion **server**; mitigated by per-peer template checks + own-input-only signing |
| Chain analyst | Confirmed CoinJoin structure | Anonymity set size, tiers, HD outputs, no cross-round Nostr identity reuse |

---

## Server CashFusion vs P2P (same goals, different transport)

| Concern | Server path (`src-tauri/src/fusion`) | P2P path (`nostr/*`) |
|---------|-------------------------------------|----------------------|
| Discovery | Fusion server TCP pool | Nostr replaceable announcements |
| Transport privacy | TLS + **Tor** (covert circuits) | **NIP-59** + **Tor** |
| Amount/credential crypto | **Pedersen** + **blind Schnorr** | Same roles (TS issuer = elected peer) |
| Output unlinkability vs other players | Covert submit discipline + server design | **Output onion** peel chain |
| Long-lived fusion daemon | Required | **Not** required |

P2P is a **different transport**, not a weaker crypto story. Layers 3–5 + Tor
are the committed parity story for PR #12’s P2P design.

---

## Glossary (fixed terms)

| Term | Meaning in this repo |
|------|----------------------|
| **Tor transport** | SOCKS-routed network path for P2P sockets |
| **NIP-59 gift-wrap** | Nostr event packaging so relays do not see plaintext round bodies |
| **Pedersen commitment** | Homomorphic amount commitment `amount·H + nonce·G` |
| **Blind Schnorr credential** | Unblindable signature under the **round** issuer key for an input hash |
| **Output onion** | Multi-layer ECDH+AES-GCM wrap of outputs through `mixOrder` peels + shuffles |
| **mixOrder** | Ordered peeler pubkeys; **excludes** coordinator |
| **Coordinator / issuer** | Elected peer: issues blind credentials and assembles the tx template |
| **Component** | One input/output (or server-path blank) slot in a fusion round |

---

## Doc maintenance rule

When you change **defaults** (Tor fail-closed, gift-wrap kinds, `MIN_PARTICIPANTS`)
or **who peels vs who assembles**, update **this file first**, then
`p2p-cashfusion-protocol.md` and `THREAT_MODEL.md` so the three stay aligned.
