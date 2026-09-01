# OPTN Rustification Architecture

## Current decision

OPTN currently uses:

- **Leptos 0.8.x** for Rust-authored UI/WASM
- **Tauri 2.x** for desktop/mobile native shell and OS integrations
- **optn-core** for reusable BCH/protocol logic

Leptos and Tauri are implementation choices, not architectural dependencies.

## Dependency rule

The stable center of the application is:

```
optn-core
    ↑
optn-app
    ↑
UI adapter

optn-platform ← native/browser adapters
```

Framework dependencies must point inward only through adapters:

```
optn-ui (Leptos today)
        ↓
     optn-app
        ↓
     optn-core

Tauri adapter
        ↓
  optn-platform
```

The following are forbidden:

```
optn-core     → Leptos/Tauri/Dioxus/Capacitor
optn-app      → Leptos/Tauri/Dioxus/Capacitor
optn-platform → Leptos/Tauri/Dioxus/Capacitor
optn-ui       → optn-core directly
```

This is enforced by:

```
cargo run -p xtask -- architecture
```

## Swap model

A future UI framework swap should replace only `optn-ui`.

Example:

```
optn-ui-leptos
      ↓
   optn-app

      becomes

optn-ui-other
      ↓
   optn-app
```

A future native shell swap should replace platform adapters only:

```
Tauri adapters → optn-platform

becomes

other adapters → optn-platform
```

Wallet, transaction, crypto, protocol, and application state logic should remain unchanged.

## Migration order

1. Move trusted wallet/protocol logic into `optn-core`.
2. Move framework-neutral application state/use-cases into `optn-app`.
3. Define OS capabilities in `optn-platform`.
4. Keep Tauri-specific implementation behind adapters.
5. Migrate React screens to `optn-ui` incrementally.
6. Prove Tauri Android/iOS parity before removing Capacitor.
7. Keep web/extension using the same `optn-app` + `optn-core` through WASM.

## Version policy

Use current stable Rust and current stable minor releases of Leptos/Tauri, but update
them as reviewed dependency changes with lockfile regeneration and full CI rather
than coupling framework upgrades to unrelated wallet migrations.
