# CashFusion — implementation status

> **Status:** **Feature-complete for PR #12 engineering scope; production
> clearance still requires Chipnet soak + remaining gates** (blame soak under
> Tor, optional EC component-plane v4 cutover — see
> `docs/p2p-ec-component-plane-v4.md`, `CLAUDE-A-TO-Z.md`). Both paths below are
> implemented and unit-tested. Do not treat older “NOT STARTED” language as current.
>
> **P2P architecture (read first):**  
> [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md)  
> [p2p-cashfusion-protocol.md](./p2p-cashfusion-protocol.md)  
> [THREAT_MODEL.md](./THREAT_MODEL.md)

---

## What “finished” means

| Path | Role | Status |
|------|------|--------|
| **P2P CashFusion** | Peer pool over Nostr + Tor; no fusion daemon required | **Implemented** — full round + Auto; production soak / v4 EC binding still open |
| **Server CashFusion** | Classic Electron Cash–compatible TCP/TLS client in Rust | **Implemented** — EC-aligned client; live Chipnet EC server interop not proven here |

**Platform:** Desktop (Tauri). Mobile/web cannot speak classic TCP fusion; they
surface a clear platform limit rather than a fake WSS probe.

**Funds safety:** Automated tests stay on **Chipnet / mocks**. Live mainnet
fusion is not a CI fixture. Prefer Chipnet when dogfooding.

**Enablement:** Feature is product-ready. Users turn fusion on per wallet /
settings (global experimental default may still be off until opted in).

This is **not** a claim of third-party formal crypto audit. Design + tests +
threat model are in-repo; external audit is optional follow-on work.

---

## Two paths, same privacy goals

```
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

P2P is a **different transport**, not a weaker crypto story. See privacy-layers.

---

## Path A — P2P (peer-to-peer) — DONE

| Piece | Implementation |
|-------|----------------|
| Pool discovery | Nostr replaceable kind **12230**, ephemeral identities |
| Tor fail-closed | No clearnet P2P fusion |
| NIP-59 gift-wrap | Round traffic kind **1059** |
| Gather / lock | MIN **3** / MAX **6**, full-set ACK |
| Blind Schnorr + Pedersen | `fusionBlindSchnorr.ts`, `fusionPedersen.ts` |
| Output onion (mandatory) | `onionCrypto.ts` + `fusionSession.ts` — **not Tor** |
| Assemble / sign / broadcast | `fusionRound.ts`, `fusionSign.ts` |
| Blame | Prove-or-don't-blame (`fusionBlame.ts`) |
| Auto + fuse depth | `fusionAutoEngine.ts`, `fusionCoinDepth.ts` |
| UI | CashFusion settings, P2P panel, Auto controls |

**Normative docs:** privacy-layers + protocol.  
**Code root:** `src/platform/desktop/nostr/` and `FusionP2pService.ts`.

---

## Path B — Server (classic Electron Cash) — DONE

| Piece | Was “Phase 2 plan” | Implementation |
|-------|--------------------|----------------|
| Wire + hello | Phase 1 | `mod.rs` framing, ClientHello / ServerHello |
| Pool join + tiers | Phase 2.1 | Round/session + server plan |
| Pedersen + blind Schnorr | Phase 2.2 | `pedersen.rs`, `schnorr.rs` |
| Covert connections | Phase 2.3 | `covert.rs` |
| Round state + blame | Phase 2.4 | `round.rs`, `blame.rs`, `round_cancel.rs` |
| Coin selection / fees | Phase 2.5 | `components.rs`, `server_plan.rs`, `tx.rs` |
| Tor | Phase 3 | `tor.rs`, `tor_manager.rs` |
| Full run | — | `run.rs`, `session.rs` |

**Wire constants** still trace to Electron Cash (`connection.py`, `protocol.py`,
`fusion.proto` vendored under `src-tauri/proto/`).

**Code root:** `src-tauri/src/fusion/`.

**Why Rust:** Classic CashFusion is raw TCP + TLS + protobuf. A WebView cannot
speak that stack; desktop uses the Rust client via Tauri.

---

## Shared product surface

| Concern | Where |
|---------|--------|
| Manual / Auto entry | `FusionRunnerService.ts` |
| Mode selection (P2P vs server) | `FusionMode.ts`, settings UI |
| Tor readiness | `FusionTorResolver.ts`, status services |
| Completion / depth labels | `FusionCompletionService.ts`, coin depth |
| Cross-window lease | `fusionWalletLease.ts` |

---

## Testing

| Kind | Examples |
|------|----------|
| P2P unit / multi-peer | `nostr/__tests__/fusion*.test.ts`, runner/depth/lease tests |
| Rust crypto | `cargo test` fusion schnorr / pedersen |
| Live hello (optional) | `cargo test --test fusion_live -- --ignored` (third-party host) |
| Chipnet dogfood | Manual multi-window P2P or local fusion server — not required green in CI |

Never fuse mainnet funds in automated tests.

---

## Historical note

Earlier revisions of this file described **Phase 1 only** (hello handshake) and
**Phase 2/3 as NOT STARTED**. That was accurate for an early PR slice. The
modules listed above and the P2P stack under `nostr/` close that plan for
PR #12. Prefer the privacy-layers and protocol docs for ongoing maintenance;
keep this file as the **status + map of both paths**.

---

*Last updated: PR #12 ship status — P2P + server CashFusion implemented.*
