// src/App.tsx
import Home from './pages/Home';
import ContractView from './pages/ContractView';
import Settings from './pages/Settings';
import Transaction from './pages/Transaction';
import TransactionHistory from './pages/TransactionHistory';
import Receive from './pages/Receive';
import SimpleSend from './pages/SimpleSend';
import Outbox from './pages/Outbox';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import Layout from './components/Layout';
import RootHandler from './pages/RootHandler';
import AppsView from './pages/AppsView';
import { AppDispatch, RootState } from './redux/store';
import { selectHasWallet, selectWalletId } from './redux/walletSlice';
import CampaignDetail from './pages/apps/fundme/CampaignDetail';
import { usePrices } from './hooks/usePrices';
import { SignTransactionModal } from './components/walletconnect/SignTransactionModal';
import { SignMessageModal } from './components/walletconnect/SignMessageModal';
import { useTheme } from './context/useTheme';
import {
  useLocalNotificationSetup,
    useNotificationQueueReset,
    useOutboundTransactionRecovery,
    useScreenSecurity,
    useWalletNetworkBootstrap,
    useStatusBarSync,
  useUtxoQueueToOsNotifications,
  useWalletConnectInitialization,
  useWorkerLifecycle,
} from './app/useAppLifecycle';
import UtxoNotificationCenter from './components/notifications/UtxoNotificationCenter';
import MarketplaceAppHost from './pages/apps/MarketplaceAppHost';
import CreateWalletPage from './pages/onboarding/CreateWalletPage';
import ImportWalletPage from './pages/onboarding/ImportWalletPage';
import LandingPage from './pages/onboarding/LandingPage';

function App() {
  usePrices();
  const { mode } = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector(selectWalletId);
  const utxoQueue = useSelector((s: RootState) => s.notifications.queue);
  const hasWallet = useSelector(selectHasWallet);

  useWalletConnectInitialization(dispatch);
  useStatusBarSync(mode);
  useScreenSecurity();
  useLocalNotificationSetup();
  const notified = useUtxoQueueToOsNotifications(utxoQueue);
  useNotificationQueueReset(walletId, dispatch, notified);
  const walletNetworkReady = useWalletNetworkBootstrap(walletId, dispatch);
  useWorkerLifecycle(walletNetworkReady ? walletId : null);
  useOutboundTransactionRecovery(walletNetworkReady ? walletId : null);

  return (
    <div className="app-shell">
      <main className="main-flex-1">
        <Routes>
          <Route path="/" element={<RootHandler />} />
          {hasWallet ? (
            <>
              <Route element={<Layout />}>
                <Route path="/home/:wallet_id" element={<Home />} />
                <Route path="/contract" element={<ContractView />} />
                <Route path="/apps" element={<AppsView />} />
                <Route path="/apps/:appId" element={<MarketplaceAppHost />} />
                <Route
                  path="/apps/fundme"
                  element={(
                    <div className="container mx-auto p-4">
                      <div className="text-xl font-semibold">FundMe</div>
                      <div className="mt-2 wallet-muted">Coming soon.</div>
                    </div>
                  )}
                />
                <Route path="/campaign/:id" element={<CampaignDetail />} />
                <Route path="/receive" element={<Receive />} />
                <Route path="/send" element={<SimpleSend />} />
                <Route path="/outbox" element={<Outbox />} />
                <Route path="/transaction" element={<Transaction />} />
                <Route
                  path="/transactions/:wallet_id"
                  element={<TransactionHistory />}
                />
                <Route path="/settings" element={<Settings />} />
              </Route>
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
              <Route path="/createwallet" element={<CreateWalletPage />} />
              <Route path="/importwallet" element={<ImportWalletPage />} />
              <Route path="*" element={<Navigate to="/landing" replace />} />
            </>
          )}
        </Routes>
        {/* 🔥 Always active modals */}
        <SignMessageModal />
        <SignTransactionModal />
        {/* 🔔 Always-on in-app UTXO popup (only when wallet exists) */}
        {hasWallet && <UtxoNotificationCenter />}
      </main>
    </div>
  );
}

export default App;
