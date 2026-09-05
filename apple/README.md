# Apple provider boundary

```
optn-core -> optn-app -> optn-runtime -> optn-platform
    -> optn-platform-apple -> Swift adapter -> optional Opal packages
```

Opal is an Apple-native reference and optional provider. It is not a second
wallet. Wallet, transaction, PSBT, CashTokens, RPA, signing, Fusion, and
application state stay in Rust. Opal packages must never depend on
`optn-core`, `optn-app`, or `optn-runtime`.

## Deployment targets (do not silently raise)

| Surface | Minimum | Evidence |
| --- | --- | --- |
| OPTN Capacitor iOS | 14.0 | `ios/App/App.xcodeproj/project.pbxproj` `IPHONEOS_DEPLOYMENT_TARGET = 14.0` and `ios/App/Podfile` `platform :ios, '14.0'` |
| OPTN macOS | 10.15 | `src-tauri/tauri.conf.json` does not set `bundle.macOS.minimumSystemVersion`; Tauri 2.11.5 supported floor is 10.15 |
| Shipping Swift bridge | iOS 14 / macOS 10.15 | `apple/OPTNAppleProvider/Package.swift` |
| Opal tagged (`v0.4.1`) | iOS 26 / macOS 26, Swift tools 6.2 | https://github.com/58opals/OpalBase/blob/v0.4.1/Package.swift |
| Opal `develop` (inspected 2026-09-03) | iOS 26 / macOS 26, Swift tools 6.4 | https://github.com/58opals/OpalBase/blob/develop/Package.swift |

Opal cannot be the default Apple provider on OPTN shipping surfaces. Raising
OPTN minimums to match Opal is forbidden. The Opal flavor is isolated to a
compatible-OS package that is not linked into the iOS 14 app.

## What shipping Swift owns

`OPTNAppleProvider` talks to Apple APIs that are awkward as generic Tauri plugins:

- Keychain (`AppleKeychainStorage`)
- LocalAuthentication
- CoreNFC reader/ISO-7816 transport (iOS)
- Apple process lifecycle signals
- Contactless presentment stub: Apple NFC & SE Platform (entitlement/agreement), **not** Tap to Pay on iPhone / `ProximityReader`

Rust owns NDEF and TAPSIGNER protocol/state. Leptos and Tauri never import this
module.

## Optional Opal flavor

`apple/OPTNOpalReference` is iOS 26 / macOS 26 only. Pins are exact SemVer
tags, never moving `develop`.

Allowed:

- `SwiftFulcrum` `v0.8.0` as a chipnet Fulcrum oracle/reference (no unsynchronized wallet state)
- `OpalDiagnostics` `v0.2.0` for redacted diagnostics

Blocked on purpose:

- `OpalCrypto` — secret-scalar operations are not constant-time reviewed; production seed/private-key/signing stays in Rust
- `OpalFusion` — early scaffold; OPTN Fusion stays authoritative Rust
- `OpalBase` — developer preview wallet orchestration; not a second OPTN wallet
- `OpalHedge` — not needed for this Apple provider slice

## Supply-chain fact

OpalBase `v0.4.1` `Package.swift` still depends on sibling packages with
`branch: "develop"` and records revisions in `Package.resolved`. OPTN does not
follow that pattern. See `apple/opal-pins.toml`.

## Differential vectors

Canonical CashAddr vectors live in `test-vectors/bch-oracle-cashaddr.json`.
Rust (`optn-core`) must match the vector. The Opal flavor consumes the same
file as an independent oracle when the macOS/iOS 26 SDK exists. Agreement of
two implementations is never sole proof.

## NFC

- Rust: NDEF + TAPSIGNER protocol/state
- Swift: CoreNFC
- Kotlin: Android IsoDep (not this package)
- iPhone wallet → tap-at-terminal: Apple NFC & SE Platform, not Tap to Pay on iPhone
