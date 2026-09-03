# OPTN Rustification Architecture

## Current decision

OPTN currently uses:

- **Leptos 0.8.x** as the current Rust renderer
- **Tauri 2.x** as the current desktop/mobile shell
- **optn-core** for reusable BCH/protocol logic
- **optn-app** for framework-neutral application state and actions
- **optn-transport** for renderer-to-application communication contracts
- **optn-platform** for OS capability contracts and provider metadata
- **optn-platform-apple** for the Apple NativeFfi provider; optional Opal stays gated

Leptos, Tauri, IPC, and individual OS integration libraries are implementation
choices, not architectural dependencies.

## Stable center

```
optn-core
    ↑
optn-app
    ↑
optn-transport ← renderer transport implementations
    ↑
renderer

optn-platform ← capability providers
```

The architecture has four independently replaceable boundaries:

1. **Renderer** — Leptos today; Slint/Dioxus/another renderer may be added later.
2. **Shell** — Tauri today; another native host may replace it.
3. **Transport** — local WASM, direct in-process Rust, Tauri IPC, or another transport.
4. **Capability provider** — pure Rust, shell plugin, direct native FFI, or browser APIs.

## Historical product contract

Rustification must preserve the wallet decisions that produced the current
product, not only the code shape visible at the latest commit.

Read:

- `rustification/closed-pr-history.toml` — complete 52-PR closed-history
  snapshot (merged and closed-unmerged, with lineage/relevance).
- `docs/rustification/closed-pr-design-invariants.md` — the human-readable
  product/security/protocol invariants extracted from that history.

Merged PRs explain why current behavior exists. Closed-unmerged PRs are not
automatically authoritative: use their merged successor or current code/tests
when available. An intentional behavior change is allowed only when it is
explicitly justified and tested; changing language/framework is not itself a
reason to change wallet semantics.

## Transport model

Renderers dispatch typed `AppAction` values and consume typed state/events through
`optn_transport::AppTransport`.

Current implementations:

```
Web / extension:
Leptos → LocalTransport → optn-app

Native Rust renderer:
renderer → DirectTransport → optn-runtime → optn-app

Tauri/WASM:
renderer → Tauri IPC transport (adapter boundary) → optn-runtime
```

The Tauri IPC implementation can evolve independently; the renderer must not depend
on `optn-runtime` directly.

## Capability-provider model

`optn-platform` owns capability contracts such as:

```
SecureStorage
Biometrics
QrScanner
Clipboard
Notifications
FileSystem
DeepLinks
HardwareWallet
NfcTagIo
NfcIso7816
ContactlessPresentment
```

Providers declare their type:

```
PureRust
Shell
NativeFfi
Web
```

Current concrete providers now prove the model:

```
Desktop clipboard:
Tauri host → optn-platform-native::NativeClipboard → arboard
ProviderKind::PureRust

Android/iOS clipboard:
Tauri host → TauriMobileClipboard → official clipboard-manager plugin
ProviderKind::Shell
```

`optn-platform-native` selects providers per Cargo feature. Clipboard, secure
storage, and notifications are independent features, so enabling one capability
does not drag unrelated OS integrations into a target. The secure-storage
candidate uses keyring 4.x and the notification candidate uses notify-rust; they
remain opt-in until migrated call sites prove parity.

Hardware HID/WebUSB providers are desktop-only and no longer enter Android/iOS
builds. The legacy Tauri keyring plugin is also desktop-only while secure-storage
migration is evaluated.


## Apple-native provider and Opal reference split

Apple integration is represented by two committed SwiftPM packages rather than
generated Xcode/Tauri project files. Rust `optn-platform` owns the capability
traits (Keychain/Secure Enclave, CoreNFC presentment, diagnostics) without
Opal types in the domain.

```
apple/OPTNAppleProvider
    typed ApplePlatformProvider contract (no Opal types)
    iOS 14 / macOS 11 SwiftPM floor matching the product, not raising it
    native adapters: Keychain opaque-byte storage; CoreNFC tag I/O;
    Secure Enclave availability; os_log diagnostics
    contactless presentment stub (unavailable without NFC & SE entitlement)

apple/OPTNOpalReference
    optional Apple26 flavor, compile flag OPAL_APPLE26_REFERENCE
    platforms macOS(.v26), iOS(.v26) — GATED off the iOS 14 product
    SwiftFulcrum v0.8.0 -> 611a53f2047660e0dd221f75526ce11335be901a
    OpalDiagnostics v0.2.0 -> 8c42eeb40d64776789e70694e4e5006d2afa400c
    does not link OpalBase / OpalCrypto / OpalFusion / OpalHedge
```

The committed Capacitor project remains iOS 14.0
(`ios/App/App.xcodeproj` `IPHONEOS_DEPLOYMENT_TARGET = 14.0`). This work does
not raise OPTN iOS or macOS minimums. CoreNFC adapters compile against that
iOS 14 floor and keep NDEF/TAPSIGNER protocol in Rust; they return unavailable
until a host drives a real session. Contactless presentment is Apple NFC & SE
Platform, not Tap to Pay / ProximityReader.

### OpalBase supply chain (verified 2026-09-03, public git only)

Public evidence, no private mirrors:

- Tags on https://github.com/58opals/OpalBase : `v0.1.1`, `v0.2.0`, `v0.2.1`,
  `v0.3.0`, `v0.4.0`, `v0.4.1`. The GitHub Releases page is empty; the tags
  still exist on the git remote.
- OpalBase **v0.4.1** `Package.swift`: `swift-tools-version: 6.2`; platforms
  `macOS(.v26)`, `iOS(.v26)`; dependencies SwiftFulcrum, OpalCrypto,
  OpalFusion, OpalHedge, OpalDiagnostics all `branch: "develop"`.
- A tagged OpalBase is therefore **not** a closed SemVer graph. Pinning
  `v0.4.1` still pulls moving `develop` siblings.
- OpalBase **develop**: `swift-tools-version: 6.4`; same v26 platforms; also
  `branch: "develop"` siblings.

**GATE:** OpalBase is not a default SwiftPM dependency of the iOS 14 product.
The optional Apple26 flavor is isolated in `apple/OPTNOpalReference` behind
`OPAL_APPLE26_REFERENCE` and v26 platforms. Production secrets must never be
routed through OpalCrypto. OpalFusion must not replace crates Fusion
(`optn-core` CashFusion).

`AppleProviderPolicy` mirrors the trust boundary: reference providers are
secret-free and no Apple provider can own wallet state. CI (`Apple Provider`)
and `cargo run -p xtask -- architecture` plus `cargo test -p xtask` enforce
the firewall against `optn-core`, `optn-app`, and `optn-runtime`. If the Opal
flavor cannot build on iOS 14, that job reports **GATED**, not fake-green
parity. Native iOS 14 targets are not skipped when they fail.

Differential BCH vectors against Opal are **blocked until** a gated flavor
with a closed SemVer graph exists. Cheap iOS 14 coverage is native-only
(Keychain / CoreNFC / Secure Enclave descriptor tests), not Opal.

This is an implementation foothold, not a parity claim. The Swift packages are
not yet wired into the production Tauri/Capacitor host, so no Apple product
feature moves from unit/none evidence to E2E/device evidence solely because
these packages compile.

## Dependency rules

The following are forbidden:

```
optn-core      → Leptos/Tauri/Dioxus/Capacitor
optn-app       → Leptos/Tauri/Dioxus/Capacitor
optn-platform  → Leptos/Tauri/Dioxus/Capacitor
optn-transport → Leptos/Tauri/Dioxus/Capacitor
optn-runtime   → Leptos/Tauri/Dioxus/Capacitor
optn-ui        → optn-core directly
optn-ui        → optn-runtime directly
optn-platform-apple must not depend on optn-core/optn-app/optn-runtime
Opal packages     must not depend on optn-core/optn-app/optn-runtime
```

This is enforced by:

```
cargo run -p xtask -- architecture
```

## Swap examples

Renderer swap:

```
Leptos → AppTransport
becomes
Slint/Dioxus → AppTransport
```

Shell swap:

```
Tauri adapters → optn-platform / optn-transport
becomes
other shell adapters → optn-platform / optn-transport
```

Capability swap:

```
TauriBiometrics → Biometrics
becomes
AndroidNativeBiometrics → Biometrics
```

Transport swap:

```
Tauri IPC → AppTransport
becomes
DirectTransport → AppTransport
```

Wallet, transaction, crypto, protocol, and application-state logic remain unchanged.

## Migration order

1. Move trusted wallet/protocol logic into `optn-core`.
2. Move framework-neutral application state/use-cases into `optn-app`.
3. Route renderer interaction through `optn-transport`.
4. Define OS capabilities and provider metadata in `optn-platform`.
5. Keep shell/native implementations behind providers.
6. Select provider dependencies per capability rather than per shell.
7. Migrate React screens to the Rust renderer incrementally.
8. Prove Tauri Android/iOS parity before removing Capacitor.
9. Prefer mature pure-Rust capability providers where they improve portability.
10. Use shell plugins or thin native FFI where pure-Rust support is not production-ready.
11. Keep web/extension on the same application/domain contracts through WASM.

## Apple provider and Opal

Apple capabilities enter through `optn-platform` ports, then
`optn-platform-apple` (`ApplePlatformProvider`), then the Swift adapter
`apple/OptnAppleProvider`. Optional Opal packages are an isolated iOS 26 /
macOS 26 flavor (`apple/OptnAppleOpalFlavor`), not the shipping wallet.

Evidence that Opal is blocked on shipping surfaces:

- OPTN iOS 14.0: `ios/App/App.xcodeproj/project.pbxproj` and `ios/App/Podfile`
- OPTN macOS 10.15: Tauri 2.11.5 default; unset in `src-tauri/tauri.conf.json`
- Opal `v0.4.1` / `develop`: macOS 26 / iOS 26 (Swift tools 6.2 tagged, 6.4 develop)

Do not raise OPTN minimums to satisfy Opal. Do not route production secrets
through OpalCrypto. Fusion stays authoritative Rust. SwiftFulcrum may be used
as a chipnet oracle in the isolated flavor. Canonical vectors live in
`test-vectors/bch-oracle-cashaddr.json`. See `apple/README.md`.

## Version policy

Use current stable Rust and reviewed stable framework/tool releases. Regenerate and
verify lockfiles for dependency changes; never couple framework upgrades to unrelated
wallet behavior changes without CI evidence.
