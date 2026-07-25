import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFusionDepth,
  coinDepth,
  coinsBelowDepth,
  recordFusionRound,
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

  it('drops spent inputs so the map tracks live coins, not history', () => {
    recordFusionRound(1, ['spent:0'], ['made:0']);
    // The input was consumed by the round and can never reappear.
    expect(coinDepth(1, 'spent:0')).toBe(0);
    expect(coinDepth(1, 'made:0')).toBe(1);
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
