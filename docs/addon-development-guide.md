# Addon Development Guide

This guide is for developers integrating addons with the OPTN Wallet SDK.

The steps below cover the current WIP integration model. Use the
[SDK technical specification](./addon-sdk-technical-spec.md) for the public
third-party API, wallet-owned signing, migration plan, and release criteria.
Use the secret-free mock host while developing an integration; production
execution remains limited to explicitly verified host adapters.

See also:

- `README.md` for the developer docs index.
- `../packages/addon-sdk/examples/README.md` for complete read-only, payment, CashToken, and
  wallet-owned signing examples.
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
- Public SDK entrypoint: `src/services/addons/PublicSDK.ts`
- SDK contract metadata: `src/services/addons/SDKContract.ts`
- Localization contract: `docs/addon-localization.md`
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
        'tx:propose',
        'tx:execute'
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
        'tx:propose',
        'tx:execute'
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
- Add localized metadata and screen messages in `localeBundles`; keep these
  messages out of the core wallet catalog.
- Third-party code must use the public SDK factory. Manifests marked
  `internal` are rejected by that factory and are reserved for built-in wallet
  integrations using the host-private constructor.

## Step 2: Implement App Screen

Create a screen component in `src/pages/apps/...` and accept the public
`AddonWalletClient` from the host.

```tsx
import type { AddonWalletClient } from '@optnlabs/optn-wallet-addon-sdk';

type Props = { sdk: AddonWalletClient };

export default function ExampleApp({ sdk }: Props) {
  // Read wallet context from an async effect or event handler.
  const loadContext = async () => sdk.wallet.getContext();

  // Fetch addresses/utxos with capability + policy enforcement
  // await sdk.wallet.listAddresses()
  // await sdk.utxos.listForWallet()

  return <div>Wallet context is loaded through `loadContext()`.</div>;
}
```

For an external browser add-on, establish the host session before mounting:

```ts
const connection = await connectAddonPostMessage({
  target: walletWindow,
  targetOrigin: 'https://wallet.example',
  addonId: manifest.id,
  requestedCapabilities: ['wallet:context:read', 'tx:propose', 'tx:execute'],
});
const sdk = createAddonWalletClient(connection.transport);

if (connection.hasCapability('tx:propose')) {
  const proposal = await sdk.tx.propose({ inputs, outputs });
  const operation = await sdk.tx.requestExecution({
    proposalId: proposal.proposalId,
    mode: 'wallet-submit',
    idempotencyKey: `checkout:${checkoutId}`,
  });
  // Poll sdk.tx.getOperation(operation.operationId) until terminal.
}
```

The wallet owns approval, signing, construction, broadcast, and recovery. The
add-on receives only sanitized data and the resulting signature or operation
status.

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
  - `propose({ inputs, outputs, expiresInMs })` (unsigned proposal preview)
  - `getProposal()`
  - `requestExecution({ proposalId, mode, idempotencyKey })` (wallet-owned execution)
  - `getOperation()` (poll wallet-owned submission status)

The legacy `build()` and `broadcast()` methods are host-private compatibility
paths for built-in prototypes and are unavailable to third-party SDK contexts.

`tx.propose` accepts an optional explicit CashToken intent. The current intent
names are `transfer`, `mint-fungible`, `mint-nft`, `mutate-nft`, and `burn`.
Use `transfer` for exact token/NFT conservation. Use the other kinds only when
the proposal intentionally mints, mutates authority/commitment, or burns
assets; the wallet validates the declared transition and still keeps token
signing and broadcast behind the host authority gate.

- `sdk.signing`
  - `signMessage({ address, message })` (the wallet performs signing; private keys and templates remain outside the add-on)
- `sdk.http`
  - `fetchJson()`
- `sdk.ui`
  - `confirmSensitiveAction()`

`sdk.contracts`, signature templates, raw transaction builders, signed
transaction export, and direct broadcast are host-private and are not part of
the third-party package. CashScript registry and contract execution remain
disabled until a separately reviewed registry and provenance contract exists.

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
