# Integration Guide

This guide helps third-party developers choose and implement the right integration path with OPTN Wallet.

## Choose an Integration Path

### Path A: WalletConnect (Recommended for external dApps)

Use this when your app runs outside OPTN Wallet and needs users to connect/sign.

Current handled request methods in wallet runtime:

- `bch_getAccounts`
- `bch_getAddresses`
- `bch_signMessage`
- `personal_sign`
- `bch_signTransaction`

Reference implementation area:

- `src/redux/walletconnectSlice.ts`
- `src/redux/walletconnect/thunks.ts`

Prerequisite:

- Set `VITE_WC_PROJECT_ID` in `.env`

### Path B: Addon SDK (Recommended for in-wallet experiences)

Use this when your app should run inside OPTN Wallet and consume wallet features via the curated SDK.

Key properties:

- Manifest-declared permissions/capabilities
- Fail-closed capability enforcement
- Runtime policy engine (authorization/rate-limit/timeout/audit)

Core references:

- [Addon Development Guide](./addon-development-guide.md)
- [Addon SDK Reference](./addons-sdk.md)

## Addon Integration Flow (Summary)

1. Define addon manifest with explicit capabilities in `src/addons/builtin/index.ts`.
2. Implement your app screen in `src/pages/apps/...`.
3. Map `config.screen` in screen resolver/host flow.
4. Validate:
   - `npm run addons:validate`
   - `npm run typecheck`
   - relevant tests

## Capability and Security Constraints

- Addons cannot bypass capability checks.
- Trust tier changes policy profile only; it does not grant hidden permissions.
- Sensitive actions should be confirmed through SDK/UI consent prompts.
- Addons should use SDK modules only, not internal wallet services directly.

## Infrastructure Configuration for Integrators

OPTN Wallet supports endpoint failover and environment overrides. This is useful when testing against your own infra or staging.

Supported override env variables (CSV lists):

- `VITE_ELECTRUM_SERVERS`
- `VITE_CHAINGRAPH_URLS`
- `VITE_BCMR_API_BASE_URLS`
- `VITE_IPFS_GATEWAYS`

Network-specific variants:

- `*_MAINNET`
- `*_CHIPNET`

Implementation reference:

- `src/utils/servers/InfraUrls.ts`

## Practical Local Setup

1. Copy `.env.sample` to `.env`.
2. Add your WalletConnect and API keys.
3. Run `npm run dev`.
4. Validate your integration path:
   - WalletConnect flow through settings/pairing UI
   - or addon flow through `/apps/:appId` host route

## Next Documents

- Architecture context: [Wallet Architecture](./wallet-architecture.md)
- In-wallet extension work: [Addon Development Guide](./addon-development-guide.md)
- SDK details: [Addon SDK Reference](./addons-sdk.md)
