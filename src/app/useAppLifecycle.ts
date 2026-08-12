import { useEffect, useRef, type MutableRefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { useLocation } from 'react-router-dom';
import {
  startUTXOWorker,
  stopUTXOWorker,
} from '../workers/UTXOWorkerService';
import {
  startTransactionWorker,
  stopTransactionWorker,
} from '../workers/TransactionWorkerService';
import { initWalletConnect } from '../redux/walletconnectSlice';
import { clearNotifications, UtxoNotification } from '../redux/notificationsSlice';
import { AppDispatch } from '../redux/store';

let utxoWorkerStarted = false;
let transactionWorkerStarted = false;

export function useWalletConnectInitialization(dispatch: AppDispatch) {
  useEffect(() => {
    dispatch(initWalletConnect());
  }, [dispatch]);
}

export function useStatusBarSync(mode: string) {
  useEffect(() => {
    if (Capacitor.getPlatform() === 'android') {
      StatusBar.setOverlaysWebView({ overlay: true });
      StatusBar.setBackgroundColor({ color: '#00000000' });
      StatusBar.setStyle({ style: mode === 'dark' ? Style.Light : Style.Dark });
    }
  }, [mode]);
}

export function useLocalNotificationSetup() {
  useEffect(() => {
    (async () => {
      try {
        await LocalNotifications.requestPermissions();
        await LocalNotifications.createChannel({
          id: 'utxo',
          name: 'UTXO Alerts',
          importance: 5,
          visibility: 1,
          vibration: true,
          sound: 'default',
          lights: true,
        });
      } catch (e) {
        console.warn('LocalNotifications init failed:', e);
      }
    })();
  }, []);
}

export function useUtxoQueueToOsNotifications(queue: UtxoNotification[]) {
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      for (const n of queue) {
        if (typeof n.height === 'number' && n.height > 0) continue;
        if (notified.current.has(n.id)) continue;

        const numericId =
          Math.abs(
            [...n.id].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
          ) % 2147483647;

        try {
          await LocalNotifications.schedule({
            notifications: [
              {
                id: numericId,
                title: 'Funds received',
                body: `${n.value ?? 0} sats to ${n.address.slice(0, 10)}…`,
                channelId: 'utxo',
                extra: {
                  address: n.address,
                  txid: n.txid,
                  value: n.value ?? 0,
                  height: n.height ?? 0,
                },
              },
            ],
          });
        } catch (e) {
          console.warn('Local notification schedule failed:', e);
        }
        notified.current.add(n.id);
      }
    })();
  }, [queue]);

  return notified;
}

export function useNotificationQueueReset(
  walletId: number | null,
  dispatch: AppDispatch,
  notified: MutableRefObject<Set<string>>
) {
  useEffect(() => {
    if (!walletId || walletId <= 0) {
      dispatch(clearNotifications());
      notified.current.clear();
    }
  }, [walletId, dispatch, notified]);
}

export function useWorkerLifecycle(walletId: number | null) {
  const location = useLocation();
  const hasWallet = Boolean(walletId && walletId > 0);

  useEffect(() => {
    if (hasWallet) {
      if (!utxoWorkerStarted) {
        startUTXOWorker();
        utxoWorkerStarted = true;
      }
      if (!transactionWorkerStarted) {
        startTransactionWorker();
        transactionWorkerStarted = true;
      }
    } else {
      if (utxoWorkerStarted) {
        stopUTXOWorker();
        utxoWorkerStarted = false;
      }
      if (transactionWorkerStarted) {
        stopTransactionWorker();
        transactionWorkerStarted = false;
      }
    }

    return () => {
      if (!hasWallet) {
        if (utxoWorkerStarted) {
          stopUTXOWorker();
          utxoWorkerStarted = false;
        }
        if (transactionWorkerStarted) {
          stopTransactionWorker();
          transactionWorkerStarted = false;
        }
      }
    };
  }, [hasWallet, location.pathname]);
}
