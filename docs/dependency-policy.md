# Dependency policy

## Automated checks

`npm run deps:check` validates package-manager and lockfile consistency.
`npm run licenses:check` blocks disallowed or undocumented direct dependencies
and reports transitive findings for review. The security workflow also runs
dependency auditing and publishes a CycloneDX SBOM for each run.

This repository uses npm as its canonical package manager. `package-lock.json`
is the lockfile used by CI and release builds; contributors must use `npm ci`
for clean installs and commit lockfile changes together with `package.json`
changes.

## Required checks

- `npm run deps:check` verifies package-manager metadata, lockfile format, and
  direct dependency/lockfile synchronization.
- `npm audit --omit=dev --audit-level=critical` blocks critical production
  vulnerabilities in CI.
- High and moderate advisories require review before a release promotion. Do
  not run `npm audit fix --force` on wallet, signing, or native dependencies
  without reviewing the resulting behavior and lockfile diff.
- Use `npm ci --ignore-scripts` when auditing dependency installation. Native
  and release builds may use the normal install because the repository's
  `postinstall` patch step is part of the supported build.

## Adding or changing a dependency

1. Prefer a maintained package with a compatible license and published
   integrity metadata.
2. Keep direct specs reviewable; do not use `latest`, wildcard, URL, or Git
   references in `package.json`.
3. Put runtime packages in `dependencies` and test/build-only packages in
   `devDependencies`.
4. For crypto, wallet transport, transaction, and native packages, include a
   focused regression test and verify web, Android, and desktop build impact.
5. Use `overrides` for a documented transitive security or compatibility pin;
   do not hide an incompatible major upgrade in an override.
6. Run `npm run deps:check`, `npm run security:ci`, and `npm run verify` before
   opening a pull request.

The dependency policy deliberately does not prescribe ownership or approval
rules; those remain a small-team workflow decision.
