import { Suspense, lazy, useEffect, useState } from 'react';
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
import { AppDispatch, RootState, persistor } from '../state/store';
import {
  selectHasWallet,
  selectWalletId,
  selectWalletType,
} from '../state/slices/walletSlice';
import CampaignDetail from '../pages/apps/fundme/CampaignDetail';
import { usePrices } from '../hooks/usePrices';
import { SignTransactionModal } from '../components/walletconnect/SignTransactionModal';
import { SignMessageModal } from '../components/walletconnect/SignMessageModal';
import WizardSignTransactionModal from '../components/wizardconnect/WizardSignTransactionModal';
import SessionProposalModal from '../components/walletconnect/SessionProposalModal';
import CashConnectSessionProposalModal from '../components/cashconnect/CashConnectSessionProposalModal';
import CashConnectExecuteActionModal from '../components/cashconnect/CashConnectExecuteActionModal';
import CashConnectErrorModal from '../components/cashconnect/CashConnectErrorModal';
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
  useCashConnectInitialization,
  useCashConnectDeepLink,
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
import MultisigReceive from '../features/multisig/MultisigReceive';
import MultisigHome from '../features/multisig/MultisigHome';
import MultisigLayout from '../features/multisig/MultisigLayout';
import MultisigPolicy from '../features/multisig/MultisigPolicy';
import MultisigCosignerWorkspace from '../features/multisig/MultisigCosignerWorkspace';
import { sendSurfaceForWalletType } from './walletRouting';
import {
  ROUTE_PATHS,
  homeRoute,
  transactionsRoute,
} from '../navigation/routes';
import { NostrChatRoute } from '../features/nostr/NostrChatRoute';
import { isDesktopPlatform } from '../utils/platform';

const SimpleSend = lazy(() => import('../features/simple-send/SimpleSend'));
const WatchOnlySend = lazy(
  () => import('../features/watch-only-send/WatchOnlySend')
);
const MultisigSendWorkspace = lazy(
  () => import('../features/multisig/MultisigSendWorkspace')
);
const MultisigSetup = lazy(() => import('../features/multisig/MultisigSetup'));
const NostrChat = lazy(() => import('../features/nostr/NostrChat'));

/**
 * /send routes to the air-gapped watch-only workspace when the open wallet is
 * watch-only (no signing keys here), and to the normal send flow otherwise.
 */
function SendRoute() {
  const walletType = useSelector(selectWalletType);
  // Hardware = live device (including existing SeedSigner-style integrations),
  // never the BCH multisig PSBT coordinator.
  const surface = sendSurfaceForWalletType(walletType);
  if (surface === 'multisig') {
    return isDesktopPlatform() ? (
      <Navigate to={ROUTE_PATHS.root} replace />
    ) : (
      <MultisigSendWorkspace />
    );
  }
  return surface === 'watch-only' ? <WatchOnlySend /> : <SimpleSend />;
}

type AppShellProps = {
  viewerOnly?: boolean;
};

function AppContent({ viewerOnly = false }: AppShellProps) {
  usePrices();
  const dispatch = useDispatch<AppDispatch>();
  const desktop = isDesktopPlatform();
  const walletId = useSelector(selectWalletId);
  const utxoQueue = useSelector((s: RootState) => s.notifications.queue);
  const hasWallet = useSelector(selectHasWallet);

  useWalletConnectInitialization(dispatch, !viewerOnly);
  useWizardConnectInitialization(viewerOnly ? null : walletId, dispatch);
  useCashConnectInitialization(viewerOnly ? null : walletId, dispatch);
  useCashConnectDeepLink(viewerOnly ? null : walletId, dispatch, !viewerOnly);
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
            {!desktop && (
              /*
               * The internal multisig wallet is a mobile/common feature. The
               * desktop build keeps its existing watch-only/air-gap multisig
               * wizard and must not enter this route family.
               */
              <Route
                path={ROUTE_PATHS.multisigSetup}
                element={<MultisigSetup />}
              />
            )}
            {hasWallet ? (
              <>
                {!desktop && (
                  <Route
                    path={ROUTE_PATHS.multisigWorkspace}
                    element={<MultisigLayout />}
                  >
                    <Route index element={<MultisigHome />} />
                    <Route path="receive" element={<MultisigReceive />} />
                    <Route path="send" element={<MultisigSendWorkspace />} />
                    <Route
                      path="sign"
                      element={<MultisigCosignerWorkspace />}
                    />
                    <Route path="policy" element={<MultisigPolicy />} />
                  </Route>
                )}
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
            <SessionProposalModal />
            <SignMessageModal />
            <SignTransactionModal />
            <WizardSignTransactionModal />
            <CashConnectSessionProposalModal />
            <CashConnectExecuteActionModal />
            <CashConnectErrorModal />
          </>
        )}
        {/* 🔔 Always-on in-app UTXO popup (only when wallet exists) */}
        {hasWallet && <UtxoNotificationCenter />}
        {hasWallet && <ServerNotificationCenter />}
      </main>
    </div>
  );
}

function AppShell({ viewerOnly = false }: AppShellProps) {
  const [rehydrated, setRehydrated] = useState(
    () => persistor.getState().bootstrapped
  );

  useEffect(() => {
    if (rehydrated) return;

    const markReady = () => setRehydrated(true);
    const unsubscribe = persistor.subscribe(() => {
      if (persistor.getState().bootstrapped) markReady();
    });

    // Close the small race between the initial bootstrapped read and the
    // subscription being installed, including React StrictMode remounts.
    if (persistor.getState().bootstrapped) markReady();
    return unsubscribe;
  }, [rehydrated]);

  if (!rehydrated) {
    return (
      <main
        className="main-flex-1 flex items-center justify-center wallet-surface"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="wallet-muted">Loading wallet…</span>
      </main>
    );
  }

  return <AppContent viewerOnly={viewerOnly} />;
}

export default AppShell;
