import { describe, expect, it } from 'vitest';
import {
  sortTransactionsByRecency,
  takeRecentTransactions,
} from '../transactionHistoryOrder';

const tx = (hash: string, height: number) => ({
  tx_hash: hash,
  height,
});

describe('transactionHistoryOrder', () => {
  it('puts unconfirmed before confirmed, then high block first', () => {
    const list = [
      tx('old', 100),
      tx('fused', 500),
      tx('mid', 200),
      tx('mempool', 0),
      tx('pending', -1),
    ];
    const sorted = sortTransactionsByRecency(list, 'desc');
    expect(sorted.map((t) => t.tx_hash)).toEqual([
      'pending', // reverse of unconfirmed encounter: pending then mempool → reverse
      'mempool',
      'fused',
      'mid',
      'old',
    ]);
  });

  it('does not treat array index as time (slice(-N).reverse bug)', () => {
    // New fused CoinJoin appears early in the store array; older txs later.
    const list = [
      tx('fused_new', 900),
      tx('old_a', 100),
      tx('old_b', 101),
      tx('old_c', 102),
    ];
    // Broken home logic would reverse the tail and put old_c first.
    const broken = [...list].slice(-3).reverse();
    expect(broken[0].tx_hash).toBe('old_c');

    const recent = takeRecentTransactions(list, 3);
    expect(recent.map((t) => t.tx_hash)).toEqual([
      'fused_new',
      'old_c',
      'old_b',
    ]);
  });

  it('oldest-first puts unconfirmed last', () => {
    const list = [tx('a', 10), tx('b', 0), tx('c', 20)];
    const sorted = sortTransactionsByRecency(list, 'asc');
    expect(sorted.map((t) => t.tx_hash)).toEqual(['a', 'c', 'b']);
  });
});
