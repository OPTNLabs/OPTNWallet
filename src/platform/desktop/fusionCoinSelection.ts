// Which coins a CashFusion round offers is decided in Rust
// (optn-core fusion::coin_selection, through the shared WASM core): the same
// policy the CLI and the native driver run. This file only describes the
// wallet's UTXO records to it and maps its answer back onto those records.

import type { UTXO } from '../../types/types';
import { ensureOptnCore, fusionSelectCoins } from '../../wasm/optn-core';
import type { FusionMode } from './fusionAutoEngine';
import { coinDepth, outpointFromParts } from './fusionCoinDepth';

/** The freeze flags legacy UTXO records carry, under their several names. */
type FreezeFlags = {
  is_frozen_coin?: boolean;
  isFrozenCoin?: boolean;
  isFrozenAddress?: boolean;
  is_frozen_address?: boolean;
  frozen?: boolean;
  frozenFlags?: string;
};

export type FusionCoinBucket = { address: string; coins: UTXO[] };

export type FusionCoinSelection = {
  /** The coins offered to the round. */
  selected: UTXO[];
  /** The coins depth reporting covers. Never a second chain scan. */
  depthCoins: UTXO[];
  /** Server Auto only: nearly all eligible value is fused deep enough. */
  depthSatisfied: boolean;
  /** Addresses to consolidate before fusing, most crowded first. */
  crowded: FusionCoinBucket[];
  /** Server rounds: why no address is eligible, worded for the trigger. */
  emptyReason: string | null;
  eligibleBuckets: number;
  eligibleCoins: number;
  skipCounts: Array<[string, number]>;
};

type SelectionView = {
  selected: string[];
  depthCoins: string[];
  depthSatisfied: boolean;
  crowded: Array<{ address: string; outpoints: string[]; valueSats: number }>;
  emptyReason: string | null;
  eligibleBuckets: number;
  eligibleCoins: number;
  skipCounts: Array<[string, number]>;
};

function isFrozen(coin: UTXO & FreezeFlags): boolean {
  return Boolean(
    coin.is_frozen_coin ||
      coin.isFrozenCoin ||
      coin.isFrozenAddress ||
      coin.is_frozen_address ||
      coin.frozen ||
      (typeof coin.frozenFlags === 'string' && /[ac]/i.test(coin.frozenFlags))
  );
}

function isConfirmed(coin: UTXO & { confirmations?: number }): boolean {
  return Number(coin.height) > 0 || Number(coin.confirmations) > 0;
}

export function selectFusionCoins(options: {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  fuseDepth: number;
  coins: readonly UTXO[];
}): FusionCoinSelection {
  const byOutpoint = new Map<string, UTXO>();
  const coins = [];
  for (const coin of options.coins) {
    const value = Number(coin.value ?? coin.satoshis ?? 0);
    // Not a whole number of satoshis: not a coin anyone can fuse.
    if (!Number.isSafeInteger(value) || value < 0) continue;
    const outpoint = outpointFromParts(coin.tx_hash, coin.tx_pos);
    if (byOutpoint.has(outpoint)) continue;
    byOutpoint.set(outpoint, coin);
    coins.push({
      outpoint,
      address: String(coin.address ?? ''),
      valueSats: value,
      confirmed: isConfirmed(coin),
      token: coin.token != null || coin.token_data != null,
      frozen: isFrozen(coin),
      depth: coinDepth(options.walletId, outpoint),
    });
  }

  ensureOptnCore();
  const view = JSON.parse(
    fusionSelectCoins(
      JSON.stringify({
        mode: options.mode,
        trigger: options.trigger,
        fuseDepth: Math.max(0, Math.trunc(options.fuseDepth)),
        coins,
      })
    )
  ) as SelectionView;
  const records = (outpoints: string[]) =>
    outpoints.flatMap((outpoint) => {
      const coin = byOutpoint.get(outpoint);
      return coin ? [coin] : [];
    });
  return {
    selected: records(view.selected),
    depthCoins: records(view.depthCoins),
    depthSatisfied: view.depthSatisfied,
    crowded: view.crowded.map((bucket) => ({
      address: bucket.address,
      coins: records(bucket.outpoints),
    })),
    emptyReason: view.emptyReason,
    eligibleBuckets: view.eligibleBuckets,
    eligibleCoins: view.eligibleCoins,
    skipCounts: view.skipCounts,
  };
}
