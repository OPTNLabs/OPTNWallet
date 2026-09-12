# AGENTS.md

## Repository purpose

OPTN Wallet is security-sensitive BCH wallet software with CashTokens,
CashScript, desktop, web, Android, and iOS surfaces. Preserve wallet security
and transaction correctness above convenience.

## Rustification architecture

For architecture changes, read `RUSTIFICATION.md` and the affected entries in
`rustification/components.toml`. Before migrating or deleting behavior, consult
`docs/rustification/closed-pr-design-invariants.md` and its relevant lineage in
`rustification/closed-pr-history.toml`. For UI work, use the canonical project
skill `.claude/skills/ui-ux-product/SKILL.md` and `docs/ui-overhaul/` references.
For #71/#75 continuation, reconcile `docs/pr63-requirement-ledger.md` with the
current issue requirements, PR head, code and evidence; historical handoffs are
context, not proof of completion. #84 coordinates the Vitest dependency migration.

Framework boundary rules are architectural invariants:

- `optn-core`, `optn-app`, `optn-runtime`, `optn-transport`, and `optn-platform` must not depend on Leptos,
  Tauri, Dioxus, Capacitor, or another UI/native framework.
- `optn-ui` may depend on `optn-app`, but must not bypass it to reach
  `optn-core` directly.
- Tauri-specific code belongs in adapters. Do not move wallet/business logic
  into Tauri commands or plugins.
- Leptos-specific signals, routes, and lifecycle types must not leak into
  `optn-app`.
- GUI and CLI are independent interfaces to the same Rust application/runtime.
  CLI must not depend on Leptos or Tauri. Browser/extension restrictions and
  addon permissions remain enforced by the shared capability contracts.
- Capability visibility, experimental opt-in, platform availability and
  execution permission are separate. Consume canonical Rust policy instead
  of duplicating platform defaults in skills or renderer checks.
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
- Protect `.env`, wallet files, keystores, recovery phrases, private keys,
  session data and application-data directories. Access only the specific
  test material authorized for the task; never print or commit secrets.
- Production credentials, mainnet signing/spending and production publishing
  require their own explicit authorization. Chipnet authorization never
  authorizes mainnet activity. Verify network and spend scope before signing.
- Local fixtures, disposable test state, affected checks and requested debug
  packages are within an implementation task. Use existing tools and locked
  dependencies first; necessary setup must stay within the requested scope.
- Continue within existing user authorization, including requested live
  Chipnet tests, commits and pushes. Ask only when an action exceeds it.
- Do not weaken tests, lint rules, type checks, or security controls to make
  checks pass.
- Fix security findings and rerun the affected scanner. Do not dismiss alerts,
  suppress findings, remove coverage or drop platform/CI gates to obtain green.
- CashScript source files may be edited only when explicitly in scope.
- Generated CashScript artifacts must not be manually edited.
- CI/workflow, manifest and Tor packaging changes are allowed when necessary
  for the requested repair; preserve signatures, supply-chain verification,
  supported targets and existing required gates. Regenerate artifacts through
  their established tooling rather than manually editing generated output.
- Preserve concurrent edits. Compare the actual PR head before integration;
  equivalent cherry-picked commits must not be replayed over newer fixes.
- Review the exact staged scope, then commit and push completed fixes in small
  batches when requested. Do not force-push or include unrelated work.

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

Run the narrowest relevant check first. Rust changes use affected crate tests,
formatting and Clippy with the supported feature/target matrix. Run
`cargo run -p xtask -- architecture` for boundary changes. Then run the existing
integration/platform gates required by the milestone. Do not assume
`--all-features` represents a valid shipping configuration.

Preserve the legacy and repository-level checks where applicable:

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
review only when committing was not requested.

Continue through the requested connected milestone: shared backend flow,
persistence and wallet state, interface wiring, UI, then platform verification.
For wallet sync, prove source selection, balance/history, restart and resume
through the shared Rust runtime in GUI and CLI. Distinguish component tests,
application integration, live workflow evidence and packaged-platform evidence;
one does not substitute for another. Record revision, environment and remaining
gaps in the existing requirement ledger rather than creating competing trackers.
