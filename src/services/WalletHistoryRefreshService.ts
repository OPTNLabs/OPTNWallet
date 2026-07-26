// Refresh a wallet's transaction history — the one implementation.
//
// This used to live inside `useTransactionHistoryFetch`, which meant only a
// mounted history page could refresh history. The Home screen's Recent Activity
// reads the same redux slice but mounts no such hook, so incoming payments
// updated the balance (the address subscription refreshes UTXOs) while the
// activity list stayed stale until the user navigated, which remounted the hook
// and reset its scan cache. "Click it and it syncs" was that remount, not a
// refresh.
//
// Extracting it here lets the address subscription and the history page call the
// SAME code, so the two cannot drift — the same reason fusion has one runner.

import TransactionManager from '../apis/TransactionManager/TransactionManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { setTransactions } from '../state/slices/transactionSlice';
import type { AppDispatch } from '../state/store';
import type { TransactionHistoryItem } from '../types/types';
import ElectrumService from './ElectrumService';
import { reconcileOutboundTransactions } from './OutboundTransactionReconciler';
import { planTransactionDetailRefresh } from './transactionDetailSync';
import { runOutboundReconcile, runWalletHistoryRefresh } from './RefreshCoordinator';
import QuantumrootTrackingService from './QuantumrootTrackingService';

type SqlLikeDb = {
  prepare: (sql: string) => {
    bind: (params: [number]) => void;
    step: () => boolean;
    getAsObject: () => Record<string, unknown>;
    free: () => void;
  };
};

function toHistoryItem(row: Record<string, unknown>): TransactionHistoryItem {
  return {
    tx_hash: String(row.tx_hash ?? ''),
    height: Number(row.height ?? 0),
    timestamp:
      row.timestamp === null || row.timestamp === undefined
        ? undefined
        : String(row.timestamp),
    amount:
      row.amount === null || row.amount === undefined
        ? undefined
        : (row.amount as string | number),
  };
}

export function loadStoredTransactions(
  db: SqlLikeDb,
  walletId: number
): TransactionHistoryItem[] {
  const query = db.prepare(`
    SELECT tx_hash, height, timestamp, amount
    FROM transactions
    WHERE wallet_id = ?;
  `);
  query.bind([walletId]);
  const rows: TransactionHistoryItem[] = [];
  while (query.step()) {
    rows.push(toHistoryItem(query.getAsObject()));
  }
  query.free();
  return rows;
}

export interface RefreshWalletHistoryOptions {
  walletId: number;
  dispatch: AppDispatch;
  /**
   * Addresses already scanned in this pass, skipped to keep an initial page load
   * incremental. Omit for a full refresh — which is what a NEW TRANSACTION
   * needs: the payment arrives on an address that has very likely been scanned
   * already, so honouring the skip set here would filter out the only address
   * that changed and refresh nothing.
   */
  skipAddresses?: ReadonlySet<string>;
  onProgress?: (percent: number) => void;
}

export interface RefreshWalletHistoryResult {
  /** Addresses whose history was fetched, for the caller's incremental cache. */
  scannedAddresses: string[];
  /** False when the refresh was joined/coalesced or the DB was unavailable. */
  refreshed: boolean;
}

/**
 * Fetch history for a wallet's addresses, persist it, and publish it to redux.
 *
 * Coalesced by `runWalletHistoryRefresh`, so bursts of address subscriptions
 * collapse into one pass rather than one request per address.
 */
export async function refreshWalletTransactionHistory(
  options: RefreshWalletHistoryOptions
): Promise<RefreshWalletHistoryResult> {
  const { walletId, dispatch, skipAddresses, onProgress } = options;
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    return { scannedAddresses: [], refreshed: false };
  }

  const dbService = DatabaseService();
  let scannedAddresses: string[] = [];
  let refreshed = false;

  await runWalletHistoryRefresh(walletId, async () => {
    await ElectrumService.reconnect();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase() as SqlLikeDb | null;
    if (!db) {
      console.error('Database not started.');
      return;
    }

    const previousStoredTransactions = loadStoredTransactions(db, walletId);

    const addressesQuery = db.prepare(`
      SELECT address FROM addresses WHERE wallet_id = ?;
    `);
    addressesQuery.bind([walletId]);
    const addresses: string[] = [];
    while (addressesQuery.step()) {
      const row = addressesQuery.getAsObject();
      if (typeof row.address === 'string') addresses.push(row.address);
    }
    addressesQuery.free();

    const quantumrootAddresses =
      await QuantumrootTrackingService.listTrackedAddresses(walletId);
    addresses.push(...quantumrootAddresses);

    const pending = skipAddresses
      ? addresses.filter((address) => !skipAddresses.has(address))
      : addresses;

    if (pending.length === 0) {
      onProgress?.(100);
      // Nothing to scan is still a completed pass; redux already matches the DB.
      refreshed = true;
      return;
    }

    const historyByAddress = await TransactionManager().fetchAndStoreTransactionHistories(
      walletId,
      pending
    );

    const processed: string[] = [];
    pending.forEach((address, index) => {
      if (Array.isArray(historyByAddress[address])) processed.push(address);
      onProgress?.(Math.round(((index + 1) / pending.length) * 100));
    });
    scannedAddresses = processed;

    const liveDb = dbService.getDatabase() as SqlLikeDb | null;
    if (!liveDb) {
      console.error('Database not started after history fetch.');
    } else {
      const storedTransactions = loadStoredTransactions(liveDb, walletId);
      const refreshPlan = planTransactionDetailRefresh({
        previous: previousStoredTransactions,
        next: storedTransactions,
      });

      const txidsToWarm = refreshPlan.reorgDetected
        ? storedTransactions.map((tx) => tx.tx_hash)
        : refreshPlan.txidsToRefresh;

      if (txidsToWarm.length > 0) {
        void Promise.allSettled(
          txidsToWarm.map((txid) =>
            ElectrumService.getTransactionDetails(txid, {
              forceRefresh: refreshPlan.reorgDetected,
            })
          )
        );
      }

      dispatch(
        setTransactions({ wallet_id: walletId, transactions: storedTransactions })
      );
      refreshed = true;
    }

    await runOutboundReconcile(walletId, () =>
      reconcileOutboundTransactions(walletId)
    );
    onProgress?.(100);
  });

  return { scannedAddresses, refreshed };
}
