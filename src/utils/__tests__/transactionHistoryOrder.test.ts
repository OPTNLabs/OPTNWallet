import { describe, expect, it } from 'vitest';
import {
  isMempoolLike,
  sortTransactionsByRecency,
  takeRecentTransactions,
} from '../transactionHistoryOrder';

const tx = (
  hash: string,
  height: number,
  timestamp?: string
): { tx_hash: string; height: number; timestamp?: string } => ({
  tx_hash: hash,
  height,
  ...(timestamp ? { timestamp } : {}),
});

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

describe('transactionHistoryOrder — newest first', () => {
  it('live mempool first, then confirmed high block → older blocks', () => {
    const list = [
      tx('old', 100),
      tx('fused_conf', 500),
      tx('mid', 200),
      tx('mempool', 0, minutesAgo(5)),
      tx('pending', -1, minutesAgo(1)),
    ];
    const sorted = sortTransactionsByRecency(list, 'desc');
    expect(sorted.map((t) => t.tx_hash)).toEqual([
      'pending',
      'mempool',
      'fused_conf',
      'mid',
      'old',
    ]);
  });

  it('puts a recent fusion above older live unconfirmed by timestamp', () => {
    const list = [
      tx('old_pending', 0, minutesAgo(10)),
      tx('older_conf', 100),
      tx('fused_new', 0, minutesAgo(1)),
    ];
    const sorted = sortTransactionsByRecency(list, 'desc');
    expect(sorted.map((t) => t.tx_hash)).toEqual([
      'fused_new',
      'old_pending',
      'older_conf',
    ]);
  });

  it('does not park stale height-0 fusion above real confirmed blocks', () => {
    const stale = tx('old_fusion', 0, minutesAgo(24 * 60));
    expect(isMempoolLike(stale)).toBe(false);
    const list = [stale, tx('real_conf', 317_000)];
    const sorted = sortTransactionsByRecency(list, 'desc');
    expect(sorted.map((t) => t.tx_hash)).toEqual(['real_conf', 'old_fusion']);
  });

  it('does not treat array index as time (slice(-N).reverse bug)', () => {
    const list = [
      tx('fused_new', 900),
      tx('old_a', 100),
      tx('old_b', 101),
      tx('old_c', 102),
    ];
    const broken = [...list].slice(-3).reverse();
    expect(broken[0].tx_hash).toBe('old_c');

    const recent = takeRecentTransactions(list, 3);
    expect(recent.map((t) => t.tx_hash)).toEqual([
      'fused_new',
      'old_c',
      'old_b',
    ]);
  });

  it('oldest-first puts live unconfirmed last', () => {
    const list = [tx('a', 10), tx('b', 0), tx('c', 20)];
    const sorted = sortTransactionsByRecency(list, 'asc');
    expect(sorted.map((t) => t.tx_hash)).toEqual(['a', 'c', 'b']);
  });
});
