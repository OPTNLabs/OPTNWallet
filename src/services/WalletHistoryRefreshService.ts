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
import {
  runOutboundReconcile,
  runWalletHistoryRefresh,
  runWalletHistoryRefreshExclusive,
} from './RefreshCoordinator';
import QuantumrootTrackingService from './QuantumrootTrackingService';
import { mergeRecordedFusionTxsIntoHistory } from '../platform/desktop/fusionCoinDepth';
import { backfillConfirmedHistoryHeights } from './historyHeightBackfill';

type SqlLikeDb = {
  prepare: (sql: string) => {
    bind: (params: [number]) => void;
    step: () => boolean;
    getAsObject: () => Record<string, unknown>;
    free: () => void;
  };
};

function toHistoryItem(row: Record<string, unknown>): TransactionHistoryItem {
  const sqlHeight = Number(row.height ?? 0);
  const detailHeight = Number(row.detail_height ?? 0);
  const confirmations = Number(row.confirmations ?? 0);
  const height =
    detailHeight > 0 && detailHeight >= sqlHeight
      ? detailHeight
      : sqlHeight;
  return {
    tx_hash: String(row.tx_hash ?? ''),
    height,
    confirmations: confirmations > 0 ? confirmations : undefined,
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
  // Prefer verbose Electrum details (confirmations / height) so a fusion
  // CoinJoin stored at height 0 still paints Confirmed on the next open.
  let query;
  try {
    query = db.prepare(`
      SELECT t.tx_hash AS tx_hash,
             t.height AS height,
             t.timestamp AS timestamp,
             t.amount AS amount,
             d.height AS detail_height,
             d.confirmations AS confirmations
      FROM transactions t
      LEFT JOIN transaction_details d
        ON d.wallet_id = t.wallet_id
       AND lower(d.tx_hash) = lower(t.tx_hash)
      WHERE t.wallet_id = ?
      ORDER BY
        CASE WHEN COALESCE(d.height, t.height, 0) > 0
          THEN COALESCE(d.height, t.height) ELSE 0 END DESC,
        t.timestamp DESC
      LIMIT 2000;
    `);
  } catch {
    query = db.prepare(`
      SELECT tx_hash, height, timestamp, amount
      FROM transactions
      WHERE wallet_id = ?
      ORDER BY height DESC, timestamp DESC
      LIMIT 2000;
    `);
  }
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
  /** Session generation captured before the async scan began. */
  sessionGeneration?: number;
  /**
   * Addresses already scanned in this pass, skipped to keep an initial page load
   * incremental. Omit for a full refresh — which is what a NEW TRANSACTION
   * needs: the payment arrives on an address that has very likely been scanned
   * already, so honouring the skip set here would filter out the only address
   * that changed and refresh nothing.
   */
  skipAddresses?: ReadonlySet<string>;
  /**
   * User-initiated (Manual Sync / Rebuild). Does not join a background history
   * pass (those freeze the bar at 55% with no onProgress). Skips the status-hash
   * gate so every known address is re-fetched.
   */
  force?: boolean;
  onProgress?: (percent: number) => void;
}

export interface RefreshWalletHistoryResult {
  /** Addresses whose history was fetched, for the caller's incremental cache. */
  scannedAddresses: string[];
  /** False when the refresh was joined/coalesced or the DB was unavailable. */
  refreshed: boolean;
}

/**
 * Local-first paint: last saved SQL history → Redux. No Electrum, no
 * coordinator/cooldown (those skipped the paint and made Home look empty).
 *
 * Call as soon as the wallet id is set (open / Home mount). Network refresh
 * can follow; it must not gate this.
 */
export async function publishStoredWalletHistory(args: {
  walletId: number;
  dispatch: AppDispatch;
  sessionGeneration?: number;
}): Promise<number> {
  const { walletId, dispatch, sessionGeneration } = args;
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return 0;

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase() as SqlLikeDb | null;
  if (!db) return 0;

  const stored = mergeRecordedFusionTxsIntoHistory(
    walletId,
    loadStoredTransactions(db, walletId)
  );
  if (stored.length === 0) return 0;

  dispatch(
    setTransactions({
      wallet_id: walletId,
      transactions: stored,
      sessionGeneration,
    })
  );
  return stored.length;
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
  const {
    walletId,
    dispatch,
    sessionGeneration,
    skipAddresses,
    force = false,
    onProgress,
  } = options;
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    return { scannedAddresses: [], refreshed: false };
  }

  const dbService = DatabaseService();
  let scannedAddresses: string[] = [];
  let refreshed = false;

  const runBody = async () => {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase() as SqlLikeDb | null;
    if (!db) {
      console.error('Database not started.');
      return;
    }

    const previousStoredTransactions = loadStoredTransactions(db, walletId);

    // Local-first (EC / Selene / Monero GUI): paint last saved SQL history
    // immediately. No per-row streaming. Background backfill publishes ONCE
    // when all stuck heights resolve, then address history scan may replace.
    let initialPaint = mergeRecordedFusionTxsIntoHistory(
      walletId,
      previousStoredTransactions
    );
    if (initialPaint.length > 0) {
      dispatch(
        setTransactions({
          wallet_id: walletId,
          transactions: initialPaint,
          sessionGeneration,
        })
      );
    }

    const hasStuckHeights = initialPaint.some(
      (tx) => !(typeof tx.height === 'number' && tx.height > 0)
    );
    let earlyBackfill: Promise<TransactionHistoryItem[]> = Promise.resolve(
      initialPaint
    );
    if (hasStuckHeights) {
      // Single batched Redux update inside backfill when dispatch is set.
      earlyBackfill = (async () => {
        try {
          await ElectrumService.ensureFreshConnection();
        } catch {
          /* offline */
        }
        return backfillConfirmedHistoryHeights({
          walletId,
          transactions: initialPaint,
          sessionGeneration,
          dispatch,
          forceRefresh: true,
        });
      })();
    }

    // Prefer the addresses table (software wallets register there via createKeys).
    // Hardware / older watch-only rows may only have `keys` populated — fall back
    // so history and Recent Activity are not permanently empty.
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

    if (addresses.length === 0) {
      const keysQuery = db.prepare(`
        SELECT address FROM keys WHERE wallet_id = ? AND address IS NOT NULL;
      `);
      keysQuery.bind([walletId]);
      while (keysQuery.step()) {
        const row = keysQuery.getAsObject();
        if (typeof row.address === 'string' && row.address) {
          addresses.push(row.address);
        }
      }
      keysQuery.free();
    }

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

    // Network is the long phase — report while batches complete, not only after
    // the entire multi-address history RPC returns (that made the bar freeze
    // then jump, and made manual Sync feel like the "old slow path").
    onProgress?.(5);

    // Status-hash delta (EC/Selene): skip addresses whose local history status
    // already matches the Electrum address state. Force / Manual Sync skips the
    // gate entirely (statuses were cleared or user wants a full recheck).
    let toFetch = pending;
    if (!force) {
      try {
        const ledger = await import('../platform/desktop/WalletLedgerService');
        const partition = await ledger.partitionAddressesByStatus(
          walletId,
          pending
        );
        toFetch = partition.dirty;
        onProgress?.(
          5 + Math.round(20 * (1 - toFetch.length / Math.max(pending.length, 1)))
        );
      } catch {
        toFetch = pending;
      }
    } else {
      onProgress?.(10);
    }

    const transactionManager = TransactionManager();
    const mapHistoryProgress = (done: number, total: number) => {
      if (total <= 0) return;
      // Reserve 25–90% for Electrum history batches; DB/redux publish is 90–100.
      onProgress?.(25 + Math.round(65 * (done / total)));
    };
    const historyByAddress =
      toFetch.length === 0
        ? ({} as Record<string, TransactionHistoryItem[] | undefined>)
        : sessionGeneration === undefined
          ? await transactionManager.fetchAndStoreTransactionHistories(
              walletId,
              toFetch,
              undefined,
              mapHistoryProgress
            )
          : await transactionManager.fetchAndStoreTransactionHistories(
              walletId,
              toFetch,
              sessionGeneration,
              mapHistoryProgress
            );

    const processed: string[] = [];
    for (const address of pending) {
      if (Array.isArray(historyByAddress[address])) processed.push(address);
    }
    scannedAddresses = processed;
    onProgress?.(90);

    const liveDb = dbService.getDatabase() as SqlLikeDb | null;
    if (!liveDb) {
      console.error('Database not started after history fetch.');
    } else {
      let storedTransactions = mergeRecordedFusionTxsIntoHistory(
        walletId,
        loadStoredTransactions(liveDb, walletId)
      );
      // Keep heights the early open-time backfill already resolved (prefer > 0).
      try {
        const earlyFilled = await earlyBackfill;
        const earlyByHash = new Map(
          earlyFilled.map((tx) => [
            String(tx.tx_hash).trim().toLowerCase(),
            tx,
          ] as const)
        );
        storedTransactions = storedTransactions.map((tx) => {
          const key = String(tx.tx_hash).trim().toLowerCase();
          const early = earlyByHash.get(key);
          if (
            early &&
            typeof early.height === 'number' &&
            early.height > 0 &&
            !(typeof tx.height === 'number' && tx.height > 0)
          ) {
            return {
              ...tx,
              height: early.height,
              timestamp: early.timestamp ?? tx.timestamp,
            };
          }
          return tx;
        });
      } catch {
        /* early backfill best-effort */
      }
      // Any rows still at height 0 (new from network history) get a second pass.
      storedTransactions = await backfillConfirmedHistoryHeights({
        walletId,
        transactions: storedTransactions,
        sessionGeneration,
        dispatch,
        forceRefresh: true,
      });

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

      // Publish AFTER backfill so Sync cannot repaint height-0 fusion stubs.
      dispatch(
        setTransactions({
          wallet_id: walletId,
          transactions: storedTransactions,
          sessionGeneration,
        })
      );
      refreshed = true;
    }

    await runOutboundReconcile(walletId, () =>
      reconcileOutboundTransactions(walletId)
    );
    onProgress?.(100);
  };

  if (force) {
    // Manual Sync: exclusive pass with our onProgress (see coordinator).
    onProgress?.(2);
    await runWalletHistoryRefreshExclusive(walletId, runBody);
  } else {
    await runWalletHistoryRefresh(walletId, runBody);
  }

  return { scannedAddresses, refreshed };
}
