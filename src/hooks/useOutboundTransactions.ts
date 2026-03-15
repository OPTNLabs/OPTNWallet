import { useCallback, useEffect, useMemo, useState } from 'react';
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
  walletId: number | null | undefined
) {
  const [records, setRecords] = useState<OutboundTransactionRecord[]>([]);
  const [reconciling, setReconciling] = useState(false);

  const load = useCallback(async () => {
    setRecords(await OutboundTransactionTracker.listActive(walletId));
  }, [walletId]);

  const refresh = useCallback(async () => {
    if (!walletId || walletId <= 0 || reconciling) return;
    setReconciling(true);
    try {
      await runOutboundReconcile(walletId, () =>
        reconcileOutboundTransactions(walletId)
      );
      await load();
    } finally {
      setReconciling(false);
    }
  }, [load, reconciling, walletId]);

  const release = useCallback(
    async (txid: string) => {
      if (!walletId || walletId <= 0) return false;
      await runOutboundReconcile(walletId, () =>
        reconcileOutboundTransactions(walletId)
      );
      const record = await OutboundTransactionTracker.getByTxid(txid);
      if (!record) {
        await load();
        return true;
      }
      if (record.state === 'submitted') {
        await OutboundTransactionTracker.remove(txid);
        await load();
        return true;
      }
      if (!OutboundTransactionTracker.canRelease(record)) {
        await load();
        return false;
      }
      await OutboundTransactionTracker.remove(txid);
      await load();
      return true;
    },
    [load, walletId]
  );

  useEffect(() => {
    void load();
    void refresh();
    return OutboundTransactionTracker.subscribe(() => {
      void load();
    });
  }, [load, refresh]);

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
