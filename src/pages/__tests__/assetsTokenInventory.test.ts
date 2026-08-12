import { describe, expect, it } from 'vitest';
import type { UTXO } from '../../types/types';
import { dedupeTokenUtxos, getStableTokenUtxos } from '../assetsTokenInventory';

function tokenUtxo(
  txHash: string,
  txPos: number,
  category: string,
  amount: number
): UTXO {
  return {
    address: 'bitcoincash:q1',
    height: 1,
    tx_hash: txHash,
    tx_pos: txPos,
    value: 1000,
    amount: 1000,
    token: {
      category,
      amount,
    },
  };
}

describe('assetsTokenInventory', () => {
  it('dedupes token utxos by outpoint', () => {
    const rows = [
      tokenUtxo('a'.repeat(64), 0, 'cat-a', 1),
      tokenUtxo('a'.repeat(64), 0, 'cat-b', 2),
      tokenUtxo('b'.repeat(64), 1, 'cat-c', 3),
      {
        address: 'bitcoincash:q1',
        height: 1,
        tx_hash: 'c'.repeat(64),
        tx_pos: 2,
        value: 1000,
        amount: 1000,
      } as UTXO,
    ];

    expect(dedupeTokenUtxos(rows)).toEqual([
      tokenUtxo('a'.repeat(64), 0, 'cat-b', 2),
      tokenUtxo('b'.repeat(64), 1, 'cat-c', 3),
    ]);
  });

  it('returns the first non-empty token snapshot from the available sources', () => {
    const fallback = [tokenUtxo('b'.repeat(64), 1, 'cat-b', 4)];
    const redux = [tokenUtxo('c'.repeat(64), 2, 'cat-c', 5)];

    expect(getStableTokenUtxos([], fallback, redux)).toEqual(fallback);
    expect(getStableTokenUtxos([], [], redux)).toEqual(redux);
    expect(getStableTokenUtxos([], [], [])).toEqual([]);
  });
});
