// Single ordering rule for wallet tx lists (Home recent + History).
//
// Redux does not keep a stable chronological array: Electrum history is merged
// by address, and addTransactions appends batches. Home used to do
// `slice(-8).reverse()`, which treats array index as time — so a brand-new
// fused CoinJoin (high block or unconfirmed) could sit in the middle of the
// array and show BELOW older txs. Sort by confirmation height instead.

import type { TransactionHistoryItem } from '../types/types';

export type TransactionSortOrder = 'asc' | 'desc';

/**
 * Newest-first by default:
 *   1) unconfirmed / mempool (height <= 0) first
 *   2) confirmed by block height (higher = newer)
 *   3) txid tie-break for stability
 */
export function sortTransactionsByRecency(
  transactions: readonly TransactionHistoryItem[],
  sortOrder: TransactionSortOrder = 'desc'
): TransactionHistoryItem[] {
  const unconfirmed = transactions.filter((tx) => tx.height <= 0);
  const confirmed = transactions.filter((tx) => tx.height > 0);

  const byHeight =
    sortOrder === 'asc'
      ? (a: TransactionHistoryItem, b: TransactionHistoryItem) =>
          a.height - b.height || a.tx_hash.localeCompare(b.tx_hash)
      : (a: TransactionHistoryItem, b: TransactionHistoryItem) =>
          b.height - a.height || a.tx_hash.localeCompare(b.tx_hash);

  const sortedConfirmed = [...confirmed].sort(byHeight);
  // Unconfirmed: reverse filter order so the most recently merged batch tends
  // to float up (same as History).
  const sortedUnconfirmed = [...unconfirmed].reverse();

  if (sortOrder === 'asc') {
    // Oldest first: confirmed ascending, then unconfirmed last.
    return [...sortedConfirmed, ...sortedUnconfirmed];
  }
  // Newest first: unconfirmed, then confirmed high→low.
  return [...sortedUnconfirmed, ...sortedConfirmed];
}

/** Top N newest txs for Home “Recent Activity”. */
export function takeRecentTransactions(
  transactions: readonly TransactionHistoryItem[] | undefined | null,
  limit = 8
): TransactionHistoryItem[] {
  const list = transactions ?? [];
  if (list.length === 0 || limit <= 0) return [];
  return sortTransactionsByRecency(list, 'desc').slice(0, limit);
}
