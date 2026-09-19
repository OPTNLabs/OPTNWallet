# OPTN Rustification Architecture

## Current decision

OPTN currently uses:

- **Leptos 0.8.x** as the current Rust renderer
- **Tauri 2.x** as the current desktop/mobile shell
- **optn-core** for reusable BCH/protocol logic
- **optn-app** for framework-neutral application state and actions
- **optn-runtime** for authoritative wallet sessions, durable state and reconciliation
- **optn-chain-native** for Tauri-free native chain adapter composition shared by desktop and CLI
- **optn-transport** for renderer-to-application communication contracts
- **optn-platform** for OS capability contracts and provider metadata
- **optn-platform-apple** for the Apple NativeFfi provider; optional Opal stays gated

Leptos, Tauri, IPC, and individual OS integration libraries are implementation
choices, not architectural dependencies.

## Stable center

Runtime communication and ownership (arrows are calls, not Cargo dependencies):

```text
GUI / CLI → trusted transport adapter → optn-runtime
                                        ├─ optn-app: actions and projections
                                        ├─ optn-core: pure wallet primitives
                                        ├─ provider contracts: observations and evidence
                                        └─ platform ports: storage, sockets and hardware
```

Only the runtime owns authoritative wallet/session state. Providers return
observations; platform adapters execute capabilities; neither publishes wallet
state directly. `optn-app` is the application model, not another wallet backend.

Current Cargo direction is distinct: `optn-app` depends on `optn-core`,
`optn-transport` depends on `optn-app`, and `optn-runtime` consumes those crates
and `optn-platform`. Transport contracts currently sit below the runtime;
concrete transport adapters sit above it. Do not introduce a reverse dependency
or claim the target layer diagram is already the literal Cargo graph.

[#83](https://github.com/OPTNLabs/OPTNWallet/issues/83) coordinates these authority
boundaries. #71 owns product UI, #75 owns providers/sync/privacy, #79 owns the
transaction approval lifecycle, and #82 owns the add-on host/package lifecycle.
Trusted UI transport is not an untrusted add-on API: guests must not receive
unrestricted `AppAction`, raw signing templates, key material or broadcast
authority. A manifest's claimed trust tier cannot grant host privileges.

The architecture has four independently replaceable boundaries:

1. **Renderer** — Leptos today; Slint/Dioxus/another renderer may be added later.
2. **Shell** — Tauri today; another native host may replace it.
3. **Transport** — local WASM, direct in-process Rust, Tauri IPC, or another transport.
4. **Capability provider** — pure Rust, shell plugin, direct native FFI, or browser APIs.

## Renderer contract: preserve choice, share behavior

React remains supported during migration; do not delete it as a consequence of
adding a Rust renderer. Leptos is the current Rust UI. Dioxus has a headless
renderer proof in `crates/optn-ui-dioxus`, not a complete packaged wallet.
Slint is an undecided future option, not an implemented or selected replacement.
Preserve these choices without adding speculative framework dependencies.

Here, a renderer "plugin" means a reviewed interface adapter using the shared
application/transport contracts. It does not mean loading arbitrary executable
plugins into a process holding wallet keys. Build/package selection is sufficient
until a runtime renderer switch is explicitly required and implemented.

| Responsibility | Authoritative owner |
| --- | --- |
| BCH cryptography, derivation, transaction validation | `optn-core` |
| Application actions, state, view models, capability decisions | `optn-app` and existing shared Rust policy modules |
| Sync lifecycle, source routing, verification, persistence coordination | `optn-runtime`, with `optn-chain-native` for native chain composition |
| Typed requests, responses and transport errors | `optn-transport`; host-specific transport adapters |
| OS storage, hardware, clipboard and other capabilities | `optn-platform` contracts and platform providers |
| Layout, focus, navigation presentation, accessibility | Each renderer |

GUI and CLI are independent clients of the same Rust application/runtime. CLI
must not depend on any GUI or shell framework. A renderer must not own a second
wallet state machine, source selector, signing policy or persistence format.
Existing React paths are migration work, not permission to duplicate new behavior
in TypeScript. Route new behavior through the shared Rust contract and retain
compatibility while moving legacy callers behind it.

### Keeping interfaces in sync

Change shared behavior once, then wire each supported interface to the same typed
request and state/view model. Keep network/source selection, Tor policy, sync,
verification, wallet state and error semantics consistent across GUI and CLI.
Capability visibility, enabled/experimental preferences and execution permission
remain separate shared decisions. A disabled control can explain a restriction;
it cannot grant permission. Browser/extension restrictions must still be enforced
behind the UI, including when a request is crafted directly.

Desktop and mobile share behavior, not fixed pixel dimensions. Each renderer must
adapt layout to available space, support desktop window resizing and preserve
mobile usability. Screen markup, accessibility and platform integration still
require work and verification per renderer; changing the shared core does not
automatically implement a missing screen in React, Leptos, Dioxus or Slint.

For every connected feature change:

1. Implement and check the shared backend and durable state first.
2. Update typed adapters and the applicable GUI/CLI consumers; preserve existing
   consumers or explicitly record their remaining integration gaps.
3. Check equivalent inputs, refusal cases, network switches and restart/resume
   through the real interfaces, then verify affected platform packages.
4. Record evidence and gaps in `docs/pr63-requirement-ledger.md`. Component tests,
   headless renderer proofs, live workflows and packaged-device tests are distinct;
   none establishes all-renderer parity by itself.

### CLI interaction contract

Keep `optn wallet` as the persistent human wallet prompt, one-shot commands for
individual operations, and `optn wallet --stdio` for private structured automation.
All three use shared Rust behavior. A visual TUI and line-editor dependency are
optional future UX work, not prerequisites for #75. Do not create a second wallet
adapter trait, key store or signing implementation for a new terminal presentation.

Passwords use hidden prompts or private input, never command arguments or saved
command history. Persistent sessions still need backend auto-lock and explicit
sensitive-operation authorization; an interactive prompt is not a security sandbox.

Inside the wallet prompt, `network status` lists the shared configuration and
`network select <id> --protocol <protocol>` selects an existing source. Advanced
`network configure <JSON>` accepts the typed selection object; one-shot
`optn network configure <file>` reads it from a file. The private stdio equivalent
uses `{"network":{"op":"status"}}`, or `select`/`configure` operations with their
corresponding fields. Source edits invalidate retained sync freshness before saving;
the holder must sync again before freshness-dependent spending can proceed.

### Security boundaries are not framework guarantees

Keep ordinary wallet operations behind typed backend actions; never add raw-key
fields to general UI state or transport responses. Any recovery/export operation
needs its own explicit authorization and narrowly scoped secret handling.
Native storage providers and browser storage have different trust boundaries.

WASM is not a secret vault against compromised host JavaScript: imported/exported
linear memory can be accessible to that host. Native rendering does not make a
wallet immune to exploits. `zeroize` clears memory; it does not encrypt it.
Review the runtime, adapters, IPC validation, dependencies, storage and packages
as well as cryptography. Do not infer security from renderer choice alone.

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
optn-chain-native → Leptos/Tauri/Dioxus/Capacitor
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
7. Wire screens to shared Rust behavior incrementally; retain React as an interface option.
8. Prove Tauri Android/iOS parity before removing Capacitor.
9. Prefer mature pure-Rust capability providers where they improve portability.
10. Use shell plugins or thin native FFI where pure-Rust support is not production-ready.
11. Keep web/extension on the same application/domain contracts through WASM.

## Apple provider (58 Opals) — contract present, adoption blocked

Apple capabilities enter through `optn-platform` ports, then
`crates/optn-platform-apple` (`ApplePlatformProvider`), then the Swift adapter
`apple/OPTNAppleProvider`. Optional Opal packages are an isolated iOS 26 /
macOS 26 flavor (`apple/OPTNOpalReference`), not the shipping wallet. The 58
Opals Swift stack is an *optional* Apple-native provider and an independent BCH
reference. It is not a second wallet.

Apple code lives in `crates/optn-platform-apple` and nowhere else. The
capability contract, the differential-testing types and the
SwiftFulcrum/Electrum routing were written before that crate existed, so they
landed in `optn-platform` and were briefly duplicated across the two after the
merge. They have been folded into the Apple crate, which is where its own doc
comment already said Apple belongs, leaving `optn-platform`
provider-agnostic — the boundary `xtask architecture` exists to keep.

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

### Shipping surfaces, as recorded

- OPTN iOS 14.0: `ios/App/App.xcodeproj/project.pbxproj` and `ios/App/Podfile`
- OPTN macOS 10.15: Tauri 2.11.5 default; unset in `src-tauri/tauri.conf.json`
- Opal `v0.4.1` / `develop`: macOS 26 / iOS 26 (Swift tools 6.2 tagged, 6.4 develop)

Do not raise OPTN minimums to satisfy Opal. Do not route production secrets
through OpalCrypto. Fusion stays authoritative Rust. SwiftFulcrum may be used
as a chipnet oracle in the isolated flavor. Canonical vectors live in
`test-vectors/bch-oracle-cashaddr.json`. Exact pinned revisions are in
`apple/opal-pins.toml`. See `apple/README.md`.

## Version policy

Use current stable Rust and reviewed stable framework/tool releases. Regenerate and
verify lockfiles for dependency changes; never couple framework upgrades to unrelated
wallet behavior changes without CI evidence.
