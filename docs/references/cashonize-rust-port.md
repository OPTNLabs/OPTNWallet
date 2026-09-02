# Cashonize as an OPTN Rust-port reference

Cashonize is an important BCH product/behavior reference for OPTN, but its implementation stack is
not the target architecture. Cashonize is currently a Vue 3 + TypeScript + Pinia + Quasar wallet
using mainnet-js/libauth and JavaScript protocol libraries, with Electron/Capacitor platform shells.
OPTN should preserve useful behavior while translating ownership into the Rust architecture.

## Rule

**Reference behavior, UX, invariants, protocol semantics, and test cases. Do not copy the framework
boundary.**

A Cashonize-inspired feature must be mapped before implementation:

| Cashonize concern | OPTN Rust owner |
| --- | --- |
| wallet/key/derivation rules | `optn-core` |
| transaction construction, fees, change, CashTokens | `optn-core` |
| UTXO reservation/freeze policy | `optn-core` + `optn-app` |
| wallet state/use-cases | `optn-app` |
| async sync/watch/reconciliation | `optn-runtime` |
| secure storage/camera/NFC/clipboard/etc. | `optn-platform` provider |
| renderer state adaptation | `optn-transport` |
| screens/components | `optn-ui` (Leptos/Rust today) |
| Tauri/OS integration | adapter/provider only |

## What is worth learning from Cashonize

- CashTokens-first send/receive flows for fungible tokens and NFTs.
- HD wallet address management, address labels/marks, and fresh-address behavior.
- UTXO management: freeze/reserve coins, labels, consolidation and token/BCH separation.
- "Transfer all assets" ordering: tokens/NFTs before BCH because later token transactions need BCH fees.
- Transaction history UX with token deltas, dApp attribution, notes and direction classification.
- dApp connection UX across WalletConnect, CashConnect and WizardConnect.
- Transaction previews that explain BCH and token balance changes before signing.
- BCMR metadata and parsable-NFT behavior.
- Portfolio/DeFi discovery patterns and explicit backend trust assumptions.
- Stale-chain-state handling: UTXO/state snapshots are caches and must be revalidated before signing.
- Multi-wallet and per-wallet/per-network metadata semantics.

## What must not be inherited

Do not reproduce these as OPTN architecture:

- Vue components as application state owners.
- Pinia stores as wallet source of truth.
- Quasar/Electron/Capacitor as domain dependencies.
- `mainnet-js` as the authoritative wallet implementation.
- JavaScript libauth calls as the long-term transaction/signing core.
- stringly typed protocol/action bags where Rust enums/records can encode valid states.
- localStorage/IndexedDB schemas as the new authoritative persistence model.
- direct dApp/protocol libraries mutating renderer state.

## Porting workflow

For every referenced feature:

1. Identify the exact Cashonize behavior and edge cases.
2. Read its tests and implementation only to understand observable semantics.
3. Create language-neutral fixtures/vectors where possible.
4. Write characterization tests against the existing OPTN/Cashonize-equivalent behavior.
5. Define typed Rust domain models and invariants.
6. Implement the behavior in the correct Rust crate.
7. Build the Leptos view over typed app state/actions/events.
8. Run differential/parity tests.
9. Only then retire the old TypeScript implementation for that feature.

The migration is not complete if the screen merely looks the same. Rust must own the behavior.

## Protocol libraries

If Cashonize uses a JavaScript-only library (for example a dApp transport), treat that library as a
protocol reference, not permission to move the new application back into JavaScript. Prefer a native
Rust implementation. If a temporary bridge is unavoidable, keep it outside core/app/runtime, expose
only a typed Rust-facing contract, and record the replacement as migration debt.

## Licensing/provenance

Cashonize is MIT licensed. Behavior/specification can be independently reimplemented. When source
code is actually ported or substantially adapted, preserve the applicable upstream copyright/license
notice and document provenance instead of silently copying code.
