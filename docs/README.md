# OPTN Wallet Developer Docs

Technical documentation for contributors and third-party integrators.

## Start Here

- [Contributing Guide](../CONTRIBUTING.md)
  - Setup, quality checks, Docker paths, and pull-request expectations.
- [Build and Release Scripts](./build-and-release.md)
  - Commands for Android APK/AAB builds and iOS Capacitor preparation.
- [Docker contributor lab](./docker-dev.md)
  - Optional Docker env for contributors (`packages/docker-dev/`) — not the
    end-user install path.
- [Docker vs releases](./docker-release-model.md)
  - Images update **from** git tags; installers stay the primary ship.
- [Wallet Architecture](./wallet-architecture.md)
  - Runtime shape, major modules, and where responsibilities live.
- [Wallet Ledger & Sync Design](./wallet-ledger-sync-design.md)
  - Option A hybrid: txi/txo ledger, status hashes, UTXO cache projection,
    Manual Sync vs Rebuild Wallet.
- [CashFusion Implementation Status](./cashfusion-implementation-scope.md)
  - **Shipped:** both P2P and classic server CashFusion maps (no longer a
    “Phase 2 not started” plan).
- [P2P CashFusion Privacy Layers](./p2p-cashfusion-privacy-layers.md)
  - **PR #12 shipped naming map:** Tor vs NIP-59 vs Pedersen vs blind Schnorr
    vs **output onion** (what each does, infrastructure, essential?).
- [P2P CashFusion Protocol](./p2p-cashfusion-protocol.md)
  - Exact mechanism of the peer-to-peer CashFusion path (discovery, election,
    blind credentials, output onion, assembly, signing). Audit-oriented
    reference — not the root README.
- [P2P CashFusion Threat Model](./THREAT_MODEL.md)
  - Adversary classes for the shipped P2P fusion design.
- [Integration Guide](./integration-guide.md)
  - How to integrate a third-party product with OPTN Wallet.
- [CashScript Contract Systems](./cashscript-contract-systems.md)
  - BCH covenant design patterns, state-machine rules, and testing checklist.
- [Custody Vault Design Notes](./custody-vault-design-notes.md)
  - How OPTN Wallet treats open inbound deposits and locked outbound custody control.
- [Quantumroot Flow Chart](./quantumroot-flow.md)
  - Reference Quantumroot address structure, pre-quantum flow, post-quantum flow, and Quantum Lock cleanup.

## Addon-Specific Docs

- [Addon Development Guide](./addon-development-guide.md)
  - End-to-end process for adding or extending in-wallet addon apps.
- [Addon SDK Reference](./addons-sdk.md)
  - Capabilities, modules, and policy/security behavior.

## Suggested Reading Paths

- If you are integrating a dApp: `Integration Guide` -> `WalletConnect` section.
- If you are embedding custom wallet app logic: `Integration Guide` -> `Addon Development Guide` -> `Addon SDK Reference`.
- If you are contributing to core wallet internals: `Wallet Architecture` first.
