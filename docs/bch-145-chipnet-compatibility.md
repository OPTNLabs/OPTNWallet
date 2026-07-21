# BCH coin type 145 and legacy chipnet recovery

## Canonical rule

Every newly derived Bitcoin Cash account uses BIP44 coin type `145`:

- mainnet: `m/44'/145'/account'`, encoded as `xpub` and `bitcoincash:`
- chipnet: `m/44'/145'/account'`, encoded as `tpub` and `bchtest:`

The network changes extended-key and CashAddr encoding. It does not change the
BCH BIP44 coin type.

## Existing v1.6.2 chipnet wallets

Version 1.6.2 could derive chipnet keys from the legacy testnet path
`m/44'/1'/account'`. Upgrading must not delete or rewrite those persisted key,
address, or UTXO rows. Their encrypted private keys remain spendable while all
new keys are derived from BCH coin type `145`.

## Seed-recovery follow-up

Mnemonic and `.optn` recovery on chipnet must support a bounded compatibility
scan before this transition is considered complete:

1. Scan canonical receive/change branches under `m/44'/145'/account'` with an
   independent gap limit of 20 per branch.
2. Scan the legacy v1.6.2 receive/change branches under
   `m/44'/1'/account'` with the same bounds.
3. Persist canonical keys normally. Persist legacy keys only when their address
   has history or UTXOs, and tag each persisted key with its derivation coin
   type so hardware/offline signing can reconstruct the correct path.
4. Keep future receive/change allocation on coin type `145`; legacy path `1`
   is recovery-only and must never be selected for a newly created wallet.
5. Include the legacy-origin marker in wallet export/import metadata until all
   recovered funds have moved to canonical BCH-145 addresses.

This compatibility work is intentionally non-destructive: stored v1.6.2 keys
continue to work, and a seed restore can find historical chipnet funds without
reintroducing coin type `1` as a normal BCH derivation path.
