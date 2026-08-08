import { useCallback, useEffect, useRef } from 'react';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumService from '../../services/ElectrumService';
import { updateUTXOsForAddress } from '../../state/slices/utxoSlice';
import { AppDispatch } from '../../state/store';
import { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';

type WalletKey = { address: string; addressIndex: number };

const subscribedAddresses = new Set<string>();

type UseHomeSubscriptionsParams = {
  enabled: boolean;
  isInitialized: boolean;
  fetchingUTXOs: boolean;
  keyPairs: WalletKey[];
  currentWalletId: number | null;
  sessionGeneration: number;
  reduxUTXOs: Record<string, UTXO[]>;
  dispatch: AppDispatch;
};

export function useHomeSubscriptions({
  enabled,
  isInitialized,
  fetchingUTXOs,
  keyPairs,
  currentWalletId,
  sessionGeneration,
  reduxUTXOs,
  dispatch,
}: UseHomeSubscriptionsParams) {
  const headersSubDone = useRef(false);
  /** Which wallet we have already loaded history for, so a re-render does not refetch. */
  const historyLoadedForWallet = useRef<number | null>(null);
  const headerRefreshScheduled = useRef(false);
  const utxosRef = useRef(reduxUTXOs);

  useEffect(() => {
    utxosRef.current = reduxUTXOs;
  }, [reduxUTXOs]);

  const runHeaderRefresh = useCallback(
    (addrs: string[]) => {
      if (headerRefreshScheduled.current) return;
      headerRefreshScheduled.current = true;
      setTimeout(async () => {
        const refreshResults = await Promise.allSettled(
          addrs.map(async (addr) => {
            const utxos = await ElectrumService.getUTXOs(addr);
            dispatch(updateUTXOsForAddress({ address: addr, utxos }));
          })
        );
        for (let i = 0; i < refreshResults.length; i++) {
          const result = refreshResults[i];
          if (result.status === 'rejected') {
            logError('Home.runHeaderRefresh.getUTXOs', result.reason, {
              address: addrs[i],
            });
          }
        }
        try {
          DatabaseService().scheduleDatabaseSave(currentWalletId);
        } catch (error) {
          logError('Home.runHeaderRefresh.saveDatabase', error);
        }
        headerRefreshScheduled.current = false;
      }, 750);
    },
    [currentWalletId, dispatch]
  );

  useEffect(() => {
    if (!enabled) return;
    if (
      !isInitialized ||
      fetchingUTXOs ||
      keyPairs.length === 0 ||
      !currentWalletId
    ) {
      return;
    }
    const addrs = keyPairs.map((k) => k.address).filter(Boolean);

    (async () => {
      try {
        if (!headersSubDone.current) {
          await ElectrumService.subscribeBlockHeaders(() =>
            runHeaderRefresh(addrs)
          );
          headersSubDone.current = true;
        }
      } catch (error) {
        logError('Home.subscribeBlockHeaders', error);
      }
    })();

    // Load history once when the wallet opens.
    //
    // The address subscriptions below only fire when something CHANGES, so on a
    // freshly opened wallet nothing requested history at all: Recent Activity
    // rendered whatever redux happened to hold and stayed empty until the user
    // opened the transactions page, which mounted the history hook. Home reads
    // the same redux slice but mounts no such hook, so it has to ask itself.
    if (historyLoadedForWallet.current !== currentWalletId) {
      historyLoadedForWallet.current = currentWalletId;
      void refreshWalletTransactionHistory({
        walletId: currentWalletId,
        dispatch,
        sessionGeneration,
      }).catch((error) => {
        logError('Home.initialHistoryRefresh', error, {
          walletId: currentWalletId,
        });
      });
    }

    (async () => {
      for (const addr of addrs) {
        if (subscribedAddresses.has(addr)) continue;
        subscribedAddresses.add(addr);

        try {
          await ElectrumService.subscribeAddress(addr, async () => {
            try {
              const current = utxosRef.current?.[addr] ?? [];
              const utxos = await ElectrumService.getUTXOs(addr);
              if (utxos.length === 0 && current.length > 0) return;

              dispatch(updateUTXOsForAddress({ address: addr, utxos }));
              try {
                DatabaseService().scheduleDatabaseSave(currentWalletId);
              } catch (error) {
                logError('Home.subscribeAddress.saveDatabase', error, {
                  address: addr,
                });
              }
              // Activity on this address means the transaction list changed too.
              // Refreshing only UTXOs updated the balance while Recent Activity
              // stayed stale until the user navigated away and back, which
              // remounted the history hook. Coalesced by RefreshCoordinator, so a
              // burst of address notifications collapses into one pass.
              if (currentWalletId) {
                void refreshWalletTransactionHistory({
                  walletId: currentWalletId,
                  dispatch,
                  sessionGeneration,
                }).catch((error) => {
                  logError('Home.subscribeAddress.refreshHistory', error, {
                    address: addr,
                  });
                });
              }
            } catch (error) {
              logError('Home.subscribeAddress.update', error, {
                address: addr,
              });
            }
          });
        } catch (error) {
          logError('Home.subscribeAddress.register', error, { address: addr });
        }
      }
    })();
  }, [
    enabled,
    isInitialized,
    fetchingUTXOs,
    keyPairs,
    currentWalletId,
    sessionGeneration,
    dispatch,
    runHeaderRefresh,
  ]);
}
