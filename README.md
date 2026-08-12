# OPTN Wallet

OPTN Wallet is a Bitcoin Cash wallet focused on secure transaction flows, CashTokens support, and extensibility for external apps.

This `README` is the high-level entrypoint. Technical implementation and integration details live in [`docs/`](./docs/README.md).

## Documentation Map

- [Developer Docs Index](./docs/README.md)
- [Build and Release Scripts](./docs/build-and-release.md)
- [Wallet Architecture](./docs/wallet-architecture.md)
- [Integration Guide](./docs/integration-guide.md)
- [Addon Development Guide](./docs/addon-development-guide.md)
- [Addon SDK Reference](./docs/addons-sdk.md)

## For Third-Party Developers

There are two primary ways to integrate with OPTN Wallet:

- Wallet-to-dApp via WalletConnect.
- In-wallet addon apps using the Addon manifest + Addon SDK model.

Start with [Integration Guide](./docs/integration-guide.md), then go deeper into addon docs if you are building embedded wallet apps.

## Quickstart (Local Development)

1. Clone and install:

```bash
git clone https://github.com/OPTNLabs/OPTNWallet.git
cd OPTNWallet
npm install
```

2. Configure environment:

```bash
cp .env.sample .env
```

Set at least:

- `VITE_WC_PROJECT_ID` for WalletConnect
- Any API keys you need for your local flows

3. Run:

```bash
npm run dev
```

## Quality Checks

- `npm run typecheck`
- `npm run test`
- `npm run addons:validate`
- `npm run build`

## Build Scripts

See [Build and Release Scripts](./docs/build-and-release.md) for Android APK/AAB commands and iOS preparation commands.

## High-Level Repository Layout

- `src/pages/` UI routes and host screens
- `src/services/` runtime services (wallet, tx, addons, policy)
- `src/types/` shared domain models (including addon manifest/capabilities)
- `src/addons/builtin/` curated built-in addon manifests
- `schemas/` JSON schemas (including addon manifest schema)
- `docs/` technical documentation

## Project Links

- Website: https://www.optnwallet.com/
- Source: https://github.com/OPTNLabs/OPTNWallet
