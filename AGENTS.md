# AGENTS.md

## Repository purpose

OPTN Wallet is a BCH wallet with CashTokens, CashScript, desktop, web, Android,
and iOS surfaces. Preserve wallet security and transaction correctness above
convenience.

## Working rules

- Inspect the relevant code and tests before editing.
- Make the smallest coherent change and follow existing patterns.
- Keep UI, transport, domain logic, persistence, and integrations separated.
- Validate external input and handle invalid input, stale state, retries,
  duplicate execution, partial failure, and permission errors explicitly.
- Do not expose, generate, log, or copy mnemonics, seed phrases, private keys,
  keystore passwords, wallet files, or production credentials.
- Do not run live-network, signing, broadcasting, deployment, release, or native
  packaging flows unless the task explicitly requires them and a human has
  approved that scope.
- Do not install dependencies or applications. Use the committed lockfile and
  the repository's existing toolchain.
- Do not modify `.env`, wallet files, keystores, generated artifacts, build
  output, CI workflows, or dependency manifests unless the task explicitly
  names the path and explains why.
- Never commit, push, tag, merge, publish, or release changes during an
  automated task.

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

Finish with changed files, checks run and their results, remaining risks, and
any manual review required. Leave source-repository changes unstaged and
uncommitted for human review.
