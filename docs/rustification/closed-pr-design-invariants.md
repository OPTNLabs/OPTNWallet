# Closed PR design history for Rustification

Snapshot: **2026-09-03**. The repository had **52 closed pull requests** at this
snapshot. The complete machine-readable ledger is
`rustification/closed-pr-history.toml`.

This document exists because the current wallet is the result of many merged,
rebuilt, superseded, and deliberately closed PRs. A Rust port that reads only
the current screen code can reproduce pixels while deleting hard-won product,
security, recovery, privacy, and release decisions.

## Interpretation rule

Use the history in this order:

1. **Current code and tests** describe what the wallet actually does today.
2. **Merged PRs** explain why that behavior exists and which edge cases were
   deliberately protected.
3. **Closed-unmerged PRs** are evidence, not authority. Follow a merged
   successor when one exists; otherwise verify the idea against current code
   before carrying it forward.
4. A historical invariant may be intentionally changed, but the change must be
   explicit, tested, and documented. Rustification is not permission to change
   product behavior accidentally.

The ledger is a snapshot rather than a live GitHub dependency so architecture
CI stays deterministic. Refresh it when closed PR history materially changes.

## High-value design invariants

| History | Preserve while moving authority to Rust |
| --- | --- |
| #4, #5, #6 | Desktop is an adapter/shell, not a second wallet. Platform-specific HTTP/files/menu/device behavior stays at the boundary. |
| #6 | No wallet is considered open merely because an id was persisted; per-wallet unlock authority and encrypted wallet-file semantics must survive. |
| #6 | Third-party add-ons run in an opaque-origin sandbox and reach wallet functions only through capability-scoped APIs. The iframe is isolation, not wallet authority. |
| #6 | Browser-extension work is constrained by popup/MV3 lifecycle. Never expose signing merely because a route happens to render. |
| #9, #10, #11 | Mainnet is the onboarding default, network selection is explicit, Chipnet derivation uses its correct BIP44 coin type, and wallet-open reconnect/history bootstrap is product behavior. |
| #15 plus current feature inventory | Derivation discovery must distinguish incomplete/failed scans from a confirmed empty path; only a complete unambiguous result can auto-select. |
| #26, #27, #31, #33 | CashFusion implementation and docs must agree. Protocol knobs do not become casual UI settings, and P2P missing-signature blame is an unnamed timeout, not abort disclosure. |
| #28 | CashConnect identity is separate from spend keys and chat Nostr identity. Exact outputs/fees/tokens/change and duplicate execution are review gates. |
| #29, #61 | Cash Code/RPA preserves network separation, compressed-key address derivation, legacy-paycode acceptance, capability tiers, and fail-closed unsupported-code behavior. |
| #32 | Automatic Fusion is opt-in and wallet-scoped; wallet changes disarm the session. Product readiness controls visibility of dev-only apps. |
| #34, #60 | SeedCash consumes raw PSBT bytes in `crypto-psbt` URs. `0xc1` sighash and camera-readable density are interoperability constraints, not styling preferences. |
| #35 | UTXO state must reconcile across workers, discovery, Electrum, wallet changes, and lifecycle events. Stale snapshots are never chain truth. |
| #50 | Native macOS edit semantics matter for connector URI fields; Cmd+C/V must remain normal platform behavior. |
| #53, #62 | Verify shipped artifacts, not merely build commands: exact versions/formats/architectures, signatures, Mach-O dependencies, and bundled helper executables are gates. |
| #58 | The Rust CLI is a first-class wallet/agent surface; domain behavior should converge with the same authoritative Rust core rather than fork. |

## Known successor lineages

These closed PR chains are easy for an agent to misread:

- **Desktop:** #4 → #5 → #6 → #50/#62.
- **CashFusion:** #7 → #17/#18 (stale) → **#26 merged**, with docs #27/#31/#33.
- **CashConnect:** #21 → **#28 merged**.
- **RPA:** #24 → **#29 merged** → **#61 protocol correction**.
- **SeedCash/watch-only:** #34 → **#60 conformance/density hardening**.
- **Quinn:** #44 stale → **#52 merged**.
- **Vite:** #45 stale → **#64 merged**.
- **React Router:** #40 v7 was not taken; #51 stayed on the v6 line for the
  legacy React surface.

A closed predecessor must never be used to overwrite its merged successor.

## Rustification mapping

When a historical behavior is ported:

```
protocol / transaction / derivation invariant
        → optn-core

wallet use-case / state transition / policy
        → optn-app

long-running sync / retry / lifecycle
        → optn-runtime

renderer-to-app request/result
        → optn-transport

OS / device / shell capability
        → optn-platform provider

presentation
        → optn-ui
```

Examples:

- The add-on iframe may remain as an isolation boundary, but privileged calls
  should terminate in typed Rust application/transport authority rather than
  legacy TypeScript wallet services.
- CoreNFC/Keychain/Tauri menu code stays native/platform-specific; BCH wallet
  truth does not move into Swift or Tauri.
- SeedCash QR rendering is UI, but PSBT bytes, sighash policy, UR semantics,
  and canonical vectors belong below the renderer.
- Fusion UI labels are presentation; participant thresholds, signing,
  cancellation, privacy routing, and transaction integrity are protocol/app
  behavior.

## Agent work rule

Before replacing or deleting an existing wallet feature, search
`rustification/closed-pr-history.toml` for the feature name and inspect the
listed PR lineage. If the port intentionally changes a historical invariant,
record the reason and evidence in the same PR instead of silently treating the
old behavior as accidental.
