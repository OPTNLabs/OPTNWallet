// Spend-policy helpers for "only spend fused coins" (Electron Cash–style).
//
// fuseDepth / "Rounds per coin" = how many fusions auto-fuse will put a coin
// through before leaving it alone.
//
// spendOnlyFusedCoins = ordinary SEND may only use coins that already have
// depth ≥ 1 (at least one completed fusion). Unfused receives stay for fusion
// first, not for spending.

import type { UTXO } from '../../types/types';
import { coinDepth, outpointFromParts } from './fusionCoinDepth';

/** True if this coin has been through ≥1 CashFusion round on this wallet. */
export function isFusedCoin(
  walletId: number,
  utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>
): boolean {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return false;
  return coinDepth(walletId, outpointFromParts(utxo.tx_hash, utxo.tx_pos)) >= 1;
}

/**
 * Filter a spend pool when "only spend fused" is on.
 * Returns the filtered list, or an error string if nothing remains.
 */
export function applySpendOnlyFusedPolicy(
  walletId: number,
  utxos: UTXO[],
  spendOnlyFused: boolean
): UTXO[] | { error: string } {
  if (!spendOnlyFused) return utxos;
  const fused = utxos.filter((u) => isFusedCoin(walletId, u));
  if (fused.length === 0) {
    return {
      error:
        'Only-spend-fused is on, but no fused coins are available. ' +
        'Run CashFusion first, or turn off “Only spend fused coins” in CashFusion settings.',
    };
  }
  return fused;
}
