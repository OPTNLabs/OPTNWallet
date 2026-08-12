/**
 * Resolve confirmed block heights for history rows stuck at height 0/-1.
 * Fusion completion injects CoinJoins at height 0; Electrum verbose get knows
 * the real height long before (or instead of) address history rewriting SQL.
 *
 * Fulcrum/bitcoind-style verbose `transaction.get` often returns `confirmations`
 * but omits `height`. We always derive height from tip when confs > 0 so the
 * History list (which only checks `height > 0`) can leave "Fused · Unconfirmed".
 */
import type { TransactionHistoryItem } from '../types/types';
import ElectrumService from './ElectrumService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import type { AppDispatch } from '../state/store';
import { addTransactions } from '../state/slices/transactionSlice';

/** Cap parallel verbose fetches so a 50-row fusion history does not stampede Fulcrum. */
const BACKFILL_CONCURRENCY = 6;

function parseTipHeight(tip: unknown): number | null {
  if (typeof tip === 'number' && Number.isFinite(tip) && tip > 0) return tip;
  if (tip && typeof tip === 'object') {
    const h = (tip as { height?: unknown }).height;
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) return h;
  }
  return null;
}

/** Resolve a positive block height from verbose details + optional tip. */
export async function resolveConfirmedBlockHeight(details: {
  height?: number | null;
  confirmations?: number | null;
}): Promise<number | null> {
  if (typeof details.height === 'number' && details.height > 0) {
    return details.height;
  }
  const confs =
    typeof details.confirmations === 'number' &&
    Number.isFinite(details.confirmations)
      ? details.confirmations
      : 0;
  if (confs <= 0) return null;
  try {
    const tip = parseTipHeight(await ElectrumService.getLatestBlock());
    if (tip == null) return null;
    const height = tip - confs + 1;
    return height > 0 ? height : null;
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export async function backfillConfirmedHistoryHeights(args: {
  walletId: number;
  transactions: readonly TransactionHistoryItem[];
  sessionGeneration?: number;
  dispatch?: AppDispatch;
  forceRefresh?: boolean;
}): Promise<TransactionHistoryItem[]> {
  const {
    walletId,
    transactions,
    sessionGeneration,
    dispatch,
    forceRefresh = true,
  } = args;
  if (!Number.isInteger(walletId) || walletId <= 0) {
    return [...transactions];
  }

  const byHash = new Map(
    transactions.map((tx) => [
      String(tx.tx_hash).trim().toLowerCase(),
      { ...tx, tx_hash: String(tx.tx_hash).trim().toLowerCase() },
    ])
  );

  const stuck = [...byHash.values()].filter(
    (tx) => !(typeof tx.height === 'number' && tx.height > 0)
  );
  if (stuck.length === 0) return [...byHash.values()];

  const manager = TransactionManager();
  await mapPool(stuck, BACKFILL_CONCURRENCY, async (tx) => {
    // Always force-refresh stuck rows: a prior persist with confs but no height
    // would otherwise be returned from the details cache/SQL forever.
    const details = await ElectrumService.getTransactionDetails(tx.tx_hash, {
      // Stuck rows must not reuse a details row that stored confs without height.
      forceRefresh,
    });
    if (!details) return;

    const height = await resolveConfirmedBlockHeight(details);
    if (height == null) return;

    const updated: TransactionHistoryItem = {
      ...tx,
      height,
      timestamp: details.timestamp ?? tx.timestamp,
    };
    byHash.set(tx.tx_hash, updated);

    try {
      await manager.applyConfirmedHeight(
        walletId,
        tx.tx_hash,
        height,
        details.timestamp
      );
    } catch {
      /* best-effort SQL */
    }

    if (dispatch) {
      dispatch(
        addTransactions({
          wallet_id: walletId,
          transactions: [updated],
          sessionGeneration,
        })
      );
    }
  });

  return [...byHash.values()];
}
