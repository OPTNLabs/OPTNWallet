# Addon SDK

This reference describes the current WIP implementation. The public facade is
implemented for development and controlled integration testing; publication
still depends on the readiness gates in the [SDK technical specification](./addon-sdk-technical-spec.md).

See also:

- `README.md` for the developer docs index.
- `integration-guide.md` for integration-path guidance.
- `addon-development-guide.md` for step-by-step addon authoring.

Published integrations should consume the public facade from
`@optnlabs/optn-wallet-addon-sdk`. It removes internal compatibility methods
from both the TypeScript surface and the runtime object. Built-in prototypes
may continue using the internal `AddonSDK` while they migrate away from legacy
transaction builders.

The source entrypoint is:

```ts
import {
  createPublicAddonSDK,
  type AddonPublicSDK,
} from 'src/services/addons/PublicSDK';
```

When this contract is packaged for external distribution, this entrypoint is
the only SDK module that should be exported. Add-on code should not import
`AddonsSDK.ts`, `KeyService`, transaction managers, CashScript signers, wallet
stores, or provider objects.

## Version

- Current SDK version: `1.6.0`
- Public package status: private and unpublished
- Contract source: `src/services/addons/SDKContract.ts`

## Capability Model

- Addons must request capabilities in their manifest.
- Apps can request a subset via `requiredCapabilities`.
- SDK is fail-closed: missing capability => hard error.

## Published Limits

`sdk.meta.getInfo().limits` reports the current proposal bounds. The WIP
runtime currently accepts at most 200 inputs and 100 outputs per proposal.
Clients may use these values for local validation, but the wallet rechecks the
limits at the SDK boundary.

NFT capability and commitment metadata is preserved in proposals. NFT
execution remains host-adapter gated and unpublished until the reviewed
CashToken validator, builder, source-state, and signer evidence gates are
closed; metadata is never silently downgraded to a fungible transfer.

### CashToken proposal intents

`tx.propose` accepts explicit token state transitions. The public contract
supports `transfer`, `mint-fungible`, `mint-nft`, `mutate-nft`, and `burn`.
Ordinary transfers require exact fungible amount and NFT-state conservation;
token reduction, minting, NFT capability changes, and NFT destruction must use
the matching explicit intent. NFT minting requires a minting-capability input
and preserves the authority in the proposal, unless the proposal is an
explicit category-genesis transaction. Fungible minting likewise requires the
category-genesis input; it may include one genesis NFT. NFT mutation requires
a mutable or minting source and names both the source and successor state.

`sdk.meta.getInfo().cashTokenIntents` advertises these intent kinds. The
same metadata exposes `cashTokenLimits` for the maximum fungible amount,
maximum NFT commitment size, and token-output minimum satoshis. The wallet
revalidates these values at proposal and execution boundaries. The controlled
wallet host now routes token proposals through a private
`CashTokenExecutionAuthority` after approval; keys and provider access remain
inside the host. Standalone publication still requires source-state, builder,
genesis/category, change, and signer evidence for every advertised token
operation. The current pending-lock/recovery and desktop/browser/mobile E2E
scope is accepted for this WIP; publication will still record the exact
artifact and adapter evidence.

The proposal boundary applies the BCH CashTokens wire limits before the host
builder runs: categories are 32-byte hashes, fungible amounts are positive and
at most `9223372036854775807`, NFT commitments are even-length hex up to 40
bytes, and an amount of zero is valid only when the output also carries an NFT.
`transfer` can conserve multiple token categories and NFTs in one proposal.
Each explicit mint, NFT mutation, or burn intent names one category; batching
several destructive or authority-changing intents is reserved for a future
version so every review remains unambiguous.

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
  - Returned UTXOs are sanitized public views; executable unlockers, ABI
    objects, contract arguments, and contract function metadata are removed.
- `chain`
  - `getLatestBlock()`
  - `queryUnspentByLockingBytecode(lockingBytecodeHex, tokenId)`
- `tx`
  - `propose({ inputs, outputs, expiresInMs })` (unsigned proposal preview)
  - `getProposal(proposalId)`
  - `requestExecution({ proposalId, mode: 'wallet-submit', idempotencyKey })`
    (requires a wallet runtime execution handler)
  - `getOperation(operationId)` (reads the wallet-owned operation status)
  - `build(...)` and `broadcast(hex)` are host-private compatibility methods
    for current built-in prototypes and are unavailable to third-party SDK
    contexts.
- `contracts` is intentionally absent from the third-party SDK. CashScript
  derivation and execution remain host-private until OPTN Wallet has a
  reviewed contract registry, artifact provenance rules, and versioned
  handlers. Built-in prototypes may continue using the internal SDK during
  that design work.
- `signing`
  - `signMessage({ address, message })` (wallet-owned signing authority; 1–8,192 characters; private keys never enter the add-on process)
- `http`
  - `fetchJson(url, init?)`
- `ui`
  - `confirmSensitiveAction(...)`

## Trust Tiers

- `restricted` (default): strict baseline policy limits.
- `reviewed`: baseline limits.
- `internal`: host-private; rejected by the public package validator.

Tiers tune rate limits and UX policy only. They must not bypass capability checks.

## Manifest Schema

- JSON schema: `schemas/addon-manifest.schema.json`
- Runtime schema checks: `src/services/addons/AddonManifestSchema.ts`

## Validation

- Use `npm run addons:validate` to verify built-in manifests against schema/policy checks.

## Secret-free integration testing

The stable entrypoint also exports `createMockPublicAddonSDK`. It provides a
wallet context, address allowlist, proposal storage, approval flow, and an
explicit `submission_unknown` result without keys, signing, providers, or
broadcast access:

```ts
import { createMockPublicAddonSDK } from 'src/services/addons/PublicSDK';

const sdk = createMockPublicAddonSDK(manifest, {
  network: 'chipnet',
  addresses: ['bitcoincash:qqexample'],
});
const proposal = await sdk.tx.propose({
  inputs: [
    {
      tx_hash: '11'.repeat(32),
      tx_pos: 0,
      address: 'bitcoincash:qqexample',
      value: 1000,
      height: 0,
    },
  ],
  outputs: [{ recipientAddress: 'bitcoincash:qqexample', amount: 900 }],
});
```

The mock is for API and failure-state testing only. Its execution result never
means mempool acceptance or confirmation.
