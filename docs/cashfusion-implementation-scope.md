# CashFusion — current status

Both paths are **implemented** on desktop (Tauri). This file is the status map.
Wire details live in the protocol / knobs / privacy-layer docs.

| Path | Role | Status |
| --- | --- | --- |
| **P2P CashFusion** | Peer pool over Nostr + Tor; no fusion daemon | **Shipped in this lineage** — gather, v4 credentials, onion, Auto, ACK-shrink. Chipnet 10-way dogfooded. |
| **Server CashFusion** | Electron Cash–compatible TCP/TLS client in Rust | **Shipped** — EC-aligned client. Local Chipnet fusion-server self-test is the supported dogfood; do not invent a 5-joiner. |

**Platform:** Desktop only. Mobile/web cannot speak classic TCP fusion and say so.

**Funds safety:** Automated tests stay on **Chipnet / mocks**. Mainnet fusion is not a CI fixture.

**Enablement:** CashFusion is a **product** setting (Servers / CashFusion card), **not** Experimental. The per-wallet master switch defaults **off**. Auto Fuse and P2P mode default **on** once the wallet is enabled. Protocol floors/caps/timings are **not** wallet settings — see [p2p-cashfusion-knobs.md](./p2p-cashfusion-knobs.md).

This is **not** a third-party crypto audit. Design, tests, and the threat model are in-repo.

---

## Two paths, same outer loop

```text
                    ┌─────────────────────────┐
                    │   Wallet outer loop     │
                    │  FusionRunnerService    │
                    │  Manual + Auto, depth,  │
                    │  cooldown, lease        │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
   ┌─────────────────────┐             ┌─────────────────────┐
   │  P2P path (TS)      │             │  Server path (Rust) │
   │  platform/desktop/  │             │  src-tauri/src/     │
   │  nostr/* +          │             │  fusion/*           │
   │  FusionP2pService   │             │                     │
   └─────────────────────┘             └─────────────────────┘
         Tor + NIP-59                        Tor + TLS
         Nostr discovery                     Fusion server TCP
         Output onion                        Covert circuits
         Peer = elected issuer               Server issues blinds
```

P2P is a **different transport**, not a weaker crypto story.

---

## P2P (done)

| Piece | Reality |
| --- | --- |
| Pool discovery | Nostr replaceable kind **12230**, ephemeral identities |
| Tor | Fail-closed — no clearnet P2P fusion |
| Round traffic | NIP-59 gift-wrap kind **1059** |
| Gather / lock | **6** to lock, **10** cap, **4** ACK-shrink floor (`fusionKnobs.ts`) |
| ACK | First proposal waits for the set; missing ACKs may shrink to the ACKed remainder if still ≥4. Mid-onion / mid-sign cannot shrink. |
| Credentials | Protocol **v4** — `sha256(serialized EC Component)` (`fusionComponentV4.ts`) |
| Anonymous components | `inputs`, `outputs`, `onion_output`, `signature` — throwaway key + one-shot Tor. Coordinator does not take `from` as identity. |
| Control plane | ACK, `credential_request` (quota + Pedersen), ready, abort stay named — counts, not which UTXO |
| Output onion | Mandatory; mix needs ≥3 wallets (≥2 peelers). Hides who created which output from other peers. |
| Auto + fuse depth | `fusionAutoEngine.ts`, `fusionCoinDepth.ts` |
| Too many coins | Server path take-largest-3 + Auto pre-consolidate (`fusionPreConsolidate.ts`) |
| UI | CashFusion card + Servers. **No player-count knobs** in the wallet. |

**Normative docs:** [privacy-layers](./p2p-cashfusion-privacy-layers.md), [protocol](./p2p-cashfusion-protocol.md), [knobs](./p2p-cashfusion-knobs.md), [threat model](./THREAT_MODEL.md), [FAQ](./p2p-cashfusion-faq.md).
**Code:** `src/platform/desktop/nostr/` and `FusionP2pService.ts`.

Chipnet example (10-way): `7e41141a47ebe18496af131e51402019f41b602723c9ac4274aa0a91f52536f4`.

---

## Server (done)

Classic CashFusion is raw TCP + TLS + protobuf. The WebView cannot speak that stack; desktop uses the Rust client via Tauri.

| Piece | Code |
| --- | --- |
| Wire + hello | `mod.rs` |
| Pool / tiers / plan | `round.rs`, `session.rs`, `server_plan.rs` |
| Pedersen + blind Schnorr | `pedersen.rs`, `schnorr.rs` |
| Covert circuits | `covert.rs` |
| Blame / cancel | `blame.rs`, `round_cancel.rs` |
| Coin selection / tx | `components.rs`, `tx.rs` |
| Tor | `tor.rs`, `tor_manager.rs` |
| Full run | `run.rs` |

Wire constants still trace to Electron Cash (`connection.py`, `protocol.py`, vendored `src-tauri/proto/`).
**Code root:** `src-tauri/src/fusion/`.

A local Electron Cash fusion server may advertise a weaker `min_clients` for a 1-owner Chipnet self-test. That does **not** change P2P knobs.

---

## Shared product surface

| Concern | Where |
| --- | --- |
| Manual / Auto | `FusionRunnerService.ts` |
| P2P vs server | `FusionMode.ts`, CashFusion settings |
| Tor readiness | `FusionTorResolver.ts` |
| Completion / depth labels | `FusionCompletionService.ts` |
| Cross-window lease | `fusionWalletLease.ts` |
| Per-wallet on/off | `walletFusionPolicy.ts` (ignores leftover `p2pKnobs`) |

---

## Testing

| Kind | Where |
| --- | --- |
| P2P unit / multi-peer | `nostr/__tests__/fusion*.test.ts` |
| Rust crypto | `cargo test` under `src-tauri` fusion |
| Chipnet dogfood | Multi-window P2P or local fusion server — not a CI merge gate |

Never fuse mainnet funds in automated tests.

---

*Last updated: 2026-08-14. Shipped status: 6/4/10 knobs, ACK-shrink, v4
credentials, anonymous inputs/signatures, and CashFusion removed from
Experimental.*
