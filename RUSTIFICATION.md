# OPTN Rustification Architecture

## Current decision

OPTN currently uses:

- **Leptos 0.8.x** as the current Rust renderer
- **Tauri 2.x** as the current desktop/mobile shell
- **optn-core** for reusable BCH/protocol logic
- **optn-app** for framework-neutral application state and actions
- **optn-transport** for renderer-to-application communication contracts
- **optn-platform** for OS capability contracts and provider metadata

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

## Apple provider (58 Opals) — contract present, adoption blocked

The 58 Opals Swift stack is an *optional* Apple-native provider and an
independent BCH reference. It is not a second wallet.

```text
optn-platform
      ↓
optn_platform::apple::AppleProvider     capability contract
      ↓
Swift Apple adapter
      ├── native Apple APIs
      └── optional Opal packages
```

Rust stays the single authoritative implementation of BCH truth — transaction,
PSBT, CashTokens, RPA, signing policy, CashFusion, application state. Nothing
across this boundary returns a wallet decision; it returns a platform
capability result. `xtask architecture` fails the build if any Opal package
name appears in `optn-core`, `optn-app` or `optn-runtime`.

### Why nothing is wired up

Verified against upstream on 2026-09-03 — re-check before implementing, these
move:

| Package | Tag | Platforms | Note |
| --- | --- | --- | --- |
| OpalBase | v0.4.1 | macOS 26 / iOS 26 | developer preview; depends on five siblings by `branch: "develop"` |
| SwiftFulcrum | v0.8.0 | macOS 26 / iOS 26 | most mature; depends on OpalDiagnostics by SemVer |
| OpalCrypto | v0.2.0 | macOS 26 / iOS 26 | upstream: "do not use this preview for production key handling" |
| OpalFusion | v0.1.0 | macOS 26 / iOS 26 | initial scaffold |
| OpalHedge | v0.1.0 | macOS 26 / iOS 26 | |
| OpalDiagnostics | v0.2.0 | macOS 26 / iOS 26 | |

Two blockers, both product decisions rather than implementation details:

1. **Deployment target.** OPTN's iOS minimum is **14.0**
   (`ios/App/App.xcodeproj`). Every Opal package requires iOS 26 / macOS 26 and
   Swift tools 6.2, so adopting one raises the product minimum by twelve major
   versions and drops every device below it. The minimum is not to be raised to
   consume a dependency.
2. **Reproducibility.** `OpalBase/Package.swift` pulls SwiftFulcrum,
   OpalCrypto, OpalFusion, OpalHedge and OpalDiagnostics by
   `branch: "develop"`. Pinning OpalBase to a tag therefore still does not give
   a reproducible build, because its transitive dependencies move. SwiftFulcrum
   and OpalCrypto do use SemVer for OpalDiagnostics, so SwiftFulcrum alone is
   pinnable — it is the only package that could be adopted reproducibly today.

`AppleProvider::availability` encodes both: it refuses on `OsTooOld` before a
call is made, and on `NotReproducible` when a release build asks for a provider
whose dependencies float.

### Crypto boundary

OpalCrypto's own README states secret-scalar operations have not completed
constant-time hardening or security review. It must not see production seed,
private-key or signing material. `ReferenceVector` therefore offers only
deterministic public-material behaviour — CashAddr, public derivation, account
xPub, transaction serialization, sighash, CashToken encoding, Fulcrum response
parsing — and `needs_secret_material()` is false for every one of them, so a
differential test cannot become the reason a preview library sees a key.

### Differential testing

Where Opal implements the same deterministic behaviour it is useful as an
*independent oracle*, which is worth more than porting its code. But agreement
between two implementations is not proof: both can share a wrong assumption.
`DifferentialOutcome::passed()` requires each side to match the canonical
vector as well as each other, and `agrees_but_unanchored()` names the failure
mode explicitly.

## Version policy

Use current stable Rust and reviewed stable framework/tool releases. Regenerate and
verify lockfiles for dependency changes; never couple framework upgrades to unrelated
wallet behavior changes without CI evidence.
