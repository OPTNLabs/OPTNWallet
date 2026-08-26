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
- [CashFusion status](./cashfusion-implementation-scope.md)
  - Both P2P and classic server paths as they exist in this tree.
- [P2P CashFusion Privacy Layers](./p2p-cashfusion-privacy-layers.md)
  - Tor vs NIP-59 vs Pedersen vs blind Schnorr vs **output onion**.
- [P2P CashFusion Protocol](./p2p-cashfusion-protocol.md)
  - Discovery, election, v4 credentials, onion, assembly, signing.
- [P2P CashFusion EC component plane v4](./p2p-ec-component-plane-v4.md)
  - Component binding, version rejection, and v4 maintenance invariants.
- [P2P CashFusion protocol knobs](./p2p-cashfusion-knobs.md)
  - Internal 6 / 4 / 10 floors, tiers, timing. Edit `fusionKnobs.ts` — not
    the wallet UI.
- [P2P CashFusion Threat Model](./THREAT_MODEL.md)
  - Adversary classes for the shipped P2P design.
- [P2P CashFusion FAQ](./p2p-cashfusion-faq.md)
  - Short answers: missing signature, blame, onion, ACK-shrink, 0-conf.
- [P2P CashFusion blame](./proposed-blame-p2p-cashfusion.md)
  - Shipped policy: abort does not disclose; silence is timeout. Optional
    future notes (fanout, quarantine) are not missing product.
- [Watch-only + SeedCash](./watch-only-seedcash.md)
  - xPub import, PSBTv145, UR export/import, optional fingerprint.
- [Integration Guide](./integration-guide.md)
  - How to integrate a third-party product with OPTN Wallet.
- [CashConnect](./cashconnect.md)
  - Nostr contract-system connector (Connections & features).
- [Nostr chat tiers](./nostr-chat-tiers.md)
  - DM (NIP-17) vs private MLS group vs open MLS group; avatars stay local
    until a private media path exists.
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
- If you are working on Nostr chat: [Nostr chat tiers](./nostr-chat-tiers.md)
  first, then [Paytaca parity notes](./paytaca-nostr-chat-parity-plan.md).
- If you are working on CashFusion: status → knobs → protocol → component
  plane → privacy layers → [FAQ](./p2p-cashfusion-faq.md) →
  [blame](./proposed-blame-p2p-cashfusion.md).

## Still open (not shipped)

- [Keystone hardware wallet](./keystone-hardware-wallet-scope.md) — UI disabled (“Coming soon”).
- [UX improvement plan](./UX_IMPROVEMENT_PLAN.md) — product hierarchy, not done.
- [Airdrops addon plan](./OPTN_WALLET_AIRDROPS_ADDON_PLAN.md) — backend + wallet MVP.
- [Paytaca Nostr chat parity](./paytaca-nostr-chat-parity-plan.md) — leftover
  Paytaca UX (Blossom, Watchtower, typing). Tiers themselves:
  [nostr-chat-tiers.md](./nostr-chat-tiers.md).
