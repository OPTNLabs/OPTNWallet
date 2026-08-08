import { Suspense, lazy } from 'react';
import Home from '../features/home/Home';
import Assets from '../pages/Assets';
import Actions from '../features/actions/Actions';
import ContractView from '../features/contract-view/ContractView';
import Settings from '../features/settings/Settings';
import Transaction from '../features/transaction/Transaction';
import TransactionHistory from '../features/transaction-history/TransactionHistory';
import Receive from '../pages/Receive';
import Quantumroot from '../pages/Quantumroot';
import CashFusionApp from '../pages/CashFusionApp';
import Paryon from '../pages/Paryon';
import Outbox from '../pages/Outbox';
import PaperWalletSweep from '../pages/PaperWalletSweep';
import MintCashTokensPoC from '../pages/MintCashTokensPoC';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import Layout from '../components/Layout';
import RootHandler from '../pages/RootHandler';
import AppsView from '../features/apps/AppsView';
import { AppDispatch, RootState } from '../state/store';
import {
  selectHasWallet,
  selectWalletId,
  selectWalletType,
} from '../state/slices/walletSlice';import CampaignDetail from '../pages/apps/fundme/CampaignDetail';
import { usePrices } from '../hooks/usePrices';
import { SignTransactionModal } from '../components/walletconnect/SignTransactionModal';
import { SignMessageModal } from '../components/walletconnect/SignMessageModal';
import WizardSignTransactionModal from '../components/wizardconnect/WizardSignTransactionModal';
import {
  useLocalNotificationSetup,
  useNotificationQueueReset,
  useOutboundTransactionRecovery,
  useElectrumConnectivityWatch,
  useWalletNetworkBootstrap,
  useNativeBcmrWarmup,
  useServerNotificationPolling,
  useOptionalPlayUpdateCheck,
  useStatusBarSync,
  useUtxoQueueToOsNotifications,
  useWalletConnectInitialization,
  useWalletConnectSessionWatch,
  useWizardConnectInitialization,
  useWizardConnectSessionWatch,
  useWorkerLifecycle,
  useWalletBackendSync,
} from './useAppLifecycle';
import UtxoNotificationCenter from '../components/notifications/UtxoNotificationCenter';
import ServerNotificationCenter from '../components/notifications/ServerNotificationCenter';
import MarketplaceAppHost from '../pages/apps/MarketplaceAppHost';
import CreateWalletPage from '../pages/onboarding/CreateWalletPage';
import ImportWalletPage from '../pages/onboarding/ImportWalletPage';
import LandingPage from '../pages/onboarding/LandingPage';
import {
  ROUTE_PATHS,
  homeRoute,
  transactionsRoute,
} from '../navigation/routes';
import { NostrChatRoute } from '../features/nostr/NostrChatRoute';

const SimpleSend = lazy(() => import('../features/simple-send/SimpleSend'));
const WatchOnlySend = lazy(() => import('../features/watch-only-send/WatchOnlySend'));
const NostrChat = lazy(() => import('../features/nostr/NostrChat'));

/**
 * /send routes to the air-gapped watch-only workspace when the open wallet is
 * watch-only (no signing keys here), and to the normal send flow otherwise.
 */
function SendRoute() {
  const walletType = useSelector(selectWalletType);
  // Watch-only = air-gap PSBT. Hardware = live USB device (SimpleSend until
  // Ledger sign is fully wired into the send path — not the QR workspace).
  return walletType === 'watch-only' ? <WatchOnlySend /> : <SimpleSend />;
}

type AppShellProps = {
  viewerOnly?: boolean;
};

function App({ viewerOnly = false }: AppShellProps) {
  usePrices();
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector(selectWalletId);
  const utxoQueue = useSelector((s: RootState) => s.notifications.queue);
  const hasWallet = useSelector(selectHasWallet);

  useWalletConnectInitialization(dispatch, !viewerOnly);
  useWizardConnectInitialization(viewerOnly ? null : walletId, dispatch);
  useStatusBarSync();
  useOptionalPlayUpdateCheck();
  useLocalNotificationSetup();
  const notified = useUtxoQueueToOsNotifications(utxoQueue);
  useNotificationQueueReset(walletId, dispatch, notified);
  const walletNetworkReady = useWalletNetworkBootstrap(walletId, dispatch);
  useNativeBcmrWarmup(walletNetworkReady ? walletId : null);
  useWorkerLifecycle(walletNetworkReady ? walletId : null);
  useOutboundTransactionRecovery(
    !viewerOnly && walletNetworkReady ? walletId : null
  );
  useElectrumConnectivityWatch(walletNetworkReady ? walletId : null);
  useWalletBackendSync(walletNetworkReady ? walletId : null);
  useServerNotificationPolling(walletNetworkReady ? walletId : null, dispatch);
  useWalletConnectSessionWatch(
    !viewerOnly && walletNetworkReady ? walletId : null,
    dispatch
  );
  useWizardConnectSessionWatch(
    !viewerOnly && walletNetworkReady ? walletId : null,
    dispatch
  );

  return (
    <div className="app-shell">
      <main className="main-flex-1">
        <Suspense fallback={<div className="main-flex-1" />}>
          <Routes>
            <Route path={ROUTE_PATHS.root} element={<RootHandler />} />
            {hasWallet ? (
              <>
                <Route element={<Layout viewerOnly={viewerOnly} />}>
                  <Route
                    path={ROUTE_PATHS.home}
                    element={<Home viewerOnly={viewerOnly} />}
                  />
                  <Route
                    path={ROUTE_PATHS.assets}
                    element={<Assets viewerOnly={viewerOnly} />}
                  />
                  <Route path={ROUTE_PATHS.receive} element={<Receive />} />
                  <Route
                    path={ROUTE_PATHS.transactions}
                    element={<TransactionHistory />}
                  />
                  {!viewerOnly && (
                    <>
                      <Route path={ROUTE_PATHS.actions} element={<Actions />} />
                      <Route
                        path={ROUTE_PATHS.chat}
                        element={
                          <NostrChatRoute>
                            <NostrChat />
                          </NostrChatRoute>
                        }
                      />
                      <Route
                        path={ROUTE_PATHS.chatConversation}
                        element={
                          <NostrChatRoute>
                            <NostrChat />
                          </NostrChatRoute>
                        }
                      />
                      <Route
                        path={ROUTE_PATHS.contract}
                        element={<ContractView />}
                      />
                      <Route path={ROUTE_PATHS.apps} element={<AppsView />} />
                      <Route path={ROUTE_PATHS.paryon} element={<Paryon />} />
                      <Route
                        path={ROUTE_PATHS.appDetail}
                        element={<MarketplaceAppHost />}
                      />
                      <Route
                        path={ROUTE_PATHS.fundmeLegacy}
                        element={
                          <Navigate
                            to="/apps/optn.builtin.fundme:fundmeApp"
                            replace
                          />
                        }
                      />
                      <Route
                        path="/apps/optn.builtin.paper-wallet-sweep:paperWalletSweepApp"
                        element={<Navigate to="/paper-wallet-sweep" replace />}
                      />
                      <Route
                        path={ROUTE_PATHS.campaignDetail}
                        element={<CampaignDetail />}
                      />
                      <Route
                        path={ROUTE_PATHS.quantumroot}
                        element={<Quantumroot />}
                      />
                      <Route
                        path={ROUTE_PATHS.cashfusion}
                        element={<CashFusionApp />}
                      />
                      <Route path={ROUTE_PATHS.send} element={<SendRoute />} />
                      <Route path={ROUTE_PATHS.outbox} element={<Outbox />} />
                      <Route
                        path="/mint-cashtokens-poc"
                        element={<MintCashTokensPoC />}
                      />
                      <Route
                        path="/paper-wallet-sweep"
                        element={<PaperWalletSweep />}
                      />
                      <Route
                        path={ROUTE_PATHS.transactionBuilder}
                        element={<Transaction />}
                      />
                      <Route
                        path={ROUTE_PATHS.settings}
                        element={<Settings />}
                      />
                    </>
                  )}
                </Route>
                <Route
                  path={ROUTE_PATHS.historyLegacy}
                  element={
                    <Navigate to={transactionsRoute(walletId)} replace />
                  }
                />
                <Route
                  path="*"
                  element={<Navigate to={homeRoute(walletId)} replace />}
                />
              </>
            ) : (
              <>
                <Route path={ROUTE_PATHS.landing} element={<LandingPage />} />
                <Route
                  path={ROUTE_PATHS.createWallet}
                  element={<CreateWalletPage />}
                />
                <Route
                  path={ROUTE_PATHS.importWallet}
                  element={<ImportWalletPage />}
                />
                <Route
                  path="*"
                  element={<Navigate to={ROUTE_PATHS.landing} replace />}
                />
              </>
            )}
          </Routes>
        </Suspense>
        {/* 🔥 Always active modals */}
        {!viewerOnly && (
          <>
            <SignMessageModal />
            <SignTransactionModal />
            <WizardSignTransactionModal />
          </>
        )}
        {/* 🔔 Always-on in-app UTXO popup (only when wallet exists) */}
        {hasWallet && <UtxoNotificationCenter />}
        {hasWallet && <ServerNotificationCenter />}
      </main>
    </div>
  );
}

export default App;
