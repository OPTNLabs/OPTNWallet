# Addon Development Guide

This guide is for developers integrating addons with the OPTN Wallet SDK.

See also:
- `README.md` for the developer docs index.
- `integration-guide.md` for path selection (WalletConnect vs Addon SDK).
- `addons-sdk.md` for SDK capability/module reference.

## Current Model
- Addons are currently curated and manually integrated.
- Runtime is fail-closed:
  - Addon manifest capabilities are required.
  - App `requiredCapabilities` are enforced as a subset.
  - SDK blocks undeclared capabilities.
- Third-party install/marketplace packaging can be layered on top later without changing SDK fundamentals.

## Architecture At A Glance
- Manifest/types: `src/types/addons.ts`
- Built-in addon registry source: `src/addons/builtin/index.ts`
- Registry validation: `src/services/AddonsRegistry.ts`
- Permission validation: `src/services/AddonsAllowlist.ts`
- SDK runtime: `src/services/AddonsSDK.ts`
- SDK contract metadata: `src/services/addons/SDKContract.ts`
- Policy engine (auth/rate-limit/timeout/audit): `src/services/addons/AddonPolicyEngine.ts`
- Manifest schema: `schemas/addon-manifest.schema.json`

## Quickstart Template
- Use `templates/addon-sample/` as the fastest starting point.
- Template files:
  - `templates/addon-sample/manifest.example.json`
  - `templates/addon-sample/ExampleAddonApp.tsx`
  - `templates/addon-sample/host-switch.example.tsx`

## Step 1: Define Addon Manifest
Add a manifest entry to `src/addons/builtin/index.ts`.

```ts
{
  id: 'com.example.demo',
  name: 'Example Demo',
  version: '0.1.0',
  trustTier: 'reviewed', // or restricted/internal
  permissions: [
    {
      kind: 'capabilities',
      capabilities: [
        'wallet:context:read',
        'wallet:addresses:read',
        'utxo:wallet:read',
        'tx:build',
        'tx:broadcast'
      ]
    }
  ],
  apps: [
    {
      id: 'example-app',
      name: 'Example App',
      kind: 'declarative',
      requiredCapabilities: [
        'wallet:context:read',
        'wallet:addresses:read',
        'utxo:wallet:read',
        'tx:build',
        'tx:broadcast'
      ],
      config: { screen: 'ExampleApp' }
    }
  ],
  contracts: [
    {
      id: 'example-contract',
      name: 'Example Contract',
      cashscriptArtifact: {},
      functions: []
    }
  ]
}
```

Rules:
- `requiredCapabilities` must be a subset of manifest capabilities.
- Unknown capability names fail validation.
- HTTP access needs both:
  - `kind: 'http'` with domains
  - capability `http:fetch_json`

## Step 2: Implement App Screen
Create a screen component in `src/pages/apps/...` and accept `sdk: AddonSDK` from host.

```tsx
import type { AddonSDK } from '../../../services/AddonsSDK';

type Props = { sdk: AddonSDK };

export default function ExampleApp({ sdk }: Props) {
  // Read wallet context
  const { walletId, network } = sdk.wallet.getContext();

  // Fetch addresses/utxos with capability + policy enforcement
  // await sdk.wallet.listAddresses()
  // await sdk.utxos.listForWallet()

  return <div>Wallet {walletId} on {String(network)}</div>;
}
```

## Step 3: Register Declarative Screen Mapping
Map `config.screen` in `src/pages/apps/MarketplaceAppHost.tsx`:
- Import your component.
- Add a `case` in `renderApp()` switch.

## SDK Modules You Can Use
- `sdk.meta`
  - `getInfo()`, `getAuditTrail()`
- `sdk.wallet`
  - `getContext()`, `listAddresses()`, `getPrimaryAddress()`, `toTokenAddress(address)`
- `sdk.utxos`
  - `listForAddress()`, `listForWallet()`, `refreshAndStore()`
- `sdk.chain`
  - `getLatestBlock()`, `queryUnspentByLockingBytecode()`
- `sdk.tx`
  - `addOutput()`, `build()`, `broadcast()`
- `sdk.contracts`
  - `deriveAddress()`, `deriveLockingBytecodeHex()`
- `sdk.signing`
  - `signatureTemplateForAddress()`
- `sdk.http`
  - `fetchJson()`
- `sdk.ui`
  - `confirmSensitiveAction()`

## Security Expectations
- Do not import wallet internals directly from app components (`KeyService`, Redux store, transaction helpers, etc.).
- Use SDK methods so capability checks, policy limits, and audit logging apply.
- Do not assume trust tier bypasses capability checks. It only tunes policy profile.
- Treat all user-facing critical actions as explicit confirmations (`sdk.ui.confirmSensitiveAction` + runtime prompts).

## Validation Commands
- Typecheck:
  - `npm run typecheck`
- Validate addon manifests:
  - `npm run addons:validate`
- Run addon SDK tests:
  - `npm run test -- src/services/addons/__tests__/`

## Capability Reference
Current capability list is defined in:
- `src/types/addons.ts` (`ADDON_CAPABILITIES`)

Always import capability names from code, do not hardcode custom strings outside the supported set.
