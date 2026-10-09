import { beforeEach, describe, expect, it } from 'vitest';

import type { UTXO } from '../../../types/types';
import { clearFusionDepth, recordFusionRound } from '../fusionCoinDepth';
import { selectFusionCoins } from '../fusionCoinSelection';

// The policy itself is Rust (optn-core fusion::coin_selection) and tested
// there. These run it through the real WASM core and check only what this
// glue owns: describing legacy UTXO records and mapping the answer back.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const coin = (
  txid: string,
  address: string,
  extra: Record<string, unknown> = {}
): UTXO =>
  ({
    tx_hash: txid,
    tx_pos: 0,
    value: 50_000,
    address,
    height: 100,
    ...extra,
  }) as UTXO;

describe('fusion coin selection glue', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    clearFusionDepth(7);
  });

  it('describes every legacy freeze flag and token field to the policy', () => {
    const plain = coin('aa', 'a');
    const coins = [
      plain,
      coin('bb', 'b', { frozenFlags: 'a' }),
      coin('cc', 'c', { is_frozen_coin: true }),
      coin('dd', 'd', { isFrozenAddress: true }),
      coin('ee', 'e', { token_data: { amount: '1', category: 'ab'.repeat(32) } }),
      coin('ff', 'f', { token: { amount: 1, category: 'cd'.repeat(32) } }),
    ];
    const selection = selectFusionCoins({
      walletId: 7,
      mode: 'p2p',
      trigger: 'manual',
      fuseDepth: 3,
      coins,
    });
    // The very record the caller passed, not a copy.
    expect(selection.selected).toEqual([plain]);
    expect(selection.selected[0]).toBe(plain);
  });

  it('passes each coin its recorded depth, so Auto leaves fused coins alone', () => {
    recordFusionRound(7, ['x:0'], ['deep:0']);
    recordFusionRound(7, ['deep:0'], ['deeper:0']);
    recordFusionRound(7, ['deeper:0'], ['maxed:0']);
    const coins = [coin('maxed', 'a'), coin('fresh', 'b')];
    const auto = selectFusionCoins({
      walletId: 7,
      mode: 'p2p',
      trigger: 'auto',
      fuseDepth: 3,
      coins,
    });
    expect(auto.selected.map((c) => c.tx_hash)).toEqual(['fresh']);
  });

  it('names crowded addresses with their records and explains an empty server list', () => {
    const crowded = ['a1', 'a2', 'a3', 'a4'].map((txid) => coin(txid, 'busy'));
    const selection = selectFusionCoins({
      walletId: 7,
      mode: 'server',
      trigger: 'manual',
      fuseDepth: 3,
      coins: crowded,
    });
    expect(selection.selected).toHaveLength(3);
    expect(selection.crowded).toEqual([{ address: 'busy', coins: crowded }]);

    const empty = selectFusionCoins({
      walletId: 7,
      mode: 'server',
      trigger: 'auto',
      fuseDepth: 3,
      coins: [coin('t1', 'tok', { token_data: { amount: '1' } })],
    });
    expect(empty.selected).toEqual([]);
    expect(empty.emptyReason).toMatch(/^Auto: no eligible server/);
    expect(empty.skipCounts).toEqual([['token', 1]]);
  });

  it('leaves out a record whose value is not whole satoshis', () => {
    const selection = selectFusionCoins({
      walletId: 7,
      mode: 'p2p',
      trigger: 'manual',
      fuseDepth: 3,
      coins: [coin('aa', 'a', { value: 1.5 }), coin('bb', 'b')],
    });
    expect(selection.selected.map((c) => c.tx_hash)).toEqual(['bb']);
  });
});
