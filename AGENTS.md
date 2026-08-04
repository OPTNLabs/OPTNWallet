# AGENTS.md

## Repository purpose

OPTN Wallet is security-sensitive BCH wallet software with CashTokens,
CashScript, desktop, web, Android, and iOS surfaces. Preserve wallet security
and transaction correctness above convenience.

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
- Never commit, push, tag, merge, publish, or release changes during an
  automated task. Do not create pull requests.

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
