import { useCallback, useEffect, useState } from 'react';
import { AppDispatch } from '../../state/store';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';

type UseTransactionHistoryFetchParams = {
  walletIdParam: string | undefined;
  isInitialized: boolean;
  transactionCount: number;
  sessionGeneration: number;
  dispatch: AppDispatch;
};

/**
 * History for the transactions page.
 *
 * The fetch itself lives in `WalletHistoryRefreshService` so the address
 * subscription can run the identical code when a payment arrives — otherwise
 * only a mounted history page could ever refresh history, which is why Recent
 * Activity on Home went stale until the user navigated.
 */
export function useTransactionHistoryFetch({
  walletIdParam,
  isInitialized,
  transactionCount,
  sessionGeneration,
  dispatch,
}: UseTransactionHistoryFetchParams) {
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchedAddresses, setFetchedAddresses] = useState<Set<string>>(
    new Set()
  );

  const fetchTransactionHistory = useCallback(
    async (options?: { full?: boolean }) => {
      if (!walletIdParam || loading) return;
      const walletIdNum = parseInt(walletIdParam, 10);
      if (Number.isNaN(walletIdNum)) return;

      setLoading(true);
      setProgress(0);
      try {
        const { scannedAddresses } = await refreshWalletTransactionHistory({
          walletId: walletIdNum,
          dispatch,
          sessionGeneration,
          // The initial page load stays incremental. An explicit refresh is a
          // FULL pass: a new payment lands on an address that has almost
          // certainly been scanned already, so skipping scanned addresses would
          // filter out the only one that changed.
          skipAddresses: options?.full ? undefined : fetchedAddresses,
          onProgress: setProgress,
        });
        if (scannedAddresses.length > 0) {
          setFetchedAddresses((previous) => {
            const next = new Set(previous);
            for (const address of scannedAddresses) next.add(address);
            return next;
          });
        }
      } catch (error) {
        console.error('Failed to fetch transaction history:', error);
      } finally {
        setLoading(false);
      }
    },
    [walletIdParam, loading, fetchedAddresses, sessionGeneration, dispatch]
  );

  useEffect(() => {
    if (isInitialized && transactionCount === 0 && !loading) {
      void fetchTransactionHistory();
    }
  }, [isInitialized, transactionCount, loading, fetchTransactionHistory]);

  return {
    progress,
    loading,
    /** Manual refresh: always a full pass, so it cannot no-op on a scanned set. */
    fetchTransactionHistory: useCallback(
      () => fetchTransactionHistory({ full: true }),
      [fetchTransactionHistory]
    ),
  };
}
