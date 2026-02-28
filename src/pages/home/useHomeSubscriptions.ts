import { useCallback, useEffect, useRef } from 'react';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumService from '../../services/ElectrumService';
import { updateUTXOsForAddress } from '../../redux/utxoSlice';
import { AppDispatch } from '../../redux/store';
import { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';

type WalletKey = { address: string; addressIndex: number };

const subscribedAddresses = new Set<string>();

type UseHomeSubscriptionsParams = {
  enabled: boolean;
  isInitialized: boolean;
  fetchingUTXOs: boolean;
  keyPairs: WalletKey[];
  currentWalletId: number | null;
  reduxUTXOs: Record<string, UTXO[]>;
  dispatch: AppDispatch;
};

export function useHomeSubscriptions({
  enabled,
  isInitialized,
  fetchingUTXOs,
  keyPairs,
  currentWalletId,
  reduxUTXOs,
  dispatch,
}: UseHomeSubscriptionsParams) {
  const headersSubDone = useRef(false);
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
          await DatabaseService().saveDatabaseToFile();
        } catch (error) {
          logError('Home.runHeaderRefresh.saveDatabase', error);
        }
        headerRefreshScheduled.current = false;
      }, 750);
    },
    [dispatch]
  );

  useEffect(() => {
    if (!enabled) return;
    if (!isInitialized || fetchingUTXOs || keyPairs.length === 0 || !currentWalletId) {
      return;
    }
    const addrs = keyPairs.map((k) => k.address).filter(Boolean);

    (async () => {
      try {
        if (!headersSubDone.current) {
          await ElectrumService.subscribeBlockHeaders(() => runHeaderRefresh(addrs));
          headersSubDone.current = true;
        }
      } catch (error) {
        logError('Home.subscribeBlockHeaders', error);
      }
    })();

    (async () => {
      for (const addr of addrs) {
        if (subscribedAddresses.has(addr)) continue;
        subscribedAddresses.add(addr);

        const already =
          Array.isArray(utxosRef.current?.[addr]) && utxosRef.current[addr].length > 0;
        if (!already) {
          try {
            const baseline = await ElectrumService.getUTXOs(addr);
            if (baseline.length > 0) {
              dispatch(updateUTXOsForAddress({ address: addr, utxos: baseline }));
              const m = new Map(Object.entries(utxosRef.current));
              m.set(addr, baseline);
              utxosRef.current = Object.fromEntries(m.entries()) as Record<
                string,
                UTXO[]
              >;
            }
          } catch (error) {
            logError('Home.baselineUTXOs', error, { address: addr });
          }
        }

        try {
          await ElectrumService.subscribeAddress(addr, async () => {
            try {
              const current = utxosRef.current?.[addr] ?? [];
              const utxos = await ElectrumService.getUTXOs(addr);
              if (utxos.length === 0 && current.length > 0) return;

              dispatch(updateUTXOsForAddress({ address: addr, utxos }));
              try {
                await DatabaseService().saveDatabaseToFile();
              } catch (error) {
                logError('Home.subscribeAddress.saveDatabase', error, {
                  address: addr,
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
    dispatch,
    runHeaderRefresh,
  ]);
}
