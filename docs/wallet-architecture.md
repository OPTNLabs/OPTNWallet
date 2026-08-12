# Wallet Architecture

This document describes how OPTN Wallet is structured so external developers can understand where integrations plug in.

## Runtime Overview

- Frontend: React + Vite
- State: Redux Toolkit
- Platforms: Web first, with Capacitor targets for mobile builds
- Core responsibilities:
  - Wallet identity and key management
  - UTXO and transaction lifecycle
  - Network abstraction (Electrum, Chaingraph, BCMR, IPFS)
  - Extensibility through Addon apps and WalletConnect

## Route and App Host Layer

- Main route registration: `src/App.tsx`
- Core screens: `src/pages/*`
- Addon app host route: `/apps/:appId` via `src/pages/apps/MarketplaceAppHost.tsx`

The app host resolves addon metadata, enforces launch/runtime consent, then exposes a permission-scoped SDK to addon screens.

## Integration Surfaces

### 1) WalletConnect Surface (External dApps)

- WalletConnect initialization and request handling:
  - `src/redux/walletconnectSlice.ts`
  - `src/redux/walletconnect/thunks.ts`
  - `src/redux/walletconnect/helpers.ts`
- WalletConnect UI:
  - `src/components/walletconnect/*`
  - `src/pages/Settings.tsx` (WalletConnect panel access)

### 2) Addon Surface (In-Wallet Apps)

- Manifest and capability types: `src/types/addons.ts`
- Built-in addon registry: `src/addons/builtin/index.ts`
- Registry + validation: `src/services/AddonsRegistry.ts`
- Capability allowlist checks: `src/services/AddonsAllowlist.ts`
- Runtime SDK: `src/services/AddonsSDK.ts`
- Policy engine: `src/services/addons/AddonPolicyEngine.ts`

## Security Model (High-Level)

- Capability-gated addon SDK:
  - Addons only access methods declared in manifest permissions.
  - App-level `requiredCapabilities` must be a subset of manifest grants.
- Fail-closed runtime:
  - Missing capabilities fail hard.
  - Address-scoped operations enforce wallet address allowlists.
- Policy-driven enforcement:
  - Rate limits, timeouts, runtime authorizer hooks, and audit trail collection.
- No direct secret exposure to addons:
  - Addons never receive raw wallet private keys.

## Address Derivation Notes

- Current live behavior is unchanged from the legacy wallet flow:
  - wallet send flows still default change selection to the same address ordering used before this derivation-strategy work
  - no new change-chain (`chain 1`) preference is active in the UI or runtime behavior
- Dormant future-integration scaffolding now exists for BCH-only change-address preference work:
  - `src/redux/preferencesSlice.ts`
  - `src/utils/changeAddressPreference.ts`
  - integration points in `src/hooks/useSimpleSend.ts` and `src/pages/Transaction.tsx`
- That scaffolding is intentionally disabled right now so user experience remains unchanged while derivation strategy work continues in the background.

## Network and Infra Abstraction

- Endpoint pool and failover utility: `src/utils/servers/InfraUrls.ts`
- Supports:
  - Default endpoints per network (mainnet/chipnet)
  - Environment-based endpoint override lists
  - Deterministic endpoint rotation with last-known healthy preference

For concrete integration details, continue in [Integration Guide](./integration-guide.md).
