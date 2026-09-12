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

CI uses Node.js 22.23.2. Node.js 22.12 or a supported newer LTS is required by
the maintained browser-download tooling; Node 20 is no longer a supported build
runtime. This build-tool requirement does not change wallet platform targets.

The scoped `@wdio/utils` override pins `@puppeteer/browsers` 3.2.2 to remove
the vulnerable `extract-zip` downloader. Its ESM and Node >=22.12 requirements
are intentional: WDIO uses ESM and its seven imported browser APIs remain
available. Both npm and Yarn browser launch/download paths were exercised on
Node 22.23.2. The matching Yarn resolution preserves the secondary lockfile;
npm remains canonical. Remove the override when WDIO's published range includes
the maintained downloader. See the
[browser-tool changelog](https://github.com/puppeteer/puppeteer/blob/browsers-v3.2.2/packages/browsers/CHANGELOG.md).

Other reviewed transitive pins are `uuid` 11.1.1 for Keystone's UUID parser
and the top-level-await plugin's deterministic v5 identifiers, `diff` 8.0.4
for Mocha's two reporting APIs, and Vite 7.3.6 for the Vitest/vite-node graph.
The latter accepts patched esbuild 0.28; the application remains on Vite 8.
Yarn resolutions mirror these repairs, including the existing Ledger UUID
overrides. Consumer vectors match before/after, and short UUID output buffers
are now rejected without mutation. Review the callers again when removing pins.

Yarn does not apply npm `overrides`. Keep matching `resolutions` for security
updates to the secondary lockfile, and regenerate it with Yarn rather than
editing entries manually. Protobuf is pinned to the same 8.7.0 runtime as the
npm lockfile; Axios and the Mocha serializer use the same patched ranges as npm.
The hardware codec test checks BCH address requests and 64-bit transaction
amounts without connecting to a device. Audit both lockfiles after changing
these pins; a clean npm audit does not validate `yarn.lock`.

## Required checks

- `npm run deps:check` verifies package-manager metadata, lockfile format, and
  direct dependency/lockfile synchronization.
- `npm audit --omit=dev --audit-level=critical` blocks critical production
  vulnerabilities in CI.
- `npm run security:audit:all` blocks high and critical vulnerabilities across
  the full dependency graph, including development and end-to-end tooling.
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
   references in `package.json`. An in-tree `file:vendor/...` pin is allowed
   when npm does not publish the required MLS-extensions-draft APIs.
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
