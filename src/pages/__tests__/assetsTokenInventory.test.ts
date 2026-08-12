import { describe, expect, it } from 'vitest';
import type { UTXO } from '../../types/types';
import {
  dedupeTokenUtxos,
  getStableTokenUtxos,
  summarizeNftInstances,
} from '../assetsTokenInventory';

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

function nftTokenUtxo(
  txHash: string,
  txPos: number,
  category: string,
  commitment: string
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
      amount: 0,
      nft: {
        capability: 'none',
        commitment,
      },
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

  it('summarizes NFT instances individually even when the category matches', () => {
    const category = 'ff'.repeat(32);
    const instances = summarizeNftInstances([
      nftTokenUtxo('a'.repeat(64), 0, category, 'commitment-a'),
      nftTokenUtxo('b'.repeat(64), 1, category, 'commitment-b'),
      nftTokenUtxo('a'.repeat(64), 0, category, 'commitment-overwrite'),
    ]);

    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      outpoint: `${'a'.repeat(64)}:0`,
      category,
      capability: 'none',
      commitment: 'commitment-overwrite',
    });
    expect(instances[1]).toMatchObject({
      outpoint: `${'b'.repeat(64)}:1`,
      category,
      capability: 'none',
      commitment: 'commitment-b',
    });
  });
});
