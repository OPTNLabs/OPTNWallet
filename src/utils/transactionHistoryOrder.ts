// Single ordering rule for wallet tx lists (Home recent + History).
//
// Newest-first default (what users expect):
//   1) Unconfirmed / mempool (height <= 0) at the top — newest first among them
//   2) Then confirmed, higher block height first (more recent blocks)
//   3) Same height / no timestamp: stable txid tie-break
//
// Fusion injects CoinJoins with height 0 + ISO timestamp so they stay on top
// until confirmed; Electrum merges must keep that timestamp (see transactionSlice).

import type { TransactionHistoryItem } from '../types/types';

export type TransactionSortOrder = 'asc' | 'desc';

function isUnconfirmed(tx: TransactionHistoryItem): boolean {
  return !Number.isFinite(tx.height) || tx.height <= 0;
}

/** Prefer real timestamps; else use list index (later merge = more recent). */
function recencyMs(tx: TransactionHistoryItem, indexInList: number): number {
  if (tx.timestamp != null && String(tx.timestamp).trim() !== '') {
    const parsed = Date.parse(String(tx.timestamp));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return indexInList;
}

/**
 * Newest first by default:
 *   unconfirmed (newest → older) → confirmed high block → older blocks.
 */
export function sortTransactionsByRecency(
  transactions: readonly TransactionHistoryItem[],
  sortOrder: TransactionSortOrder = 'desc'
): TransactionHistoryItem[] {
  const indexed = transactions.map((tx, index) => ({ tx, index }));

  const unconfirmed = indexed.filter(({ tx }) => isUnconfirmed(tx));
  const confirmed = indexed.filter(({ tx }) => !isUnconfirmed(tx));

  // Among confirmed: primary height, secondary timestamp (when Electrum sets it).
  const cmpConfirmedDesc = (
    a: { tx: TransactionHistoryItem; index: number },
    b: { tx: TransactionHistoryItem; index: number }
  ) =>
    b.tx.height - a.tx.height ||
    recencyMs(b.tx, b.index) - recencyMs(a.tx, a.index) ||
    a.tx.tx_hash.localeCompare(b.tx.tx_hash);

  const cmpConfirmedAsc = (
    a: { tx: TransactionHistoryItem; index: number },
    b: { tx: TransactionHistoryItem; index: number }
  ) =>
    a.tx.height - b.tx.height ||
    recencyMs(a.tx, a.index) - recencyMs(b.tx, b.index) ||
    a.tx.tx_hash.localeCompare(b.tx.tx_hash);

  const cmpUnconfirmedDesc = (
    a: { tx: TransactionHistoryItem; index: number },
    b: { tx: TransactionHistoryItem; index: number }
  ) =>
    recencyMs(b.tx, b.index) - recencyMs(a.tx, a.index) ||
    a.tx.tx_hash.localeCompare(b.tx.tx_hash);

  const cmpUnconfirmedAsc = (
    a: { tx: TransactionHistoryItem; index: number },
    b: { tx: TransactionHistoryItem; index: number }
  ) =>
    recencyMs(a.tx, a.index) - recencyMs(b.tx, b.index) ||
    a.tx.tx_hash.localeCompare(b.tx.tx_hash);

  const sortedConfirmed = [...confirmed]
    .sort(sortOrder === 'asc' ? cmpConfirmedAsc : cmpConfirmedDesc)
    .map(({ tx }) => tx);
  const sortedUnconfirmed = [...unconfirmed]
    .sort(sortOrder === 'asc' ? cmpUnconfirmedAsc : cmpUnconfirmedDesc)
    .map(({ tx }) => tx);

  if (sortOrder === 'asc') {
    // Oldest first: confirmed ascending, unconfirmed last.
    return [...sortedConfirmed, ...sortedUnconfirmed];
  }
  // Newest first: unconfirmed (newest→older), then confirmed (newer blocks→older).
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
