import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import OutboundTransactionTracker, {
  OUTBOUND_RELEASE_DELAY_MS,
  type OutboundTransactionRecord,
} from '../services/OutboundTransactionTracker';
import { reconcileOutboundTransactions } from '../services/OutboundTransactionReconciler';
import { runOutboundReconcile } from '../services/RefreshCoordinator';

export function outpointKey(txHash: string, txPos: number): string {
  return `${txHash}:${txPos}`;
}

export default function useOutboundTransactions(
  walletId: number | null | undefined,
  enabled = true
) {
  const [records, setRecords] = useState<OutboundTransactionRecord[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const currentWalletIdRef = useRef(walletId);
  const refreshingWalletIdsRef = useRef(new Set<number>());
  const queuedRefreshWalletIdsRef = useRef(new Set<number>());

  useLayoutEffect(() => {
    currentWalletIdRef.current = walletId;
    setRecords([]);
  }, [walletId]);

  const load = useCallback(
    async (walletIdToLoad = walletId) => {
      const active =
        await OutboundTransactionTracker.listActive(walletIdToLoad);
      if (currentWalletIdRef.current === walletIdToLoad) setRecords(active);
    },
    [walletId]
  );

  const refresh = useCallback(async () => {
    if (!walletId || walletId <= 0) {
      return;
    }
    if (refreshingWalletIdsRef.current.has(walletId)) {
      queuedRefreshWalletIdsRef.current.add(walletId);
      return;
    }

    refreshingWalletIdsRef.current.add(walletId);
    setReconciling(true);
    try {
      do {
        queuedRefreshWalletIdsRef.current.delete(walletId);
        try {
          await runOutboundReconcile(walletId, () =>
            reconcileOutboundTransactions(walletId)
          );
          await load(walletId);
        } catch {
          // A failed pass must not swallow a refresh queued behind it: the
          // broadcast that queued it still needs reconciling, so the loop
          // runs again when one is waiting. With nothing queued, the periodic
          // recovery pass picks it up. Every caller fires and forgets, so a
          // rejection here would only surface as an unhandled promise.
        }
      } while (queuedRefreshWalletIdsRef.current.has(walletId));
    } finally {
      refreshingWalletIdsRef.current.delete(walletId);
      queuedRefreshWalletIdsRef.current.delete(walletId);
      setReconciling(refreshingWalletIdsRef.current.size > 0);
    }
  }, [load, walletId]);

  const release = useCallback(
    async (txid: string) => {
      if (!walletId || walletId <= 0) return false;
      await runOutboundReconcile(walletId, () =>
        reconcileOutboundTransactions(walletId)
      );
      const record = await OutboundTransactionTracker.getByTxid(txid, walletId);
      if (!record) {
        await load();
        return true;
      }
      // canClear covers submitted/broadcasted (and deterministic errors).
      // canRelease is the slower 20‑minute safety valve for still-broadcasting.
      if (
        !OutboundTransactionTracker.canClear(record) &&
        !OutboundTransactionTracker.canRelease(record)
      ) {
        await load();
        return false;
      }
      await OutboundTransactionTracker.remove(txid, walletId);
      await load();
      return true;
    },
    [load, walletId]
  );

  useEffect(() => {
    if (!enabled) return;
    void load();
    void refresh();
    return OutboundTransactionTracker.subscribe((record, previousState) => {
      void load();
      // A pre-send `broadcasting` event is intentionally ignored. Once the
      // node accepts the transaction, reconcile immediately in the background
      // instead of waiting for focus, Home subscriptions, or the 60s recovery
      // interval to discover it.
      // The tracker notifies every subscriber; only this wallet's broadcasts
      // are a reason to reconcile this wallet.
      if (
        record?.walletId === walletId &&
        record?.state === 'broadcasted' &&
        previousState !== 'broadcasted'
      ) {
        void refresh();
      }
    });
  }, [enabled, load, refresh, walletId]);

  const reservedOutpointKeys = useMemo(
    () =>
      new Set(
        records.flatMap((record) =>
          record.spentOutpoints.map((outpoint) =>
            outpointKey(outpoint.tx_hash, outpoint.tx_pos)
          )
        )
      ),
    [records]
  );

  return {
    outboundTransactions: records,
    unresolvedCount: records.length,
    hasUnresolved: records.length > 0,
    reservedOutpointKeys,
    canRelease: (txid: string) => {
      const record = records.find((item) => item.txid === txid);
      return record ? OutboundTransactionTracker.canRelease(record) : false;
    },
    canClear: (txid: string) => {
      const record = records.find((item) => item.txid === txid);
      return record ? OutboundTransactionTracker.canClear(record) : false;
    },
    releaseEligibleAfterMs: OUTBOUND_RELEASE_DELAY_MS,
    reconciling,
    refresh,
    release,
  };
}
