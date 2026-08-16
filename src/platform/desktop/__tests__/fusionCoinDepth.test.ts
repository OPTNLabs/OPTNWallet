import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFusionDepth,
  coinDepth,
  coinsBelowDepth,
  isFusionTransaction,
  pruneSpentDepth,
  recordFusionRound,
  recordFusionTxid,
} from '../fusionCoinDepth';

const utxo = (txid: string, pos = 0) => ({ tx_hash: txid, tx_pos: pos });

// A minimal localStorage so this state can be exercised without a DOM,
// matching fusionRoundState.test.ts (vitest runs the node environment).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe('per-coin fuse depth', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    clearFusionDepth(1);
    clearFusionDepth(2);
  });

  it('treats never-fused coins as depth 0 and fusable', () => {
    expect(coinDepth(1, 'aaa:0')).toBe(0);
    expect(coinsBelowDepth(1, [utxo('aaa')], 3)).toHaveLength(1);
  });

  it('looks up depth case-insensitively on the txid half of the outpoint', () => {
    const tx = 'Ab'.repeat(32);
    recordFusionRound(1, ['seed:0'], [`${tx}:1`]);
    expect(coinDepth(1, `${tx.toLowerCase()}:1`)).toBe(1);
    expect(coinDepth(1, `${tx.toUpperCase()}:1`)).toBe(1);
    // maxDepth 1 means "only fuse coins with depth < 1" — depth-1 coin excluded.
    expect(
      coinsBelowDepth(1, [utxo(tx.toUpperCase(), 1)], 1)
    ).toHaveLength(0);
  });

  it('advances created coins one round beyond the deepest coin consumed', () => {
    recordFusionRound(1, ['aaa:0'], ['bbb:0']); // fresh -> depth 1
    expect(coinDepth(1, 'bbb:0')).toBe(1);

    recordFusionRound(1, ['bbb:0'], ['ccc:0']); // depth 1 -> 2
    expect(coinDepth(1, 'ccc:0')).toBe(2);
  });

  it('inherits the MIN input depth, so fresh ancestry cannot be claimed as deep', () => {
    recordFusionRound(1, ['aaa:0'], ['deep:0']); // deep:0 is depth 1
    recordFusionRound(1, ['deep:0'], ['deeper:0']); // depth 2

    // A round mixing the depth-2 coin with a brand new one. Electron Cash calls
    // a coin fused to depth N only when EVERY wallet-owned ancestor reaches
    // N-1, so the fresh input caps the whole output set at depth 1. Claiming 3
    // here would tell the user they are better mixed than they actually are.
    recordFusionRound(1, ['deeper:0', 'fresh:0'], ['out1:0', 'out2:0']);
    expect(coinDepth(1, 'out1:0')).toBe(1);
    expect(coinDepth(1, 'out2:0')).toBe(1);
  });

  it('advances normally when every input shares the same depth', () => {
    recordFusionRound(1, ['s1:0'], ['a:0']);
    recordFusionRound(1, ['s2:0'], ['b:0']); // a:0 and b:0 are both depth 1
    recordFusionRound(1, ['a:0', 'b:0'], ['both:0']);
    expect(coinDepth(1, 'both:0')).toBe(2);
  });

  it('stops offering a coin once it reaches the configured depth', () => {
    recordFusionRound(1, ['a:0'], ['b:0']);
    recordFusionRound(1, ['b:0'], ['c:0']);
    recordFusionRound(1, ['c:0'], ['d:0']); // d:0 is depth 3

    expect(coinsBelowDepth(1, [utxo('d')], 3)).toHaveLength(0);
    // Raising the limit puts it back in play — the bound is the setting, not
    // a permanent mark on the coin.
    expect(coinsBelowDepth(1, [utxo('d')], 4)).toHaveLength(1);
  });

  it('inherits depth via parent txid when outpoint keys do not match exactly', () => {
    // First fuse records electrum-style outpoint.
    recordFusionRound(1, ['seed:0'], ['aabbccdd'.repeat(8) + ':0']);
    expect(coinDepth(1, `${'aabbccdd'.repeat(8)}:0`)).toBe(1);
    // Next fuse spends the same coin under a different pos key that only
    // shares the txid — live Electrum lag / index remap used to reset to 0.
    // Per-txid depth keeps the chain climbing.
    recordFusionRound(
      1,
      [`${'aabbccdd'.repeat(8)}:99`],
      [`${'11223344'.repeat(8)}:0`]
    );
    expect(coinDepth(1, `${'11223344'.repeat(8)}:0`)).toBe(2);
  });

  it('drops spent inputs so the map tracks live coins, not history', () => {
    recordFusionRound(1, ['spent:0'], ['made:0']);
    // The input was consumed by the round and can never reappear.
    expect(coinDepth(1, 'spent:0')).toBe(0);
    expect(coinDepth(1, 'made:0')).toBe(1);
  });

  it('remembers fusion txids for history labels after outputs are spent', () => {
    const txid = 'ab'.repeat(32);
    expect(isFusionTransaction(1, txid)).toBe(false);
    recordFusionTxid(1, txid);
    expect(isFusionTransaction(1, txid)).toBe(true);
    // Coin outputs of that CoinJoin should show at least depth 1 for badges.
    expect(coinDepth(1, `${txid}:0`)).toBeGreaterThanOrEqual(1);
  });

  it('server-style chain: fusion-txid stamp then recordFusionRound climbs depth', () => {
    // First round only stamps txid (Electrum lag); second round inherits ≥1.
    const a = 'aa'.repeat(32);
    const b = 'bb'.repeat(32);
    recordFusionTxid(1, a);
    expect(coinDepth(1, `${a}:0`)).toBeGreaterThanOrEqual(1);
    recordFusionRound(1, [`${a}:0`], [`${b}:0`]);
    expect(coinDepth(1, `${b}:0`)).toBeGreaterThanOrEqual(2);
  });

  it('keeps wallets isolated from each other', () => {
    recordFusionRound(1, ['x:0'], ['y:0']);
    expect(coinDepth(1, 'y:0')).toBe(1);
    expect(coinDepth(2, 'y:0')).toBe(0);
  });

  it('filters a mixed set, keeping only coins still under the limit', () => {
    recordFusionRound(1, ['i:0'], ['done:0']);
    recordFusionRound(1, ['done:0'], ['done2:0']);
    recordFusionRound(1, ['done2:0'], ['maxed:0']); // depth 3

    const survivors = coinsBelowDepth(
      1,
      [utxo('maxed'), utxo('brandnew')],
      3
    ).map((u) => u.tx_hash);
    expect(survivors).toEqual(['brandnew']);
  });
});

describe('depth eviction is evidence-based, never age or size based', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    clearFusionDepth(1);
  });

  it('keeps depth for a coin that has sat unspent for years', () => {
    recordFusionRound(1, ['old:0'], ['ancient:0']);
    // Nothing here may expire it. Forgetting reads as depth 0, and auto-fusion
    // would pay again to redo mixing this coin already has.
    expect(coinDepth(1, 'ancient:0')).toBe(1);
    expect(coinsBelowDepth(1, [utxo('ancient')], 1)).toHaveLength(0);
  });

  it('survives a large number of tracked coins without evicting', () => {
    for (let i = 0; i < 200; i += 1) {
      recordFusionRound(1, [`in${i}:0`], [`out${i}:0`]);
    }
    // The oldest entry must still be there; a size cap would have dropped it.
    expect(coinDepth(1, 'out0:0')).toBe(1);
    expect(coinDepth(1, 'out199:0')).toBe(1);
  });

  it('drops only coins a fresh snapshot proves are spent', () => {
    recordFusionRound(1, ['a:0'], ['still:0']);
    recordFusionRound(1, ['b:0'], ['gone:0']);

    pruneSpentDepth(1, new Set(['still:0']));

    expect(coinDepth(1, 'still:0')).toBe(1);
    expect(coinDepth(1, 'gone:0')).toBe(0);
  });

  it('refuses to wipe the map when the snapshot is empty or unavailable', () => {
    recordFusionRound(1, ['a:0'], ['kept:0']);
    // An empty snapshot means "we do not know", not "everything is spent".
    pruneSpentDepth(1, new Set());
    expect(coinDepth(1, 'kept:0')).toBe(1);
  });
});
