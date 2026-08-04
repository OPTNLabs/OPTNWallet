# Task

Fix the missing test providers in `src/components/__tests__/Bip44AccountPathFields.test.tsx` without changing production behaviour.

# Scope

- Update only the failing test setup and its directly related test helpers.
- Keep the production component and wallet behavior unchanged.

# Out of scope

- Key handling, seeds, signing, wallet files, and recovery phrases.
- WalletConnect session data, transactions, CashTokens, contracts, and
  CashScript artifacts.
- Android, Tauri, iOS, desktop application-data directories, and native code.
- External services, production credentials, and live-network tests.

# Acceptance criteria

- The focused test passes with the required providers present.
- Production behavior and the component under test remain unchanged.
- No unrelated files are modified.

# Validation

- Run the focused test for `Bip44AccountPathFields`.
- Report the focused test result and any additional checks that were run.

# Constraints

- Do not modify dependency manifests, lockfiles, workflows, `.env` files,
  keystores, signing code, transaction construction, or generated output.
- Do not run native builds, signing, broadcasting, or other external-
  infrastructure flows.
- Do not commit, push, tag, merge, publish, release, deploy, or create a pull
  request.
