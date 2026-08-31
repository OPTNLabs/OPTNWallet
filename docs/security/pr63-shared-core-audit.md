# PR #63 shared-core security audit

Date: 2026-08-31

## Executive summary

This focused review covered the PR's Rust/WASM RPA implementation, Rust-native and browser CashFusion primitives, generated WASM boundary, cross-platform feature gates, and nearby navigation boundary. It did not exercise a live network, sign a real transaction, or broadcast funds.

Two exploitable boundary defects were found and fixed in this branch: an integer-overflow panic in the Rust raw-transaction parser and an untrusted internal return route that could reach a known React Router 6 open-redirect class. The shared-core design otherwise fails closed on malformed keys, scalars, commitments, signatures, cashcodes, and transaction bytes. Production dependency audit reports no high or critical advisories; unresolved lower-severity upstream risks are recorded below.

## Findings

### PR63-SEC-01 — overflowing transaction script length could panic the RPA scanner

- Severity: Medium
- Status: Fixed
- Evidence: the parser boundary at `crates/optn-core/src/rpa.rs:583` now uses checked addition. Before the fix, a CompactSize value of `u64::MAX` overflowed before the truncation decision. `crates/optn-core/src/rpa.rs:930` reproduces the malformed transaction.
- Impact: an untrusted raw candidate transaction could panic the Rust/WASM scanner instead of returning no match, interrupting wallet receive scanning. No key disclosure or false-positive payment match was observed.
- Fix: all parser bounds use checked addition; CompactSize script lengths are fallibly converted to the platform's `usize`; the regression proves the malformed input returns an error without panicking.
- Residual mitigation: callers continue treating parse failure as “not a match,” and no Electrum fallback is introduced.
- False-positive notes: this was reproduced as a Rust test panic before the fix and is not a source-only suspicion.

### PR63-SEC-02 — query-controlled return route could cross the app-origin boundary

- Severity: Medium
- Status: Fixed
- Evidence: `src/utils/navigation.ts:25` and `src/utils/navigation.ts:32` read `returnTo` from router state and the query string. React Router 6 is affected by GHSA-wrjc-x8rr-h8h6, including backslash-based external navigation. Regression cases begin at `src/utils/__tests__/navigation.test.ts:21`.
- Impact: a crafted deep link could make a Back action navigate outside the wallet origin, enabling phishing after a user-visible interaction.
- Fix: `src/utils/navigation.ts:7` now accepts only `/`-rooted app paths and rejects scheme-relative, literal-backslash, encoded-backslash, control-character, scheme, and relative targets. The watch-only send back action now uses the same boundary.
- Residual mitigation: the dependency remains on React Router 6 because the upstream patched line is Router 7 and requires a separate migration. New dynamic return routes must use `getReturnPath`.
- False-positive notes: the vulnerable inputs were observed returning unchanged before the fix; all eight boundary tests pass after it.

### PR63-SEC-03 — upstream `elliptic` signing advisory has no patched release

- Severity: Low
- Status: Accepted upstream risk; monitor
- Evidence: `npm audit --omit=dev` traces `elliptic <= 6.6.1` through `@trezor/connect-web` and reports GHSA-848j-6mx2-7j84. The advisory currently lists no patched version.
- Impact: the affected ECDSA implementation can produce a rare faulty signature and, given both faulty and correct signatures for the same input, may expose a key. The dependency belongs to the external Trezor integration; PR #63's RPA and CashFusion cryptography use Rust `k256`/WASM instead.
- Recommended fix: upgrade or replace the Trezor dependency when its maintainer ships a compatible implementation. Do not fork or mechanically port the external library inside this PR.
- Mitigation: hardware wallet support remains desktop-only in the capability matrix; users must confirm transaction details on the hardware device.
- False-positive notes: the vulnerable package is present in the production dependency graph, but this review did not establish that OPTNWallet invokes its affected signing path.

### PR63-SEC-04 — development toolchain contains high-severity availability/path risks

- Severity: Low for shipped wallet; High within an exposed build environment
- Status: Open, isolated from runtime
- Evidence: the all-dependency audit reports `deepmerge-ts < 8.0.0` through WebdriverIO and a vulnerable `extract-zip` through Puppeteer tooling. Root `esbuild 0.27.7` also has a Windows development-server file-read advisory fixed in 0.28.1.
- Impact: malicious recursive configuration or archives can crash or escape a development/CI process; an exposed Windows development server can read outside its served directory. These packages are not in the production-only high/critical result.
- Recommended fix: update WebdriverIO, Puppeteer/archive tooling, and the Vite/esbuild toolchain in a dedicated dependency PR with clean installs and full desktop/mobile CI.
- Mitigation: do not expose development servers to untrusted networks, do not feed untrusted archives/configuration to CI, and keep build workers disposable and least-privileged.
- False-positive notes: `npm audit --omit=dev --audit-level=critical` exits successfully; this finding concerns build/test dependencies rather than the shipped wallet runtime.

### PR63-SEC-05 — lower-severity upstream router and UUID advisories need isolated upgrades

- Severity: Low in the reviewed wallet paths
- Status: Accepted upstream risk; monitor
- Evidence: the production audit reports React Router's SSR hydration constructor-injection advisory GHSA-337j-9hxr-rhxg and `uuid`'s caller-provided-buffer bounds advisory GHSA-w5hq-g745-h8pq through Keystone.
- Impact: this client-only wallet does not use React Router's SSR error hydration path, and the reviewed Keystone integration does not pass caller-owned output buffers to UUID helpers. No reachable exploit was reproduced in these paths.
- Recommended fix: migrate React Router and the Keystone dependency tree in dedicated compatibility PRs; both changes need broader route and hardware-wallet validation than this shared-core PR.
- Mitigation: the open-redirect use of React Router is locally constrained by the fixed internal-route validator, and Keystone remains behind the desktop-only capability gate.
- False-positive notes: the vulnerable packages are present, so this is not a claim that the advisories are absent—only that their affected APIs were not observed in the reviewed paths.

## Validation evidence

- Rust shared core vectors cover RPA key derivation, cashcode encoding, ECDH, spending keys, raw transaction matching, blind Schnorr, and Pedersen commitments.
- TypeScript RPA key derivation was disabled in a boundary test; Rust/WASM still produced scan/spend private and public keys and a valid Chipnet cashcode.
- Rust zeroizes its normalized mnemonic, seed, derived RPA key structure, and WASM transfer buffer; the TypeScript adapter erases the packed caller-owned buffer after copying the required key arrays.
- Ten in-memory peers converged on one CashFusion transaction, with exactly one simulated broadcast callback; libauth's BCH 2023 VM accepted all ten inputs and ten outputs.
- Native Tauri library tests ran with only `bundle.resources` removed through Tauri's JSON config merge: 140 passed, 4 explicitly ignored live-network tests.
- The only new JavaScript file is generated `wasm-bindgen` glue. Handwritten integration and build tooling are TypeScript; protocol and cryptographic logic are Rust.

## Audit limitations

- Repository policy forbids live-network tests, real signing, broadcasting, and changes to bundled Tor resources.
- `cargo-audit` is not installed locally. The updated Rust locks still require the repository's remote Cargo Audit check after push.
- Windows cannot compile the iOS native project locally. The common web bundle and Rust/WASM core are validated locally; iOS compilation remains a remote macOS CI gate.
