# P2P CashFusion FAQ

Short answers checked against the desktop code. Wire detail:
[p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md).

## What about blame?

Yes — it is a **P2P-specific** mechanic, not a port of Electron Cash
`blame.rs`. The fusion server can accuse mid-round because it already
knows who sent each component. Here it cannot: happy-path `inputs` /
`outputs` / `signature` are anonymous, so a dead round has **no name on
the coin**.

**Stage 1 (shipped):** a generic abort does **not** open a disclosure
phase. Peers do not send openings (`a||b`, salt, Pedersen nonce) after
fail. `component_disclosure` is still parsed so an old peer cannot crash
the round; it is never requested, never emitted, and never used as
evidence. `findFaultInDisclosures` remains as a pure helper + unit tests
only — it is not the live path.

**Prove-or-don't-blame** on messages that **arrived**. Live codes today:
`pedersen_unbalanced`, `credential_slot_oob` (via `blameAndFail`), plus
`invalid_component_commitment`, `invalid_input_credential`,
`duplicate_outpoint` when independently re-verified.
`verifyBlameReport` still gates every remote `blame`. It **rejects**
`invalid_signature_set` (`signature absence is not blame evidence`).
**Never** blame Tor lag, relay timeout, late join, or a missing
signature.

The accused is an **ephemeral round key**. That is diagnosis, not a
wallet ban and not DoS defense. The same person comes back as a new key
next attempt. A local 10-minute ghost record is not shared with peers.

Why not disclose after fail: silence looks the same as a drop, and a
dishonest coordinator can drop an honest signature, abort, and demand
openings to frame the signer. Stage 1 prefers no name over a framed
name. Later stages (v5 fanout, optional quarantine) are **not**
implemented — see [proposed-blame-p2p-cashfusion.md](./proposed-blame-p2p-cashfusion.md).

## What happens if someone does not sign an input?

The round dies. No transaction. Nobody is named.

Every assembled input must be signed (`SIGHASH_ALL | FORKID`). The coordinator
waits and re-sends the assembled template. If a signature never arrives, the
round times out and aborts (`fusionSession.ts`). Nothing is broadcast. Coins
do not move.

The set cannot be rewritten at that point. A missing signer cannot be dropped
so the rest continue. Same as classic CashFusion: incomplete signatures mean
no CoinJoin, not a smaller one.

That timeout is an **ambiguous abort**, not `invalid_signature_set`. Auto
tries again later.

## What is this, vs Electron Cash CashFusion?

Same math: Pedersen, blind Schnorr, EC component binding (protocol v4). There
is no fusion server, so discovery is Nostr over Tor, one peer is elected
issuer for that attempt, and output unlinkability among players is a
mandatory onion peel instead of covert submit to a server.

## What is the onion for?

So other wallets cannot say which output is whose. Each hop peels one layer
and shuffles. The coordinator still sees the output *list* (it assembles the
tx), not a labeled who-created-which-output map. The onion is not Tor.

## Can the coordinator tell who owns an input?

Not from `from`. Happy-path `inputs` and `signature` messages use a throwaway
key and a one-shot Tor circuit. Admission is the blind credential. The
control plane still names each peer’s *quota* (how many). The coordinator
also sees the full assembled template, same class as a fusion server.

## What if someone never ACKs the proposal?

Before start, the set may shrink to the ACKed remainder if at least 4 remain.
Below 4 the attempt dies. After onion or sign starts, it cannot shrink.

## Unconfirmed coins?

P2P allows 0-conf fusion inputs. Electron Cash historically excludes them.
That is a deliberate divergence.

## Player counts?

Protocol constants in `fusionKnobs.ts`, not wallet settings: lock at **6**,
ACK-shrink floor **4**, cap **10**. See [p2p-cashfusion-knobs.md](./p2p-cashfusion-knobs.md).
