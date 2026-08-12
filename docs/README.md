# OPTN Wallet Developer Docs

Technical documentation for contributors and third-party integrators.

## Start Here

- [Build and Release Scripts](./build-and-release.md)
  - Commands for Android APK/AAB builds and iOS Capacitor preparation.
- [Wallet Architecture](./wallet-architecture.md)
  - Runtime shape, major modules, and where responsibilities live.
- [Integration Guide](./integration-guide.md)
  - How to integrate a third-party product with OPTN Wallet.
- [CashScript Contract Systems](./cashscript-contract-systems.md)
  - BCH covenant design patterns, state-machine rules, and testing checklist.
- [Custody Vault Design Notes](./custody-vault-design-notes.md)
  - How OPTN Wallet treats open inbound deposits and locked outbound custody control.

## Addon-Specific Docs

- [Addon Development Guide](./addon-development-guide.md)
  - End-to-end process for adding or extending in-wallet addon apps.
- [Addon SDK Reference](./addons-sdk.md)
  - Capabilities, modules, and policy/security behavior.

## Suggested Reading Paths

- If you are integrating a dApp: `Integration Guide` -> `WalletConnect` section.
- If you are embedding custom wallet app logic: `Integration Guide` -> `Addon Development Guide` -> `Addon SDK Reference`.
- If you are contributing to core wallet internals: `Wallet Architecture` first.
