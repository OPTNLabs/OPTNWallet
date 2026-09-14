# AGENTS.md

## Repository purpose

OPTN Wallet is security-sensitive BCH wallet software with CashTokens,
CashScript, desktop, web, Android, and iOS surfaces. Preserve wallet security
and transaction correctness above convenience.

## Rustification architecture

Before Rustification or UI-shell work, read `RUSTIFICATION.md`,
`rustification/components.toml`, `rustification/closed-pr-history.toml`, and
`docs/rustification/closed-pr-design-invariants.md`. Closed PR history records
product/security decisions that must not disappear merely because the renderer
or implementation language changes.

Framework boundary rules are architectural invariants:

- `optn-core`, `optn-app`, and `optn-platform` must not depend on Leptos,
  Tauri, Dioxus, Capacitor, or another UI/native framework.
- `optn-ui` may depend on `optn-app`, but must not bypass it to reach
  `optn-core` directly.
- Tauri-specific code belongs in adapters. Do not move wallet/business logic
  into Tauri commands or plugins.
- Leptos-specific signals, routes, and lifecycle types must not leak into
  `optn-app`.
- Run `cargo run -p xtask -- architecture` after changing these layers.

## External wallet references

Reference wallets are behavioral and architectural oracles, not implementation-stack templates.

- Cashonize may be used to learn BCH UX, CashTokens behavior, dApp flows, HD/address management,
  transaction previews, UTXO tools, portfolio behavior, and protocol edge cases.
- Do **not** import Cashonize's Vue, Pinia, Quasar, Capacitor, Electron, mainnet-js, libauth-JS,
  WalletConnect-JS, CashConnect-JS, or WizardConnect-JS architecture into the Rust target.
- For a Cashonize-inspired feature, first characterize behavior and extract test vectors, then place:
  domain/transaction/protocol logic in `optn-core`, use-cases/state/actions/events in `optn-app`,
  long-running work in `optn-runtime`, native capability calls behind `optn-platform`, and rendering
  in Rust/Leptos under `optn-ui`.
- TypeScript/JavaScript from reference wallets may be used as a parity oracle during migration, but
  must not become the authoritative implementation for new Rust-target functionality.
- A temporary JS bridge for a protocol with no Rust implementation requires explicit approval,
  must sit behind a typed Rust contract, and must have a tracked Rust replacement plan.
- Preserve upstream license/attribution when code is actually ported rather than independently
  reimplemented from behavior/specification. See `docs/references/cashonize-rust-port.md`.

## Working rules

- Inspect the relevant code and tests before editing.
- Make the smallest coherent change and follow existing patterns.
- Do not modify unrelated files.
- Keep UI, transport, domain logic, persistence, and integrations separated.
- Validate external input and handle invalid input, stale state, retries,
  duplicate execution, partial failure, and permission errors explicitly.
- Do not read `.env`, `.env.*`, wallet files, keystores, signing credentials,
  recovery phrases, private keys, WalletConnect session data, or desktop
  application-data directories.
- Do not access production credentials. Do not expose, generate, log, or copy
  sensitive wallet material.
- Do not sign or broadcast transactions. Do not run live-network tests.
- Do not run release, publishing, deployment, installation, or production-
  signing commands.
- Do not install dependencies or applications. Use the committed lockfile and
  the repository's existing toolchain.
- Do not weaken tests, lint rules, type checks, or security controls to make
  checks pass.
- CashScript source files may be edited only when explicitly in scope.
- Generated CashScript artifacts must not be manually edited.
- Do not modify prohibited files, generated artifacts, build output, CI
  workflows, or dependency manifests unless the task explicitly names the path
  and explains why.
- Local commits are permitted when the user explicitly requests them for the
  current task, after reviewing the exact staged scope.

The following paths are prohibited unless the task explicitly scopes them and
a human is handling the work manually:

```text
.env
.env.*
*.jks
*.keystore
android/key.properties
android/app/google-services.json
src-tauri/resources/tor/
wallets/
*.optn
.github/workflows/
```

## BCH and transaction safety

- Model UTXOs as discrete state objects and transactions as state transitions.
- Validate BCH value and token state separately.
- Prove input/output correctness, change behavior, token category and amount,
  and required successor outputs before allowing a spend.
- Treat chain state as authoritative; model intent, build, sign, broadcast,
  mempool, confirmed, and finalized stages explicitly when relevant.
- Prevent duplicate approvals, builds, broadcasts, and double spends.
- Fail closed when an invariant cannot be proven.

## Validation

Run the narrowest relevant check first. For the repository-level checks, use:

```text
npm run deps:check
npm run format:check
npm run typecheck:core
npm run addons:validate
npm run security:test
npm run lint:core
npm run test:core
npm run test:ui
```

Do not claim success without actual command output. Distinguish pre-existing
failures from regressions introduced by the task.

## Reporting

Finish with a clear implementation and validation report containing changed
files, checks run and their results, remaining risks, and any manual review
required. Leave source-repository changes unstaged and uncommitted for human
review.
