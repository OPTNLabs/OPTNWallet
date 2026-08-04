# Task

Fix the missing test providers in `src/components/__tests__/Bip44AccountPathFields.test.tsx` without changing production behaviour.

# Scope

- Update only the failing test setup and its directly related test helpers.
- Keep the production component and wallet behavior unchanged.

# Constraints

- Do not modify dependency manifests, lockfiles, workflows, `.env` files,
  wallet files, signing code, transaction construction, or generated output.
- Do not run live-network tests, native builds, signing, broadcasting, or other
  external-infrastructure flows.
- Do not commit, push, tag, merge, publish, release, or deploy.

# Validation

- Run the focused test for `Bip44AccountPathFields`.
- Report the focused test result and any additional checks that were run.

# Completion

- Explain the root cause briefly.
- List changed files.
- Leave the isolated working tree uncommitted for human review.
