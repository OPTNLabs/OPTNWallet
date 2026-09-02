# OPTN production-ready definition

Green GitHub checks are necessary and not sufficient.

**End-to-end green** means every automated build, test, security, and artifact
job succeeds.

**Production-ready** means the resulting artifacts have also been proven on
real devices, real wallet lifecycles, real recovery paths, hardware/air-gap
integrations, and upgrade scenarios.

OPTN is production-ready only when every supported platform builds the intended
release artifact, every supported wallet capability passes the shared parity
matrix, trusted wallet/application logic has one authoritative Rust
implementation, upgrade/recovery paths preserve user funds and wallet identity,
security gates pass, and packaged artifacts complete real-device end-to-end
wallet workflows.

The machine-readable matrix is [`rustification/parity-matrix.toml`](../rustification/parity-matrix.toml).
Check it with:

```sh
cargo run -p xtask -- parity --report
cargo run -p xtask -- parity --production-ready
```

`--report` fails on matrix/source drift or missing evidence references.
`--production-ready` fails unless every required cell is `pass` or `na`.

A missing feature has only two acceptable states:

- `pass` — implemented and tested at the evidence level the matrix records
- `na` — deliberately unsupported, documented, and hidden correctly

Not: it happens not to appear on Android.

## Release gates

| Gate | Required to pass |
| --- | --- |
| 1. Feature parity | Create, import, watch-only, receive, send, wallet restore, network selection, and every supported wallet type work on every intended platform |
| 2. Rust architecture | `optn-core`, `optn-app`, `optn-runtime`, `optn-platform` contain no Leptos/Tauri/Capacitor/Dioxus coupling |
| 3. One source of truth | Transaction construction, signing, PSBT, CashTokens, RPA, Fusion, and related protocols have one authoritative Rust implementation |
| 4. State correctness | Typed actions/state/events, no invalid combinations, no stale state after wallet switching, restart, or backgrounding |
| 5. Wallet recovery | A wallet can be destroyed on device and reconstructed from documented backup material with identity, derivation, and policy reproduced |
| 6. Persistence upgrade | Existing OPTN wallets from supported previous releases survive upgrade into the Rust architecture without data loss |
| 7. Security | Secrets never leave trusted boundaries; secure storage works; sensitive memory is zeroized where practical; logs contain no secrets; dependency/security checks pass |
| 8. PSBT / air gap | SeedCash/Paytaca-compatible export → scan/import → sign → return → merge → broadcast works from actual devices |
| 9. Hardware wallets | Ledger/Trezor/OneKey and other supported flows are exercised against actual hardware, not merely mocked |
| 10. Network resilience | Electrum/SPV reconnect, failover, offline mode, stale server, malformed server response, and interrupted sync are handled |
| 11. Platform lifecycle | Android/iOS suspend, resume, process kill, rotation, deep links, camera permission, biometric cancellation, and storage permission cases work |
| 12. Release artifacts | Windows/Linux/macOS/Android/iOS/Web/extensions produce the expected distributable artifacts |
| 13. F-Droid | Reproducible Android build from pinned source/toolchains without prohibited binary downloads |
| 14. Web/extension | WASM freshness, Chrome/Firefox extension install, permissions, CSP, and service-worker behavior proven |
| 15. Regression protection | Every discovered bug gets a test so the same class cannot silently return |
| 16. Real E2E | Actual create/import/watch-only/send/receive/sign/restart/recover scenarios run against packaged applications, not only dev servers |
| 17. No critical known bugs | 0 unresolved P0/P1; security-sensitive P2s resolved before release |
| 18. External review | Focused review of keys/signing/PSBT/persistence/platform security |

## Watch-only Android E2E (immediate #63 gate)

The Android landing must expose Watch Only. CI must fail if that action is
missing from the packaged APK.

Packaged-app scenario:

1. Launch a clean Android app
2. Landing/onboarding is visible
3. Watch-only is visible with Create and Import
4. Enter Chipnet xPub, optional master fingerprint, and a name
5. Public receive address preview derives
6. Wallet is created
7. App is force-stopped and relaunched
8. The wallet remains watch-only
9. The send path builds an unsigned PSBT and does not expose seed signing
10. Receive/address derivation still works

Run the equivalent scenario on iOS, desktop, and web **where the matrix says
`pass`**. Where the matrix says `na`, the action must stay hidden.

Capacitor is not retired until Tauri/Leptos Android and iOS pass this matrix
for the capabilities they are supposed to replace.

## Current Watch Only policy

Desktop, Android, and iOS: `pass`.
Web and extension: `na` (hidden on purpose). Promoting web/extension to `pass`
requires flipping the matrix and the capability flags together, then proving
the E2E path. Do not leave Watch Only accidentally missing on a native surface.

Hardware wallets and CashFusion stay desktop `pass` and `na` everywhere else.

## Property-level testing for trusted code

Critical modules need known vectors, characterization tests, differential
tests, property tests, fuzz tests, and E2E tests. Parsers, PSBT, CashTokens,
UR, recovery, and backup policy are not done at `cargo check`.
