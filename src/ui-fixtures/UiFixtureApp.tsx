import { useEffect, useMemo, type ReactNode } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { Provider } from 'react-redux';
import Home from '../features/home/Home';
import SimpleSend from '../features/simple-send/SimpleSend';
import TransactionHistory from '../features/transaction-history/TransactionHistory';
import Receive from '../pages/Receive';
import Outbox from '../pages/Outbox';
import AppsView from '../features/apps/AppsView';
import Settings from '../features/settings/Settings';
import LandingPage from '../features/onboarding/LandingPage';
import WatchOnlyWalletPage from '../features/onboarding/WatchOnlyWalletPage';
import { SignTransactionModal } from '../components/walletconnect/SignTransactionModal';
import WizardSignTransactionModal from '../components/wizardconnect/WizardSignTransactionModal';
import CashConnectExecuteActionModal from '../components/cashconnect/CashConnectExecuteActionModal';
import BuilderReviewFixture from './BuilderReviewFixture';
import { createNonPersistedStore } from '../state/store';
import { Network, setNetwork } from '../state/slices/networkSlice';
import {
  setWalletId,
  setWalletNetwork,
  setWalletType,
} from '../state/slices/walletSlice';
import {
  replaceAllUTXOs,
  setInitialized,
  setWalletSyncStatus,
} from '../state/slices/utxoSlice';
import { setTransactions } from '../state/slices/transactionSlice';
import { upsertPrices } from '../state/slices/priceFeedSlice';
import { enqueueNotification } from '../state/slices/notificationsSlice';
import { WalletType } from '../types/wallet';
import {
  getUiFixtureWalletConnectRequest,
  getUiFixtureCashConnectAction,
  getUiFixtureWizardConnections,
  getUiFixtureWizardSignRequest,
  getUiFixtureTransactions,
  getUiFixtureTxids,
  getUiFixtureUtxos,
  UI_FIXTURE_PRIMARY_ADDRESS,
  UI_FIXTURE_WALLET_ID,
  uiFixtureScenario,
} from './fixtureData';
import {
  setActiveSessions,
  setPendingSignTx,
} from '../state/slices/walletconnectSlice';
import {
  setActiveConnections,
  setPendingSignRequest,
} from '../state/slices/wizardconnectSlice';
import { setCashConnectAction } from '../state/slices/cashconnectSlice';

function seedUiFixtureStore(
  fixtureStore: ReturnType<typeof createNonPersistedStore>
) {
  const scenario = uiFixtureScenario();
  fixtureStore.dispatch(setWalletId(UI_FIXTURE_WALLET_ID));
  fixtureStore.dispatch(setWalletNetwork(Network.CHIPNET));
  fixtureStore.dispatch(setNetwork(Network.CHIPNET));
  fixtureStore.dispatch(setWalletType(WalletType.STANDARD));
  fixtureStore.dispatch(
    replaceAllUTXOs({ utxosByAddress: getUiFixtureUtxos() })
  );
  fixtureStore.dispatch(setInitialized(true));
  fixtureStore.dispatch(
    setWalletSyncStatus({
      status:
        scenario === 'home-stale'
          ? 'stale'
          : scenario === 'home-unavailable'
            ? 'unavailable'
            : 'current',
      checkedAt: Date.now(),
    })
  );
  fixtureStore.dispatch(
    setTransactions({
      wallet_id: UI_FIXTURE_WALLET_ID,
      transactions: getUiFixtureTransactions(scenario),
      sessionGeneration: fixtureStore.getState().wallet_id.sessionGeneration,
    })
  );
  fixtureStore.dispatch(
    upsertPrices({
      'BCH-USD': { price: 480, ts: Date.now(), source: 'optnlabs' },
    })
  );
  fixtureStore.dispatch(
    enqueueNotification({
      id: 'ui-fixture-incoming-payment',
      kind: 'utxo',
      address: UI_FIXTURE_PRIMARY_ADDRESS,
      value: 12_500_000,
      txid: getUiFixtureTxids().pending,
      createdAt: Date.now(),
      height: 0,
    })
  );
  if (scenario.startsWith('walletconnect')) {
    fixtureStore.dispatch(setActiveSessions({}));
    fixtureStore.dispatch(setPendingSignTx(getUiFixtureWalletConnectRequest()));
  }
  if (scenario.startsWith('wizardconnect')) {
    fixtureStore.dispatch(
      setActiveConnections(getUiFixtureWizardConnections())
    );
    fixtureStore.dispatch(
      setPendingSignRequest(getUiFixtureWizardSignRequest(scenario))
    );
  }
  if (scenario.startsWith('cashconnect')) {
    fixtureStore.dispatch(
      setCashConnectAction(getUiFixtureCashConnectAction(scenario))
    );
  }
}

function FixtureNav() {
  const links = [
    ['onboarding', 'Onboarding'],
    ['watch-only', 'Watch-only'],
    ['home', 'Home'],
    ['send', 'Send'],
    ['receive', 'Receive'],
    [`history/${UI_FIXTURE_WALLET_ID}`, 'History'],
    ['outbox', 'Outbox'],
    ['apps', 'Apps'],
    ['settings', 'Settings'],
    ['walletconnect', 'WalletConnect'],
    ['wizardconnect', 'WizardConnect'],
    ['cashconnect', 'CashConnect'],
    ['builder', 'Builder'],
  ] as const;

  return (
    <nav
      aria-label="UI fixture screens"
      className="mx-auto flex max-w-md flex-wrap gap-1 px-3 pb-2"
    >
      {links.map(([path, label]) => (
        <Link
          key={path}
          to={`/fixture/${path}`}
          state={
            path === 'send' || path === 'receive'
              ? { returnTo: '/fixture/home' }
              : undefined
          }
          className="min-h-[44px] shrink-0 rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-sm font-semibold wallet-text-strong"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function FixtureChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[var(--wallet-bg)] pb-4">
      <div className="mx-auto max-w-md px-3 pt-3">
        <div
          role="status"
          className="rounded-2xl border border-amber-500/70 bg-amber-400/15 px-3 py-2 text-xs font-semibold text-amber-950 dark:text-amber-100"
        >
          UI fixture · disposable CHIPNET data · no signing or live provider
        </div>
      </div>
      <div className="mt-2">
        <FixtureNav />
      </div>
      {children}
    </div>
  );
}

function FixtureSendRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const scenario = uiFixtureScenario();

  useEffect(() => {
    if (location.state) return;
    navigate(location.pathname, {
      replace: true,
      state: {
        recipient: UI_FIXTURE_PRIMARY_ADDRESS,
        amountBch: scenario === 'send-error' ? '2' : '0.1',
        assetType: 'bch',
        returnTo: '/fixture/home',
      },
    });
  }, [location.pathname, location.state, navigate, scenario]);

  return <SimpleSend />;
}

export default function UiFixtureApp() {
  const fixtureStore = useMemo(() => {
    const nextStore = createNonPersistedStore();
    seedUiFixtureStore(nextStore);
    return nextStore;
  }, []);
  const scenario = uiFixtureScenario();
  const fixtureRoute = scenario.startsWith('history')
    ? 'history'
    : scenario.startsWith('outbox')
      ? 'outbox'
      : scenario.startsWith('apps')
        ? 'apps'
        : scenario.startsWith('settings')
          ? 'settings'
          : scenario.startsWith('onboarding')
            ? 'onboarding'
            : scenario.startsWith('watch-only')
              ? 'watch-only'
              : scenario.startsWith('walletconnect')
                ? 'walletconnect'
                : scenario.startsWith('wizardconnect')
                  ? 'wizardconnect'
                  : scenario.startsWith('cashconnect')
                    ? 'cashconnect'
                    : scenario.startsWith('builder')
                      ? 'builder'
                      : scenario.startsWith('send')
                        ? 'send'
                        : scenario.startsWith('receive')
                          ? 'receive'
                          : 'home';
  const defaultPath =
    fixtureRoute === 'history'
      ? `/fixture/history/${UI_FIXTURE_WALLET_ID}`
      : `/fixture/${fixtureRoute}`;

  return (
    <Provider store={fixtureStore}>
      <FixtureChrome>
        <Routes>
          <Route path="/fixture/onboarding" element={<LandingPage />} />
          <Route path="/fixture/watch-only" element={<WatchOnlyWalletPage />} />
          <Route path="/fixture/home" element={<Home />} />
          <Route path="/fixture/send" element={<FixtureSendRoute />} />
          <Route path="/fixture/receive" element={<Receive />} />
          <Route
            path="/fixture/history/:wallet_id"
            element={<TransactionHistory />}
          />
          <Route path="/fixture/outbox" element={<Outbox />} />
          <Route path="/fixture/apps" element={<AppsView />} />
          <Route path="/fixture/settings" element={<Settings />} />
          <Route
            path="/fixture/walletconnect"
            element={<SignTransactionModal />}
          />
          <Route
            path="/fixture/wizardconnect"
            element={<WizardSignTransactionModal />}
          />
          <Route
            path="/fixture/cashconnect"
            element={<CashConnectExecuteActionModal />}
          />
          <Route path="/fixture/builder" element={<BuilderReviewFixture />} />
          <Route path="*" element={<Navigate to={defaultPath} replace />} />
        </Routes>
      </FixtureChrome>
    </Provider>
  );
}
