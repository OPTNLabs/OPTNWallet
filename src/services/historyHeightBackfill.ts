/**
 * Resolve confirmed block heights for history rows stuck at height 0/-1.
 * Fusion completion injects CoinJoins at height 0; Electrum verbose get knows
 * the real height long before (or instead of) address history rewriting SQL.
 *
 * Design: batch SQL writes + one disk persist + one Redux publish (caller).
 * Progressive per-tx dispatch made every open look like a live “catch-up”
 * (EC/Selene/Monero show last saved state and quiet-refresh in the background).
 */
import type { TransactionHistoryItem } from '../types/types';
import ElectrumService from './ElectrumService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import type { AppDispatch } from '../state/store';
import { setTransactions } from '../state/slices/transactionSlice';

const BACKFILL_CONCURRENCY = 12;

function parseTipHeight(tip: unknown): number | null {
  if (typeof tip === 'number' && Number.isFinite(tip) && tip > 0) return tip;
  if (tip && typeof tip === 'object') {
    const h = (tip as { height?: unknown }).height;
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) return h;
  }
  return null;
}

export async function resolveConfirmedBlockHeight(
  details: {
    height?: number | null;
    confirmations?: number | null;
  },
  tipHeight?: number | null
): Promise<number | null> {
  if (typeof details.height === 'number' && details.height > 0) {
    return details.height;
  }
  const confs =
    typeof details.confirmations === 'number' &&
    Number.isFinite(details.confirmations)
      ? details.confirmations
      : 0;
  if (confs <= 0) return null;

  let tip = tipHeight ?? null;
  if (tip == null || tip <= 0) {
    try {
      tip = parseTipHeight(await ElectrumService.getLatestBlock());
    } catch {
      tip = null;
    }
  }
  if (tip == null || tip <= 0) return null;
  const height = tip - confs + 1;
  return height > 0 ? height : null;
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
  /**
   * If set, publish the *full* list once after all heights resolve — never
   * one row at a time (that is the “unconfirmed fusion comes in one by one” UX).
   */
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

  let tip: number | null = null;
  try {
    tip = parseTipHeight(await ElectrumService.getLatestBlock());
  } catch {
    tip = null;
  }

  const manager = TransactionManager();
  let wroteAny = false;

  await mapPool(stuck, BACKFILL_CONCURRENCY, async (tx) => {
    const details = await ElectrumService.getTransactionDetails(tx.tx_hash, {
      forceRefresh,
    });
    if (!details) return;

    const height = await resolveConfirmedBlockHeight(details, tip);
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
        details.timestamp,
        { persist: false }
      );
      wroteAny = true;
    } catch {
      /* best-effort SQL */
    }
  });

  // One durable write so the next open paints Confirmed without re-catch-up.
  if (wroteAny) {
    try {
      await manager.persistConfirmedHeights(walletId);
    } catch {
      /* best-effort */
    }
  }

  const result = [...byHash.values()];

  // Single Redux replace — quiet background refresh, not a streaming UI.
  if (dispatch && wroteAny) {
    dispatch(
      setTransactions({
        wallet_id: walletId,
        transactions: result,
        sessionGeneration,
      })
    );
  }

  return result;
}
