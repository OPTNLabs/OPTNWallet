import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { useLocation } from 'react-router-dom';
import WalletManager from '../apis/WalletManager/WalletManager';
import { startUTXOWorker, stopUTXOWorker } from '../workers/UTXOWorkerService';
import { initWalletConnect } from '../state/slices/walletconnectSlice';
import {
  initWizardConnect,
  syncWizardConnections,
} from '../state/slices/wizardconnectSlice';
import {
  checkAndDisconnectExpiredSessions,
  syncWalletConnectSessions,
} from '../state/slices/walletconnectSlice';
import {
  clearNotifications,
  type AppNotification,
} from '../state/slices/notificationsSlice';
import { AppDispatch, store } from '../state/store';
import {
  clearServerNotifications,
  enqueueServerNotification,
} from '../state/slices/serverNotificationsSlice';
import { reconcileOutboundTransactions } from '../services/OutboundTransactionReconciler';
import { runOutboundReconcile } from '../services/RefreshCoordinator';
import { Network, setNetwork } from '../state/slices/networkSlice';
import {
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} from '../state/slices/walletSlice';
import { WalletType } from '../types/wallet';
import type { WalletMetadata } from '../types/wallet';
import ScreenSecurity from '../platform/plugins/ScreenSecurity';
import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import WalletBackendSyncService from '../services/WalletBackendSyncService';
import PlayUpdateService from '../services/PlayUpdateService';
import { ROUTE_PATHS } from '../navigation/routes';
import BcmrService from '../services/BcmrService';
import { useWalletConfirm } from '../components/WalletConfirmDialog';
import { refreshWalletTransactionHistory } from '../services/WalletHistoryRefreshService';

let utxoWorkerStarted = false;
let bcmrWarmupStarted = false;

export function useWalletConnectInitialization(
  dispatch: AppDispatch,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    dispatch(initWalletConnect());
  }, [dispatch, enabled]);
}

export function useWizardConnectInitialization(
  walletId: number | null,
  dispatch: AppDispatch
) {
  useEffect(() => {
    if (!walletId || walletId <= 0) return;
    dispatch(initWizardConnect(walletId));
  }, [dispatch, walletId]);
}

export function useWalletConnectSessionWatch(
  walletId: number | null,
  dispatch: AppDispatch
) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!walletId || walletId <= 0) return;

    let cancelled = false;

    const reconcile = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        await Promise.all([
          dispatch(syncWalletConnectSessions()),
          dispatch(checkAndDisconnectExpiredSessions()),
        ]);
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
      cancelled = true;
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [dispatch, walletId]);
}

export function useWizardConnectSessionWatch(
  walletId: number | null,
  dispatch: AppDispatch
) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!walletId || walletId <= 0) return;

    let cancelled = false;

    const reconcile = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        await dispatch(syncWizardConnections());
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
      cancelled = true;
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [dispatch, walletId]);
}

interface WalletNetworkBootstrapDependencies {
  loadWalletMetadata: (walletId: number) => Promise<WalletMetadata | null>;
  ensureFreshConnection: () => Promise<unknown>;
  refreshHistory: typeof refreshWalletTransactionHistory;
  getSessionGeneration?: () => number;
}

/**
 * Establish the wallet's local network state, then release the UI immediately.
 * Electrum connection and history refresh remain app-wide and coalesced
 * background work: neither a slow server nor a large history may block unlock.
 */
export async function bootstrapWalletNetwork(
  walletId: number,
  dispatch: AppDispatch,
  isCancelled: () => boolean = () => false,
  dependencies: WalletNetworkBootstrapDependencies = {
    loadWalletMetadata: (id) => WalletManager().getWalletMetadata(id),
    ensureFreshConnection: () => ElectrumServer().ensureFreshConnection(),
    refreshHistory: refreshWalletTransactionHistory,
    getSessionGeneration: () =>
      store.getState().wallet_id.sessionGeneration ?? 0,
  }
): Promise<void> {
  const walletInfo = await dependencies.loadWalletMetadata(walletId);
  const resolvedNetwork =
    walletInfo?.networkType === Network.MAINNET
      ? Network.MAINNET
      : walletInfo?.networkType === Network.CHIPNET
        ? Network.CHIPNET
        : null;
  if (isCancelled() || !resolvedNetwork) return;

  dispatch(setWalletNetwork(resolvedNetwork));
  dispatch(setWalletType(walletInfo?.walletType ?? WalletType.STANDARD));
  if (walletInfo?.derivation_path) {
    dispatch(
      setWalletDerivationPath({
        path: walletInfo.derivation_path,
        source:
          walletInfo.derivation_path_source === 'custom'
            ? 'custom'
            : 'default',
      })
    );
  }
  dispatch(setNetwork(resolvedNetwork));
  const sessionGeneration =
    dependencies.getSessionGeneration?.() ??
    store.getState().wallet_id.sessionGeneration ??
    0;

  void dependencies
    .ensureFreshConnection()
    .then(() => {
      if (isCancelled()) return;
      return dependencies.refreshHistory({
        walletId,
        dispatch,
        sessionGeneration,
      });
    })
    .catch((error) => console.warn('Wallet network sync failed:', error));
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
        await bootstrapWalletNetwork(walletId, dispatch, () => cancelled);
      } catch (error) {
        console.warn('Wallet network bootstrap failed:', error);
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

export function useNativeBcmrWarmup(walletId: number | null) {
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !walletId || walletId <= 0) {
      return;
    }

    if (bcmrWarmupStarted) return;
    bcmrWarmupStarted = true;

    const service = new BcmrService();
    void service.preloadMetadataRegistries().catch((error) => {
      console.warn('BCMR warm-up failed:', error);
    });
  }, [walletId]);
}

export function useStatusBarSync() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    if (Capacitor.getPlatform() === 'android') {
      void StatusBar.setBackgroundColor({ color: '#000000' });
    }

    void StatusBar.setOverlaysWebView({ overlay: false });
    void StatusBar.setStyle({ style: Style.Light });
  }, []);
}

export function useScreenSecurity() {
  const location = useLocation();

  useEffect(() => {
    if (
      !Capacitor.isNativePlatform() ||
      Capacitor.getPlatform() !== 'android'
    ) {
      return;
    }

    const onboardingRoutes: Set<string> = new Set([
      ROUTE_PATHS.root,
      ROUTE_PATHS.landing,
      ROUTE_PATHS.createWallet,
      ROUTE_PATHS.importWallet,
    ]);
    const shouldEnableSecure = !onboardingRoutes.has(location.pathname);

    void ScreenSecurity.setSecure({ enabled: shouldEnableSecure }).catch(
      (error) => {
        console.warn('Failed to update screen security state', error);
      }
    );
  }, [location.pathname]);
}

export function useLocalNotificationSetup() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

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

export function useUtxoQueueToOsNotifications(queue: AppNotification[]) {
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    (async () => {
      for (const n of queue) {
        if (n.kind !== 'utxo') continue;
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
      dispatch(clearServerNotifications());
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

export function useOptionalPlayUpdateCheck() {
  const lastPromptedVersionRef = useRef<number>(0);
  const confirm = useWalletConfirm();

  useEffect(() => {
    let cancelled = false;

    const runCheck = async () => {
      try {
        const update = await PlayUpdateService.checkForOptionalUpdate();
        if (cancelled || !update) return;

        if (update.isDownloaded) {
          await PlayUpdateService.completeOptionalUpdate();
          return;
        }

        if (!update.available) return;
        if (update.availableVersionCode <= lastPromptedVersionRef.current)
          return;

        const shouldUpdate = await confirm(
          'A newer version of OPTN Wallet is available in Google Play. You can keep using this version or update now.'
        );

        lastPromptedVersionRef.current = update.availableVersionCode;

        if (!shouldUpdate) return;
        await PlayUpdateService.startOptionalUpdate();
      } catch (error) {
        console.warn('Optional Play update check failed:', error);
      }
    };

    void runCheck();
    window.addEventListener('focus', runCheck);
    document.addEventListener('visibilitychange', runCheck);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', runCheck);
      document.removeEventListener('visibilitychange', runCheck);
    };
  }, [confirm]);
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

export function useElectrumConnectivityWatch(walletId: number | null) {
  useEffect(() => {
    if (!walletId || walletId <= 0) return;

    const electrum = ElectrumServer();
    let cancelled = false;

    const refreshElectrum = async () => {
      if (cancelled) return;
      try {
        await electrum.ensureFreshConnection();
      } catch (error) {
        console.warn('Electrum connectivity refresh failed:', error);
      }
    };

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshElectrum();
      }
    };
    const handleOnline = () => {
      void refreshElectrum();
    };

    void refreshElectrum();
    window.addEventListener('focus', handleVisible);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshElectrum();
      }
    }, 2 * 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [walletId]);
}

export function useWalletBackendSync(walletId: number | null) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!walletId || walletId <= 0) return;

    let cancelled = false;

    const syncBackend = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        await WalletBackendSyncService.registerWallet(walletId);
      } finally {
        inFlight.current = false;
      }
    };

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        void syncBackend();
      }
    };
    const handleOnline = () => {
      void syncBackend();
    };

    void syncBackend();
    window.addEventListener('focus', handleVisible);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncBackend();
      }
    }, 10 * 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [walletId]);
}

export function useServerNotificationPolling(
  walletId: number | null,
  dispatch: AppDispatch
) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!walletId || walletId <= 0) return;
    if (!import.meta.env.DEV) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        const notifications =
          await WalletBackendSyncService.listNotifications(walletId);
        for (const notification of notifications) {
          dispatch(
            enqueueServerNotification({
              id: notification.dedupe_key,
              kind: notification.kind,
              txid: notification.txid,
              address: notification.address,
              tokenCategory: notification.token_category,
              blockHeight: notification.block_height,
              createdAt: Date.now(),
            })
          );
        }
      } finally {
        inFlight.current = false;
      }
    };

    const handleVisible = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };

    void poll();
    window.addEventListener('focus', handleVisible);
    window.addEventListener('online', handleVisible);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    }, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('online', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [dispatch, walletId]);
}
