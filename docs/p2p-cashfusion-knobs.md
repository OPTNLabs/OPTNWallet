# P2P CashFusion protocol knobs

Internal protocol constants. **Not wallet settings.** Do not add these to
CashFusion UI, redux-persist, or per-wallet policy.

Edit the numbers in `src/platform/desktop/fusionKnobs.ts`
(`FUSION_KNOB_DEFAULTS`). Runtime gather / rendezvous / onion read
`getFusionKnobs()`. Tests may overlay via `applyFusionKnobs()`; production
must not persist an overlay.

Companion: [p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md) §4.

## Current product values

| Knob | Default | Meaning |
| --- | ---: | --- |
| `minPlayers` | **6** | Lock gather / first proposal only at this many live wallets |
| `minSafePlayers` | **4** | After propose, if some never ACK or the coordinator vanishes, continue only if the remainder is at least this many |
| `maxPlayers` | **10** | Cap per round |
| Onion floor | **3** | Hard floor in `FUSION_KNOB_LIMITS.minPlayersFloor` — mix needs ≥2 peelers |
| Wire cap | **20** | `FUSION_KNOB_LIMITS.maxPlayersCeil` |

So: start at 6–10. If two drop after propose, keep going at 4+. Below 4,
abort and Auto retries. Mid-onion / mid-sign cannot shrink the tx.

Chipnet and mainnet use the **same** client floors. A local Electron Cash
server may advertise a weaker `min_clients` for self-tests; that does not
change these P2P numbers.

## Tiers (satoshi bands)

Peers must share a compatible size band to sit in the same round.

| Sats | BCH |
| ---: | ---: |
| 10_000 | 0.0001 |
| 100_000 | 0.001 |
| 1_000_000 | 0.01 |
| 10_000_000 | 0.1 |
| 100_000_000 | 1 |

## Timing

| Knob | Default | Role |
| --- | ---: | --- |
| `gatherMaxMs` | 120s | Max discover when peers already seen |
| `gatherAloneMs` | 35s | Manual Start: fail-fast if still alone |
| `gatherAloneAutoMs` | 120s | Auto: wait longer for peers |
| `gatherMinMs` | 10s | Min gather before locking a legal set |
| `gatherFastWarmupMs` | 5s | Warm-up when already at max |
| `smallSetHoldMs` | 20s | Extra hold after the last new peer below max |
| `peerSetStableMs` | 4s | Membership must be stable before lock |
| `peerSetStableFastMs` | 2.5s | Shorter stable at cap |
| `peakGraceMs` | 15s | Keep a faded peak before accepting shrink (EC `T_END_COMPS`) |
| `rendezvousMs` | 60s | Propose / ACK / start window |
| `proposalTimeoutMs` | 20s | First ACK wait leaves budget for a shrink re-propose |
| `rendezvousResendMs` | 1.2s | Re-send interval |
| `missingOutputsOnionMs` | 36s | Per peel hop |
| `credentialWaitMs` | 35s | Blind-credential wait |

Electron Cash server wire `T_*` values stay in `fusionTiming.ts`. Do not
move those here.

## How to retune later

1. Change `FUSION_KNOB_DEFAULTS` in `fusionKnobs.ts`.
2. Update this table in the same change.
3. Update [p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md) §4 if
   the lock / shrink story changes.
4. Restart **every** wallet window so all peers share one build. Mixed
   min/max (old window cap 8 vs new cap 10) cannot agree on a set.

Do not persist these per wallet. Old `p2pKnobs` keys in
`optn-wallet-fusion-policy` or redux-persist are ignored.
