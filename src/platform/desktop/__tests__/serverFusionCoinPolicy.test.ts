import { describe, expect, it } from 'vitest';
import type { UTXO } from '../../../types/types';
import {
  classifyServerFusionCoins,
  isServerFusionDepthSatisfied,
  selectServerFusionBuckets,
} from '../serverFusionCoinPolicy';

type PolicyCoin = UTXO & {
  is_frozen_coin?: boolean;
  isFrozenAddress?: boolean;
};

const coin = (
  address: string,
  n: number,
  overrides: Partial<PolicyCoin> = {}
): PolicyCoin => ({
  address,
  height: 100,
  tx_hash: n.toString(16).padStart(64, '0'),
  tx_pos: 0,
  value: 1_000,
  ...overrides,
});

describe('Electron Cash server Fusion coin policy', () => {
  it('rejects the whole address bucket for tokens, frozen flags, unconfirmed coins, or more than three coins', () => {
    const coins: PolicyCoin[] = [
      coin('eligible', 1),
      coin('eligible', 2),
      coin('token-address', 3),
      coin('token-address', 4, {
        token_data: { amount: 1, category: 'aa'.repeat(32) },
      }),
      coin('frozen-address', 5, { is_frozen_coin: true }),
      coin('unconfirmed-address', 6, { height: 0 }),
      coin('too-many', 7),
      coin('too-many', 8),
      coin('too-many', 9),
      coin('too-many', 10),
    ];

    const result = classifyServerFusionCoins(coins);

    expect(result.eligibleBuckets.map((bucket) => bucket.address)).toEqual([
      'eligible',
    ]);
    expect(result.eligibleBuckets[0].coins).toHaveLength(2);
    expect(
      result.ineligibleBuckets.map((bucket) => bucket.address).sort()
    ).toEqual([
      'frozen-address',
      'token-address',
      'too-many',
      'unconfirmed-address',
    ]);
    expect(result.hasUnconfirmed).toBe(true);
    expect(result.totalValue).toBe(10_000);
  });

  it('randomly selects whole address buckets without exceeding the EC 20-coin cap', () => {
    const classified = classifyServerFusionCoins(
      Array.from({ length: 8 }, (_, addressIndex) =>
        Array.from({ length: 3 }, (_, coinIndex) =>
          coin(`address-${addressIndex}`, addressIndex * 10 + coinIndex)
        )
      ).flat()
    );
    const selected = selectServerFusionBuckets(classified.eligibleBuckets, {
      fraction: 1,
      random: () => 0,
    });

    expect(selected.flatMap((bucket) => bucket.coins)).toHaveLength(18);
    expect(selected.every((bucket) => bucket.coins.length === 3)).toBe(true);
  });

  it('uses the EC fallback bucket when random sampling selects nothing', () => {
    const buckets = classifyServerFusionCoins([
      coin('first', 1),
      coin('second', 2),
    ]).eligibleBuckets;

    const selected = selectServerFusionBuckets(buckets, {
      fraction: 0,
      random: () => 0.9,
      shuffle: false,
    });

    expect(selected.map((bucket) => bucket.address)).toEqual(['first']);
  });

  it('stops at the EC 99.9% eligible-value depth threshold', () => {
    const buckets = classifyServerFusionCoins([
      coin('large', 1, { value: 999_000 }),
      coin('dust', 2, { value: 1_000 }),
    ]).eligibleBuckets;
    const depths = new Map([
      [`${'1'.padStart(64, '0')}:0`, 3],
      [`${'2'.padStart(64, '0')}:0`, 0],
    ]);

    expect(
      isServerFusionDepthSatisfied(buckets, {
        fuseDepth: 3,
        depthOf: (outpoint) => depths.get(outpoint) ?? 0,
      })
    ).toMatchObject({ satisfied: true, ratio: 0.999 });

    const belowThreshold = classifyServerFusionCoins([
      coin('large', 1, { value: 998_999 }),
      coin('dust', 2, { value: 1_001 }),
    ]).eligibleBuckets;
    expect(
      isServerFusionDepthSatisfied(belowThreshold, {
        fuseDepth: 3,
        depthOf: (outpoint) => depths.get(outpoint) ?? 0,
      }).satisfied
    ).toBe(false);
  });

  it('counts an address as depth-complete when any coin in that address reaches the configured depth, matching EC is_fuz_address', () => {
    const buckets = classifyServerFusionCoins([
      coin('shared', 1, { value: 600 }),
      coin('shared', 2, { value: 400 }),
    ]).eligibleBuckets;

    const result = isServerFusionDepthSatisfied(buckets, {
      fuseDepth: 3,
      depthOf: (outpoint) =>
        outpoint.startsWith('0'.repeat(63) + '1') ? 3 : 0,
    });

    expect(result).toMatchObject({
      satisfied: true,
      eligibleValue: 1_000,
      depthSatisfiedValue: 1_000,
    });
  });
});
