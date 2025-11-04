// src/App.tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useEffect, useRef } from 'react';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import Layout from './components/Layout';
import RootHandler from './pages/RootHandler';
import Home from './pages/Home';
import CreateWallet from './pages/CreateWallet';
import ContractView from './pages/ContractView';
import ImportWallet from './pages/ImportWallet';
import Settings from './pages/Settings';
import Transaction from './pages/Transaction';
import TransactionHistory from './pages/TransactionHistory';
import LandingPage from './pages/LandingPage';
import Receive from './pages/Receive';
import AppsView from './pages/AppsView';
import AppFundMe from './pages/apps/FundMe';
import { AppDispatch, RootState } from './redux/store';
import { startUTXOWorker, stopUTXOWorker } from './workers/UTXOWorkerService';
import {
  startTransactionWorker,
  stopTransactionWorker,
} from './workers/TransactionWorkerService';
import CampaignDetail from './pages/apps/utils/CampaignDetail';
import { initWalletConnect } from './redux/walletconnectSlice';
import { clearNotifications } from './redux/notificationsSlice';
import { usePrices } from './hooks/usePrices';
import { SignTransactionModal } from './components/walletconnect/SignTransactionModal';
import { SignMessageModal } from './components/walletconnect/SignMessageModal';

// 🔔 Always-on in-app popup for incoming UTXOs
import UtxoNotificationCenter from './components/notifications/UtxoNotificationCenter';

// ✅ Simple Send (new)
import SimpleSend from './pages/SimpleSend';

let utxoWorkerStarted = false;
let transactionWorkerStarted = false;

function App() {
  usePrices();
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const utxoQueue = useSelector((s: RootState) => s.notifications.queue);
  const notified = useRef<Set<string>>(new Set());
  const location = useLocation();

  // 1) Initialize WalletConnect once
  useEffect(() => {
    dispatch(initWalletConnect());
  }, [dispatch]);

  useEffect(() => {
    // Only run this on Android (safe if you also ship iOS)
    if (Capacitor.getPlatform() === 'android') {
      // WebView draws behind the status bar
      StatusBar.setOverlaysWebView({ overlay: true });
      // Make the bar transparent so your page color shows through
      StatusBar.setBackgroundColor({ color: '#00000000' });
      // Pick icon color that contrasts your top background
      StatusBar.setStyle({ style: Style.Light }); // or Style.Dark if you use a light bg
    }
  }, []);

  // 2) OS-level Local Notifications: permission + Android channel
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

  // 🔔 Bridge in-app queue -> OS notifications
  useEffect(() => {
    (async () => {
      for (const n of utxoQueue) {
        // 🔒 belt & suspenders: ignore confirmed items at the bridge too
        if (typeof (n as any).height === 'number' && (n as any).height > 0)
          continue;

        if (notified.current.has(n.id)) continue;

        // Derive a stable numeric id from the deterministic id (txid:vout)
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
                  height: (n as any).height ?? 0,
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
  }, [utxoQueue]);

  // Optional: clear queue on wallet switch to avoid showing stale toasts
  useEffect(() => {
    if (walletId !== 1) {
      dispatch(clearNotifications());
      notified.current.clear();
    }
  }, [walletId, dispatch]);

  // 3) Start/stop workers based on walletId
  useEffect(() => {
    if (walletId === 1) {
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
      if (walletId !== 1) {
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
  }, [walletId, location.pathname]);

  return (
    <div className="app-shell">
      <main className="main-flex-1">
        <Routes>
          <Route path="/" element={<RootHandler />} />
          {walletId === 1 ? (
            <>
              <Route element={<Layout />}>
                <Route path="/home/:wallet_id" element={<Home />} />
                <Route path="/contract" element={<ContractView />} />
                <Route path="/apps" element={<AppsView />} />
                <Route path="/apps/fundme" element={<AppFundMe />} />
                <Route path="/campaign/:id" element={<CampaignDetail />} />
                <Route path="/receive" element={<Receive />} />

                {/* ✅ NEW: Simple Send default route */}
                <Route path="/send" element={<SimpleSend />} />

                {/* Advanced builder remains intact */}
                <Route path="/transaction" element={<Transaction />} />

                <Route
                  path="/transactions/:wallet_id"
                  element={<TransactionHistory />}
                />
                <Route path="/settings" element={<Settings />} />
              </Route>

              {/* Keep default redirects unchanged */}
              <Route
                path="/"
                element={<Navigate to={`/home/${walletId}`} replace />}
              />
              <Route
                path="*"
                element={<Navigate to={`/home/${walletId}`} replace />}
              />
            </>
          ) : (
            <>
              <Route path="/landing" element={<LandingPage />} />
              <Route path="/createwallet" element={<CreateWallet />} />
              <Route path="/importwallet" element={<ImportWallet />} />
              <Route path="*" element={<Navigate to="/landing" replace />} />
            </>
          )}
        </Routes>
        {/* 🔥 Always active modals */}
        <SignMessageModal />
        <SignTransactionModal />
        {/* 🔔 Always-on in-app UTXO popup (only when wallet exists) */}
        {walletId === 1 && <UtxoNotificationCenter />}
      </main>
    </div>
  );
}

export default App;
