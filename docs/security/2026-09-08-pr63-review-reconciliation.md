# PR63 bot and security review reconciliation — 2026-09-08

Reviewed source head `3488efc1c61fdc871c104974781aa3b40436b78e`, all 109 review
threads (39 unresolved), 15 submitted reviews and nine issue comments. All
unresolved threads are CodeQL; seven CodeRabbit inline threads were already
resolved, but their fixes and review-body findings were checked again.

The latest pre-fix Rust analysis is `1740539113`, merge commit
`fc87aeb1bf399867fbf732e81642b66bc9adae6b`, CodeQL 2.26.4. Its PR-ref inventory
contains **41 open alerts**. This review made no dismissal, suppression,
resolution, scanner exclusion or advisory-allowlist change. The API also records
48 historical dismissals on September 5–6; those predate this review and are
not counted as fixes. Four production RNG/password reports, #86 and #103–105,
are automatically fixed with null dismissal timestamps.

After pushing `c7b013deaee412ff2958d106b7982447d21dca77`, Rust analysis
`1740807108` on merge `a7ad16e09c45c391c7a3ba6ba5aa6c108f08908f` automatically
marked #125 fixed, with a null dismissal timestamp. The PR now has **40 open
alerts**; the four exported #126 flows still contain the cross-command and
successful-password-result paths described below. No new open alert appeared.

## Open-alert disposition

| Alerts         | Current evidence and action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #82–85, #87–93 | CLI checkpoint integration test and runtime HD restart fixtures: public passwords, salt and nonces. Native writes use fallible OS randomness. The real-file test checks distinct ciphertext/revisions and stale/wrong-key refusal; the HD test checks every-byte tampering and malformed authenticated envelopes. Kept explicit fixtures and all scan rules.                                                                                                                                                                                                                                   |
| #94–102        | `wallet_file.rs` test module: independent legacy ciphertext/password-rotation vector and empty/short/mismatched password-policy boundaries. These cases cannot be randomized without changing their purpose. Both tests pass.                                                                                                                                                                                                                                                                                                                                                                  |
| #106–107       | Published BIP39 empty-password fixture and the in-memory checkpoint provider's incremented write nonce, both within test modules. The counter is not a production entropy provider.                                                                                                                                                                                                                                                                                                                                                                                                            |
| #108–112       | Authenticated checkpoint-codec tests covering offline allocation, malformed provenance and legacy branch-2 migration. Distinct fixture sequences remain explicit.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| #113–124       | GLib boolean and pointer-conversion reports. Concrete Rust return types/C output contracts do not follow the reported cross-type paths. Source and exported SARIF reviewed; no arbitrary unsafe-caller safety claim. [Detailed paths](2026-09-08-pr63-glib-codeql.md).                                                                                                                                                                                                                                                                                                                         |
| #125           | Found a real destructor-unwind edge case at the reported truncation method. Reuse `pop()` to restore the null terminator before destruction. Added a normal/panicking-drop regression and an optimized Linux CI check. Automatically marked fixed by analysis `1740807108`; the optimized Linux regression passes.                                                                                                                                                                                                                                                                             |
| #126           | New CLI cleartext-logging report at `main.rs:638`. Exported flows jump from successful `?` expressions to a returned command result without identifying a secret field. The wallet console's final result contains `ok`, `locked` and the public sync view after locking. Interactive password branches cannot execute in `--stdio`; rescan is a different command. `WalletSecurityStatus` has no credential field. Real-process tests verify public responses and absence of passwords/mnemonics; added malformed/wrong/oversized-input checks. No scanner model changed; alert remains open. |

#126 has 13 linked source locations but four exported representative code flows.
The other source locations were also inspected: hidden prompt/managed password
results enter credential requests; xpub/address results construct public wallet
observations. This review does not claim CLI output is safe to publish: requested
addresses/history are wallet metadata, and the separate explicit `new` command
intentionally returns a newly generated recovery phrase. No new phrase was
generated during this review.

## Bot findings reconciled

| Finding                                                      | Result                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kani resolution inputs / Rust-quality native-source triggers | Existing root manifests/lock and native-source filters remain. No trigger or platform removed.                                                                                                                                                                                                                                                                |
| Fusion vector regeneration races readers                     | Readers use in-memory vectors during regeneration; all sibling callers checked. Five stored-vector tests pass.                                                                                                                                                                                                                                                |
| Keystone multipart scanner                                   | `continuous` reaches the shared scanner; landing and signed-PSBT callers retain it. Preview/parser component tests pass; no camera-device claim.                                                                                                                                                                                                              |
| Trezor browser fallback advice                               | Native-only guidance retained; no nonexistent browser fallback advertised.                                                                                                                                                                                                                                                                                    |
| Blocking persisted selection reads                           | Existing `spawn_blocking` precedes write guards and publication checks. Ten native chain-runtime tests pass.                                                                                                                                                                                                                                                  |
| Short native WebUSB reads                                    | Existing Rust boundary rejects partial reports. Three native packet tests pass.                                                                                                                                                                                                                                                                               |
| Trezor account-export claim                                  | Reproduced malformed HID/WebUSB and Bridge framing in the existing vendor-SDK adapter. Reuse the installed protocol codecs, retain the initial USB marker, and use Bridge framing for Bridge replies/acks. Six actual-session transport-mock tests pass, including response bounds; no physical-device claim.                                                 |
| Startup diagnostics                                          | The previous Tauri formatting change still received a generic runtime error. Shared policy operations now report safe cause categories; native malformed UTF-8/numeric policy files are `InvalidData`. Real CLI startup fails closed without echoing policy contents.                                                                                         |
| Android assertion/error acceptance                           | Reproduced that final runner code `-1` could mask per-test failure `-1` or `-2`. The guard now requires one successful expected class/method, its JUnit summary and runner completion; skips, errors and incomplete output fail. All 47 release-workflow tests pass; fresh CI run `34223430337` also passed all ten emulator invocations across both flavors. |
| Docstring coverage                                           | CodeRabbit's stored 50.48% warning is an older snapshot without a current missing-function list. Existing added API docs remain; the current equivalent metric is unverified. No threshold was lowered.                                                                                                                                                       |

## Dependency and CI boundaries

Fresh full npm audit: **0 critical, 0 high, 0 moderate, 6 low**. The six entries
propagate from [elliptic GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84),
which lists no patched published version. This is an unresolved dependency
issue, not an audit exception. A fresh renderer graph found it was bundled via
SQLite/HPKE/ML-KEM Node fallbacks and unused Trezor THP imports. The existing
polyfill plugin now excludes Node `crypto`; a build guard rejects the affected
packages if reintroduced; the negative baseline build fails that guard. Six renderer configurations retain their application
modules and exclude elliptic, browserify-sign, crypto-browserify and create-ecdh.
Offline SQLite/WASM, native WebCrypto and Trezor v1/Bridge codec checks pass.
No replacement crypto implementation or dependency was added. This removes the
affected code from the tested bundles, but does not patch the installed package,
prove device signing, or provide THP support. The six audit findings stay open.

Repository-wide Dependabot's 21 open records
also include old default-branch graphs: PR63 no longer contains `toml` or
`extract-zip`; its router, UUID, esbuild, browserslist, fflate and xmldom versions
are already patched. That does not close the default-branch alerts before merge.
The vendored GLib advisory backport and continuing registry audit are documented
in [its provenance note](../../vendor/glib-0.18.5/OPTN.md).

The macOS Intel CLI test hit its unchanged 180-second child deadline. Optimizing
only `optn-core` and `sha2` in the CLI test profile reduced that same console
regression locally from **43.03 s to 1.89 s**. Production 600,000-round PBKDF2,
test debug assertions, overflow checks, timeouts and the full platform matrix
remain. All ten CLI wallet-security process tests pass in **4.13 s** after the
change. Remote macOS Intel subsequently passed all ten tests in 8.11 s on `c7b013de`.

Other checks: CLI/runtime strict all-target Clippy, four runtime wallet-security
tests, 13 runtime checkpoint tests, the
populated authenticated HD restart test, two core wallet-file tests and the
Rust architecture firewall pass. Local evidence is under
`target-codex-chain-native/security-review-current/` and is not a release artifact.
The local Windows GLib attempt stopped at missing pkg-config/GLib prerequisites;
it did not execute the test. Docker also did not provide a working local engine.
Both optimized regressions subsequently passed on Linux in CI (see below).

The follow-up closes the Trezor resource-budget gap: HID/WebUSB responses reject
advertised payloads over 1 MiB before allocation, assemble into one bounded
buffer, and share a monotonic deadline across every report in one response.
Bridge frames reject malformed hex and the same oversized payload. These are
wallet resource limits, not universal Trezor protocol limits. The current BCH
signer exchanges streamed TxRequest/TxAck frames; firmware upload is not a caller.
Six session tests cover framing, oversize declarations, malformed input and
slow multi-report responses on both native transports. Core typecheck and strict native-library Clippy pass.
All six Rust Bridge body reads now enforce a cumulative 2,098,176-byte cap before
appending a chunk, including JSON and HTTP error responses. The fixed loopback
client refuses redirects and proxy routing and retains its 120-second timeout.
The native loopback HTTP regression passes for advertised/chunked oversize,
invalid UTF-8/JSON, exact-limit acceptance and redirect refusal. Proxy bypass and
the existing HTTP deadline are source-verified, not separate runtime tests.

CI on `c7b013de` executed both optimized Linux GLib regressions successfully.
The macOS Intel CLI job passed all ten wallet-security process tests in **8.11 s**
with the unchanged password cost and deadline. These supersede the local-only
verification limits above; they do not establish physical-device signing.

These fixes/reviews do not establish full Issue #71/#75 completion, a clean
CodeQL gate, native SeedCash signing, or tested APK/macOS packages.
