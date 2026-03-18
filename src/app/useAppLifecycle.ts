import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { useLocation } from 'react-router-dom';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import WalletManager from '../apis/WalletManager/WalletManager';
import {
  startUTXOWorker,
  stopUTXOWorker,
} from '../workers/UTXOWorkerService';
import { initWalletConnect } from '../redux/walletconnectSlice';
import { clearNotifications, UtxoNotification } from '../redux/notificationsSlice';
import { AppDispatch } from '../redux/store';
import { reconcileOutboundTransactions } from '../services/OutboundTransactionReconciler';
import { runOutboundReconcile } from '../services/RefreshCoordinator';
import { Network, setNetwork } from '../redux/networkSlice';
import { setWalletNetwork } from '../redux/walletSlice';
import ScreenSecurity from '../plugins/ScreenSecurity';

let utxoWorkerStarted = false;

export function useWalletConnectInitialization(dispatch: AppDispatch) {
  useEffect(() => {
    dispatch(initWalletConnect());
  }, [dispatch]);
}

export function useWalletNetworkBootstrap(
  walletId: number | null,
  dispatch: AppDispatch
) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const syncWalletNetwork = async () => {
      if (!walletId || walletId <= 0) {
        if (!cancelled) setReady(true);
        return;
      }

      try {
        const dbService = DatabaseService();
        const walletManager = WalletManager();
        await dbService.ensureDatabaseStarted();
        const walletInfo = await walletManager.getWalletInfo(walletId);
        const resolvedNetwork =
          walletInfo?.networkType === Network.MAINNET
            ? Network.MAINNET
            : walletInfo?.networkType === Network.CHIPNET
              ? Network.CHIPNET
              : null;

        if (!cancelled && resolvedNetwork) {
          dispatch(setWalletNetwork(resolvedNetwork));
          dispatch(setNetwork(resolvedNetwork));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    };

    setReady(false);
    void syncWalletNetwork();

    return () => {
      cancelled = true;
    };
  }, [dispatch, walletId]);

  return ready;
}

export function useStatusBarSync(mode: string) {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const platform = Capacitor.getPlatform();
    if (platform === 'android') {
      StatusBar.setOverlaysWebView({ overlay: false });
    }

    StatusBar.setStyle({ style: mode === 'dark' ? Style.Light : Style.Dark });
  }, [mode]);
}

export function useScreenSecurity() {
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return;
    }

    const onboardingRoutes = new Set(['/', '/landing', '/createwallet', '/importwallet']);
    const shouldEnableSecure = !onboardingRoutes.has(location.pathname);

    void ScreenSecurity.setSecure({ enabled: shouldEnableSecure }).catch((error) => {
      console.warn('Failed to update screen security state', error);
    });
  }, [location.pathname]);
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
    } else {
      if (utxoWorkerStarted) {
        stopUTXOWorker();
        utxoWorkerStarted = false;
      }
    }

    return () => {
      if (!hasWallet) {
        if (utxoWorkerStarted) {
          stopUTXOWorker();
          utxoWorkerStarted = false;
        }
      }
    };
  }, [hasWallet, location.pathname]);
}

export function useOutboundTransactionRecovery(walletId: number | null) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!walletId || walletId <= 0) return;

    const reconcile = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await runOutboundReconcile(walletId, () =>
          reconcileOutboundTransactions(walletId)
        );
      } finally {
        inFlight.current = false;
      }
    };

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        void reconcile();
      }
    };
    const handleOnline = () => {
      void reconcile();
    };

    void reconcile();
    window.addEventListener('focus', handleVisible);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void reconcile();
      }
    }, 60_000);

    return () => {
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [walletId]);
}
