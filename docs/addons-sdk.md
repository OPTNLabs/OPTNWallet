# Addon SDK

See also:
- `README.md` for the developer docs index.
- `integration-guide.md` for integration-path guidance.
- `addon-development-guide.md` for step-by-step addon authoring.

## Version
- Current SDK version: `1.1.0`
- Contract source: `src/services/addons/SDKContract.ts`

## Capability Model
- Addons must request capabilities in their manifest.
- Apps can request a subset via `requiredCapabilities`.
- SDK is fail-closed: missing capability => hard error.

## Policy Engine
- Source: `src/services/addons/AddonPolicyEngine.ts`
- Enforces:
  - Runtime authorization hook
  - Rate limits per capability (window: 1 minute)
  - Timeouts on external or expensive operations
  - Structured audit trail entries

## SDK Modules
- `meta`
  - `getInfo()`
  - `getAuditTrail()`
- `wallet`
  - `getContext()`
  - `listAddresses()`
  - `getPrimaryAddress()`
  - `toTokenAddress(address)`
- `utxos`
  - `listForAddress(address)`
  - `listForWallet()`
  - `refreshAndStore(address)`
- `chain`
  - `getLatestBlock()`
  - `queryUnspentByLockingBytecode(lockingBytecodeHex, tokenId)`
- `tx`
  - `addOutput(...)`
  - `build(...)`
  - `broadcast(hex)`
- `contracts`
  - `deriveAddress(...)`
  - `deriveLockingBytecodeHex(...)`
- `signing`
  - `signatureTemplateForAddress(address)`
- `http`
  - `fetchJson(url, init?)`
- `ui`
  - `confirmSensitiveAction(...)`
- `logging`
  - `info/warn/error`

## Trust Tiers
- `restricted` (default): strict baseline policy limits.
- `reviewed`: baseline limits.
- `internal`: relaxed limits.

Tiers tune rate limits and UX policy only. They must not bypass capability checks.

## Manifest Schema
- JSON schema: `schemas/addon-manifest.schema.json`
- Runtime schema checks: `src/services/addons/AddonManifestSchema.ts`

## Validation
- Use `npm run addons:validate` to verify built-in manifests against schema/policy checks.
