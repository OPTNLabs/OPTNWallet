## FundMe Module Layout

This folder currently contains both:

- React UI surfaces
- CashStarter/FundMe transaction and utility helpers

### UI files

- `FundMeAddonApp.tsx`
- `PledgeModal.tsx`
- `ConsolidateModal.tsx`
- `CampaignDetail.tsx`

`CampaignDetail.tsx` is legacy web-app code retained for compatibility/reference. It still contains WalletConnect-era logic and hosted `fundme.cash` write flows.

### Non-UI backend/helper files

- `cashstarterPledge.ts`
- `cashstarterRefund.ts`
- `cashstarterClaim.ts`
- `cashstarterCancel.ts`
- `cashstarterStop.ts`
- `managerInitialize.ts`
- `consolidateUTXOs.ts`
- `findUtxo.ts`
- `toTokenAddress.ts`
- `values.ts`

These files are intentionally `.ts` now because they do not render React.

## Native Addon SDK Replacement Map

The following website-era behaviors can be replaced or are already replaced by addon SDK modules:

- Wallet address lookup
  - Replace with `sdk.wallet.getPrimaryAddress()` / `sdk.wallet.listAddresses()`
- Token address conversion
  - Replace with `sdk.wallet.toTokenAddress(address)`
- Wallet-scoped UTXO reads
  - Prefer `sdk.utxos.listForAddress(address)` or `sdk.utxos.listForWallet()`
- Latest block / chain reads
  - Replace with `sdk.chain.getLatestBlock()`
- Contract discovery and on-chain campaign reads
  - Replace hosted discovery with `sdk.chain.queryUnspentByLockingBytecode(...)`
- Native signing
  - Replace WalletConnect `signTransaction` with `sdk.signing.signatureTemplateForAddress(...)`
- Broadcast
  - Replace external wallet broadcast with `sdk.tx.broadcast(hex)`
- Hosted reads that still remain acceptable for now
  - `get-shortcampaign/:id`
  - `get-campaign/:id`
  - `get-campaignlist`

## Remaining Legacy Backend Behaviors

These are still legacy and should be retired or migrated next:

- `CampaignDetail.tsx`
  - WalletConnect session usage
  - Hosted write endpoints like:
    - `save-pledge`
    - `delete-pledge`
    - `update-totalPledges`
    - `update-stats`
    - `update-campaign`
- `consolidateUTXOs.ts`
  - Still assumes external signing instead of a native addon flow

## Recommended Next Cleanup

1. Move the non-UI transaction helpers into a dedicated subfolder like `transactions/`.
2. Move wallet/formatting helpers like `findUtxo.ts` and `toTokenAddress.ts` into `utils/`.
3. Keep `CampaignDetail.tsx` clearly marked as legacy until it can be removed entirely.
