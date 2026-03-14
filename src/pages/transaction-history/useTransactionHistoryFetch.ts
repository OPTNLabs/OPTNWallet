import { useCallback, useEffect, useMemo, useState } from 'react';
import TransactionManager from '../../apis/TransactionManager/TransactionManager';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { setTransactions } from '../../redux/transactionSlice';
import { AppDispatch } from '../../redux/store';
import { TransactionHistoryItem } from '../../types/types';
import ElectrumService from '../../services/ElectrumService';
import { reconcileOutboundTransactions } from '../../services/OutboundTransactionReconciler';
import {
  runOutboundReconcile,
  runWalletHistoryRefresh,
} from '../../services/RefreshCoordinator';

type UseTransactionHistoryFetchParams = {
  walletIdParam: string | undefined;
  isInitialized: boolean;
  transactionCount: number;
  dispatch: AppDispatch;
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

export function useTransactionHistoryFetch({
  walletIdParam,
  isInitialized,
  transactionCount,
  dispatch,
}: UseTransactionHistoryFetchParams) {
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchedAddresses, setFetchedAddresses] = useState<Set<string>>(new Set());
  const dbService = useMemo(() => DatabaseService(), []);

  const fetchTransactionHistory = useCallback(async () => {
    if (!walletIdParam || loading) return;
    const walletIdNum = parseInt(walletIdParam, 10);
    if (Number.isNaN(walletIdNum)) return;

    setLoading(true);
    setProgress(0);

    try {
      await runWalletHistoryRefresh(walletIdNum, async () => {
        await ElectrumService.reconnect();

        await dbService.ensureDatabaseStarted();
        const db = dbService.getDatabase();
        if (!db) {
          console.error('Database not started.');
          return;
        }

        const addressesQuery = db.prepare(`
      SELECT address FROM addresses WHERE wallet_id = ?;
    `);
        addressesQuery.bind([walletIdParam]);

        const addresses: string[] = [];
        while (addressesQuery.step()) {
          const result = addressesQuery.getAsObject();
          if (typeof result.address === 'string') {
            addresses.push(result.address);
          }
        }
        addressesQuery.free();

        const pending = addresses.filter((a) => !fetchedAddresses.has(a));
        const totalToScan = pending.length;

        if (totalToScan === 0) {
          setProgress(100);
          return;
        }

        const transactionManager = TransactionManager();
        const processedAddresses: string[] = [];
        const historyByAddress =
          await transactionManager.fetchAndStoreTransactionHistories(
            walletIdNum,
            pending
          );

        pending.forEach((address, index) => {
          if (Array.isArray(historyByAddress[address])) {
            processedAddresses.push(address);
          }
          setProgress(Math.round(((index + 1) / totalToScan) * 100));
        });

        const liveDb = dbService.getDatabase();
        if (!liveDb) {
          console.error('Database not started after history fetch.');
        } else {
          const storedTransactionsQuery = liveDb.prepare(`
          SELECT tx_hash, height, timestamp, amount
          FROM transactions
          WHERE wallet_id = ?;
        `);
          storedTransactionsQuery.bind([walletIdNum]);
          const storedTransactions: TransactionHistoryItem[] = [];
          while (storedTransactionsQuery.step()) {
            storedTransactions.push(
              toHistoryItem(storedTransactionsQuery.getAsObject())
            );
          }
          storedTransactionsQuery.free();

          dispatch(
            setTransactions({
              wallet_id: walletIdNum,
              transactions: storedTransactions,
            })
          );
        }

        if (processedAddresses.length > 0) {
          setFetchedAddresses((prev) => {
            const next = new Set(prev);
            for (const address of processedAddresses) {
              next.add(address);
            }
            return next;
          });
        }

        await runOutboundReconcile(walletIdNum, () =>
          reconcileOutboundTransactions(walletIdNum)
        );
        setProgress(100);
      });
    } catch (e) {
      console.error('Failed to fetch transaction history:', e);
    } finally {
      setLoading(false);
    }
  }, [walletIdParam, loading, dbService, fetchedAddresses, dispatch]);

  useEffect(() => {
    if (isInitialized && transactionCount === 0 && !loading) {
      void fetchTransactionHistory();
    }
  }, [isInitialized, transactionCount, loading, fetchTransactionHistory]);

  return {
    progress,
    loading,
    fetchTransactionHistory,
  };
}
