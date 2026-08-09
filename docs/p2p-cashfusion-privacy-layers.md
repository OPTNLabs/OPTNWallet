# P2P CashFusion — Privacy Layers (PR #12 — **shipped**)

This is the **canonical naming and role map** for every privacy piece in the
P2P CashFusion path. The design below is **implemented**, not a future plan.
Read this before the protocol or threat-model docs if you are confused about
“onion vs Tor vs blind Schnorr.”

**Status:** Implemented for desktop P2P fusion (gather → **v4 EC credentials** →
anonymous inputs/sigs + per-component Tor → output onion → assemble → sign →
broadcast; Auto + fuse depth; Tor fail-closed). Production clearance still needs
Chipnet soak. See
[cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md) for
the server path map (also shipped).

**Authoritative companions**

| Doc                                                                        | Role                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| [p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md)                 | Wire format, phases, messages, code map (as implemented) |
| [THREAT_MODEL.md](./THREAT_MODEL.md)                                       | Adversary classes and mitigations                        |
| [cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md) | Overall ship status — both P2P and server paths          |
| Source under `src/platform/desktop/nostr/`                                 | Normative behaviour                                      |

**Committed production defaults (P2P path)**

| Setting                              | Value                                                 | Where                                                                   |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Tor required                         | **Yes** — fail closed if Tor is down                  | `FusionP2pService`, `fusionAutoEngine`                                  |
| NIP-59 gift-wrap for round traffic   | **Yes**                                               | `fusionTransport.ts`                                                    |
| Pedersen + blind Schnorr credentials | **Yes**                                               | `fusionPedersen.ts`, `fusionBlindSchnorr.ts`                            |
| Credential slots per peer            | **16** inputs max per peer per round                  | `CREDENTIAL_SLOTS_PER_PEER`; `selectFusionInputs` in `FusionP2pService` |
| Min / max participants               | **3 / 6**                                             | `MIN_PARTICIPANTS` / `MAX_PARTICIPANTS` in `fusion.ts`                  |
| Full-set ACK                         | **Yes** — refuse partial rounds                       | `fusionRendezvous.ts`                                                   |
| Credential wait / params resend      | **35s** / **1.5s × 12**                               | `P2P_CREDENTIAL_*` in `fusionTiming.ts`                                 |
| Rendezvous timeout                   | **60s** + **20s** proposal                            | `P2P_RENDEZVOUS_MS`, `P2P_PROPOSAL_TIMEOUT_MS`                          |
| Output onion                         | **Always on** (mandatory; no toggle)                  | `runFusionRound` — ≥3 peers so ≥2 peelers                               |
| Auto success / fail cooldown         | **40s / 25s**                                         | `fusionAutoEngine.ts`                                                   |
| Rounds-per-coin (fuse depth)         | Default **3**; Auto stop condition                    | `fusionCoinDepth.ts`, UI **Rounds per coin**                            |
| P2P blame                            | **Prove-or-don't-blame** (ephemeral session key only) | `fusionBlame.ts` — never for Tor/relay timeout or late join             |
| Extra mixnet / onion _servers_       | **None**                                              | —                                                                       |

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

> **Tor** hides _where you are_. **NIP-59** hides _round content from relays_.
> **Pedersen + blind Schnorr** run the _CashFusion credential math_.
> **Output onion** stops _peer hops_ from linking _who contributed which output_.

These four layers are **not alternatives**. Each covers a different adversary.
Removing one does not make the others “do its job.”

---

## Naming trap (read this twice)

| Phrase people say                       | What they often mean                                                          | What it is **not**                                  |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| “Onion” / “onion wrap” / “onion mixnet” | **Output onion** — layered ECDH+AES-GCM among fusion peers (`onionCrypto.ts`) | Tor, Tor onion services, or a public mixnet product |
| “Onion routing” (Tor sense)             | **Tor** SOCKS path for Nostr/WebSocket                                        | The peel/shuffle of fusion outputs                  |
| “Blind signature”                       | **Blind Schnorr credential** under the round issuer key                       | Ordinary BCH input signatures on the CoinJoin       |
| “Gift wrap” / “onion package” (Nostr)   | **NIP-59** kind-1059 wrapping of events                                       | Output onion peel chain                             |

In this repository, prefer these fixed names:

1. **Tor transport**
2. **NIP-59 gift-wrap transport**
3. **Pedersen commitments**
4. **Blind Schnorr credentials**
5. **Output onion** (peer peel chain)

Do **not** call Tor “the onion mixnet.” Do **not** call output onion “Tor.”

---

## Layer 1 — Tor transport

|                    |                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **What**           | All remote P2P fusion traffic (Nostr WSS, etc.) goes through Tor SOCKS.                              |
| **Why**            | Network observers and relays must not see the wallet’s clearnet IP tied to fusion timing.            |
| **Infrastructure** | System Tor (preferred, ports 9050/9150) or app-integrated Tor. **No** custom mixnet operators.       |
| **Essential?**     | **Yes for P2P.** Fail closed: no Tor → no P2P fusion.                                                |
| **Code**           | `FusionStatusService`, `nostr/torWebSocket.ts`, `FusionP2pService` (`armTorRouting`, `TorWebSocket`) |
| **Does not do**    | Does not shuffle outputs, hide amounts, or replace blind credentials.                                |

---

## Layer 2 — NIP-59 gift-wrap (Nostr transport privacy)

|                    |                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What**           | Round and coordination messages are sealed/gift-wrapped (kind **1059**), same family as NIP-17 DMs.                                                          |
| **Why**            | Public relays must not store/read plaintext proposals, inputs, outputs, signatures.                                                                          |
| **Infrastructure** | **None** beyond ordinary Nostr relays already used for discovery.                                                                                            |
| **Essential?**     | **Yes** for anything sensitive on a public relay. Pool _announcements_ may still be replaceable public metadata (kind 12230); round control is gift-wrapped. |
| **Code**           | `fusionTransport.ts`, `nostr/chat.ts` (NIP-17/44/59 helpers)                                                                                                 |
| **Does not do**    | Does not provide CashFusion amount/credential crypto. Does not hide IP (Tor does). Does not peel-mix outputs among peers.                                    |

---

## Layer 3 — Pedersen commitments

|                    |                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What**           | `C = amount·H + nonce·G` with fixed H from the CashFusion tag string. Wire: **65-byte uncompressed** point.                                            |
| **Why**            | Peers prove contribution balance to the issuer/coordinator **homomorphically** without handing every amount as naked plaintext in the credential step. |
| **Infrastructure** | **None** — pure local crypto.                                                                                                                          |
| **Essential?**     | **Yes** for CashFusion-style credential issuance (parity with Electron Cash math).                                                                     |
| **Code**           | `fusionPedersen.ts` (P2P TS); `src-tauri/src/fusion/pedersen.rs` (server path / parity tests)                                                          |
| **Does not do**    | Does not hide the final assembled template from the coordinator. Does not replace Tor or NIP-59.                                                       |

---

## Layer 4 — Blind Schnorr credentials

|                    |                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**           | Electron Cash–compatible **blind Schnorr**: requester blinds, issuer signs without seeing the final `(R'.x, s')`, requester unblinds a valid BCH Schnorr credential under the **round issuer** key.                  |
| **Why**            | Authorize inputs into _this_ CoinJoin under a one-shot round key without letting the issuer link the blind _request_ to the unblinded _credential_ by signature value.                                               |
| **Infrastructure** | **None** — issuer is the **elected peer coordinator** for that round (not a long-lived server).                                                                                                                      |
| **Essential?**     | **Yes** for the fusion credential model (server and P2P).                                                                                                                                                            |
| **Code**           | `fusionBlindSchnorr.ts`; Rust `BlindIssuer` in `src-tauri/src/fusion/schnorr.rs`                                                                                                                                     |
| **Does not do**    | Does **not** hide the full input→output map from the coordinator once the template is assembled (same class of trust as a classic fusion server). Does not hide IP or relay metadata. Does not shuffle peer outputs. |

Issuer nonce slots are **one-shot**. Retrying sign on the same slot is forbidden (can leak the issuer key).

---

## Layer 5 — Output onion (peer peel chain)

|                    |                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**           | Each **output**, its fresh 32-byte serial, and its round-bound blind Schnorr credential are encoded into a uniform 384-byte plaintext, then layered with ECDH + AES-GCM for every peeler in `mixOrder`. Each hop **peels one layer**, **CSPRNG Fisher–Yates shuffles** the batch, and **forwards**. Last peeler reveals authorized plaintext outputs **only to the coordinator**. |
| **Why**            | Intermediate peers must not learn which participant contributed which output. **One honest hop** is enough for that unlinkability property.                                                                                                                                                                                                                                       |
| **Infrastructure** | **None.** Only the wallets already in the round. No mixnet servers, no Tor onion service requirement for this layer.                                                                                                                                                                                                                                                              |
| **Essential?**     | **Yes — mandatory.** There is no plaintext/direct output path and no `onionEnabled` flag. Failure is **loud** — round aborts.                                                                                                                                                                                                                                                     |
| **Code**           | `onionCrypto.ts`, peel/forward in `fusionSession.ts`, `FusionP2pService`                                                                                                                                                                                                                                                                                                          |
| **Does not do**    | Is **not Tor**. Does not hide that a CoinJoin happened on-chain. Does not stop the **last peeler** (or the **coordinator**) from seeing the full plaintext **output list** — only the _contributor→output_ link is what the shuffles protect.                                                                                                                                     |

### mixOrder and who peels

```
mixOrder = sort(participants \ { coordinator })
// Coordinator assembles the CoinJoin. It does NOT peel.
```

Flow:

1. Each peer `onionWrap`s its outputs through `mixOrder` (outer layer = first peeler).
2. Peer sends `onion_output` to `mixOrder[0]` (still under NIP-59 for transport).
3. Hop _i_: peel with own private key → shuffle batch → forward to `mixOrder[i+1]`.
4. Last hop: peel → shuffle → send revealed outputs to coordinator.
5. Coordinator assembles inputs + output pool → `assembled` → every peer verifies and signs own inputs.

The coordinator verifies each anonymous output credential against the **v4 EC
component binding**: `sha256(serialized Output Component)` with
`salt_commitment` (plus a separate serial nullifier). It requires the exact
issued output quota and consumes persisted one-use serial nullifiers before
assembly. A new NIP-59 wrapper therefore cannot make an old credential valid
again, and the final peeler does **not** need to identify itself — provenance
is the blind credential, not the peel identity.

Input registration remains attributable to the coordinator in v3. The later
input-signature exchange is attributable too, so hiding only the registration
message would not provide coordinator unlinkability; changing that property
requires a separate signing-channel redesign. Output contributor unlinkability
through the peel/shuffle path is preserved.

There is **no direct/plaintext output path** and **no 2-party fuse**. Rounds
require ≥3 participants (onion needs ≥2 peelers). Revealed `outputs` messages
exist only as the last peeler → coordinator handoff after the mix.

### Complexity / failure modes (honest assessment)

Output onion needs no infrastructure, but it **does** add protocol surface:

| Failure                          | Result                                                   |
| -------------------------------- | -------------------------------------------------------- |
| Peeler missing round private key | Round aborts (`private key not found for onion peeling`) |
| ECC/WASM unavailable             | Round aborts (no silent fallback)                        |
| Peer drops mid-peel              | Round fails                                              |
| Wrong `mixOrder`                 | Stuck or invalid peel                                    |

That is **implementation/protocol risk**, not operational infrastructure.

---

## Who sees what (summary)

| Actor               | Sees                                                                                                                        | Blocked by                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Network / ISP       | Tor exit-ish timing only, not clearnet wallet IP                                                                            | **Tor**                                                                                                 |
| Nostr relay         | Encrypted gift-wraps; limited public announce metadata                                                                      | **NIP-59** (+ Tor for IP)                                                                               |
| Intermediate peeler | Batches of still-layered (or later plaintext at last hop) blobs; **not** reliable contributor map if ≥1 honest hop shuffled | **Output onion**                                                                                        |
| Last peeler         | All outputs plaintext after final peel                                                                                      | Acceptable; still no reliable contributor map if prior hop shuffled                                     |
| Coordinator         | Full template (inputs + outputs) for assembly                                                                               | Same model as classic fusion **server**; mitigated by per-peer template checks + own-input-only signing |
| Chain analyst       | Confirmed CoinJoin structure                                                                                                | Anonymity set size, tiers, HD outputs, no cross-round Nostr identity reuse                              |

---

## Server CashFusion vs P2P (same goals, different transport)

| Concern                               | Server path (`src-tauri/src/fusion`)     | P2P path (`nostr/*`)                  |
| ------------------------------------- | ---------------------------------------- | ------------------------------------- |
| Discovery                             | Fusion server TCP pool                   | Nostr replaceable announcements       |
| Transport privacy                     | TLS + **Tor** (covert circuits)          | **NIP-59** + **Tor**, one-shot socket per anonymous component |
| Amount/credential crypto              | **Pedersen** + **blind Schnorr**         | Same roles (TS issuer = elected peer) |
| Output unlinkability vs other players | Covert submit discipline + server design | **Output onion** peel chain           |
| Long-lived fusion daemon              | Required                                 | **Not** required                      |

P2P is a **different transport**, not a weaker crypto story. Layers 3–5 + Tor
are the **shipped** parity story for PR #12’s P2P design (not aspirational).

### Per-component transport isolation

Sealing each anonymous output under a fresh throwaway key stops the *coordinator*
linking it to the peer's round identity. It does nothing about the *relay*: if
every output of a round leaves over one shared socket, the relay groups them by
connection and the fresh keys buy nothing against that observer.

So each anonymous component now publishes on its own short-lived pool, closed
immediately after (`createComponentPool` in `nostr/fusionTransport.ts`). The Tor
WebSocket implementation is installed globally, so one pool means one connection
and one circuit with its own SOCKS isolation token — the same property Electron
Cash gets from a separate covert connection per component.

**Scope, stated honestly:** this covers *outputs* (`outputs`, `onion_output`).
Input registration and the later signature messages still travel under the
peer's round identity, so a coordinator still learns which inputs belong to the
same participant. That is not an oversight — every blame code in
`nostr/fusionBlame.ts` binds to an `accused` participant pubkey, and
`verifyBlameReport` rejects a report whose accused is not in the participant set.
Anonymising the input and signature channels removes the input those codes are
built on, so it requires the Electron Cash covert-component blame model rather
than a bookkeeping change. Tracked as a known residual, not a shipped property.

---

## Glossary (fixed terms)

| Term                         | Meaning in this repo                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| **Tor transport**            | SOCKS-routed network path for P2P sockets                                    |
| **NIP-59 gift-wrap**         | Nostr event packaging so relays do not see plaintext round bodies            |
| **Pedersen commitment**      | Homomorphic amount commitment `amount·H + nonce·G`                           |
| **Blind Schnorr credential** | Unblindable signature under the **round** issuer key for an input hash       |
| **Output onion**             | Multi-layer ECDH+AES-GCM wrap of outputs through `mixOrder` peels + shuffles |
| **mixOrder**                 | Ordered peeler pubkeys; **excludes** coordinator                             |
| **Coordinator / issuer**     | Elected peer: issues blind credentials and assembles the tx template         |
| **Component**                | One input/output (or server-path blank) slot in a fusion round               |

---

## Doc maintenance rule

When you change **defaults** (Tor fail-closed, gift-wrap kinds, `MIN_PARTICIPANTS`)
or **who peels vs who assembles**, update **this file first**, then
`p2p-cashfusion-protocol.md` and `THREAT_MODEL.md` so the three stay aligned.
