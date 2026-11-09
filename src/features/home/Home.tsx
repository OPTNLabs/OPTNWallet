import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaQrcode } from 'react-icons/fa';
import { AppDispatch, RootState } from '../../state/store';
import { Network } from '../../state/slices/networkSlice';
import {
  setFetchingUTXOs,
  replaceAllUTXOs,
  setInitialized,
} from '../../state/slices/utxoSlice';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import SectionHeader from '../../components/ui/SectionHeader';
import WalletScreen from '../../components/ui/WalletScreen';
import PriceFeed from '../../components/PriceFeed';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumService from '../../services/ElectrumService';
import { runWalletUtxoRefreshExclusive } from '../../services/RefreshCoordinator';
import {
  captureActiveWalletSession,
  fetchActiveWalletUtxos,
  isActiveWalletSession,
} from '../../services/WalletUtxoRefreshService';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';
import { refreshUTXOWorkerSubscriptions } from '../../workers/UTXOWorkerService';
import { logError } from '../../utils/errorHandling';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { SATSINBITCOIN } from '../../utils/constants';
import { selectRpaStealthSats } from '../../state/slices/walletSpecialActivitySlice';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import {
  isMempoolLike,
  takeRecentTransactions,
} from '../../utils/transactionHistoryOrder';
import { isTxConfirmed } from '../../utils/txConfirmation';
import { isFusionTransaction } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import HomeConnectPopup from '../../components/home/HomeConnectPopup';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import { useHomeConnect } from './useHomeConnect';
import { useI18n } from '../../i18n/useI18n';
import { unitFor } from '../../utils/unitLabel';
import BchUsdControl from '../../components/ui/BchUsdControl';
import NetworkContextBanner from '../../components/ui/NetworkContextBanner';
import MaskedValue from '../../components/ui/MaskedValue';
import { formatNumber } from '../../i18n/format';
import InfoButton from '../../components/ui/InfoButton';
import StatusChip from '../../components/ui/StatusChip';
import { isTestNetwork, networkProfile } from '../../utils/networkProfile';

type QuickActionButtonProps = {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  testId?: string;
  attention?: boolean;
};

function getQuickActionTextClass(title: string) {
  return `min-w-0 truncate leading-none tracking-normal text-[clamp(0.98rem,3.1vw,1.08rem)] font-semibold wallet-text-strong ${
    title.length > 5 ? 'tracking-[-0.01em]' : ''
  }`;
}

function QuickActionButton({
  title,
  icon,
  onClick,
  testId,
  attention = false,
}: QuickActionButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`wallet-card flex min-h-[4.9rem] min-w-0 flex-[1_1_0%] items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition hover:brightness-[0.98] ${
        attention
          ? 'ring-2 ring-[var(--wallet-accent)] ring-offset-2 ring-offset-[var(--wallet-bg)]'
          : ''
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)]">
        {icon}
      </div>
      <span className={getQuickActionTextClass(title)}>{title}</span>
      {attention ? (
        <span
          className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--wallet-accent-strong)]"
          aria-label={title}
        />
      ) : null}
    </button>
  );
}

type HomeProps = {
  viewerOnly?: boolean;
};

const Home: React.FC<HomeProps> = ({ viewerOnly = false }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const { t, locale } = useI18n();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const fusionDepthRev = useFusionDepthRevision(Number(currentWalletId) || 0);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
  );
  const walletSyncStatus = useSelector(
    (state: RootState) => state.utxos.walletSyncStatus
  );
  const sessionGeneration = useSelector(
    (state: RootState) => state.wallet_id.sessionGeneration ?? 0
  );
  const addressDiscoveryInProgress = useSelector(
    (state: RootState) => state.utxos.addressDiscoveryInProgress
  );
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );
  const stealthSats = useSelector((state: RootState) =>
    selectRpaStealthSats(state, currentWalletId)
  );
  const transactions = useSelector(
    (state: RootState) => state.transactions.transactions[currentWalletId]
  );
  const currentNetwork = useSelector(selectCurrentNetwork);
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const unit = unitFor(currentNetwork);
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [incomingFlag, setIncomingFlag] = useState<{
    key: string;
    title: string;
    amountSats?: number;
    address: string | null;
    txid: string;
  } | null>(null);
  const homeConnect = useHomeConnect();
  const totalBch = (totalBalance + stealthSats) / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  const syncNotice = fetchingUTXOsRedux
    ? null
    : walletSyncStatus === 'unverified'
      ? t('home.balanceNotVerified')
      : walletSyncStatus === 'stale' || walletSyncStatus === 'unavailable'
        ? t('home.balanceMayBeOutdated')
        : null;
  // Sort by height / unconfirmed — not array index (Electrum merge order).
  const recentTransactions = useMemo(
    () => takeRecentTransactions(transactions, 3),
    [transactions]
  );
  const incomingUtxo = useSelector((state: RootState) =>
    state.notifications.queue.find((item) => item.kind === 'utxo')
  );
  const incomingServer = useSelector((state: RootState) =>
    state.serverNotifications.queue.find(
      (item) => item.kind === 'incoming_bch' || item.kind === 'incoming_token'
    )
  );
  const incomingSourceKey = incomingUtxo
    ? `utxo:${incomingUtxo.id}`
    : incomingServer
      ? `server:${incomingServer.id}`
      : '';

  useEffect(() => {
    if (!incomingSourceKey) return;

    const source = incomingUtxo;
    const server = incomingServer;
    if (source) {
      setIncomingFlag({
        key: incomingSourceKey,
        title: t('notifications.fundsReceived'),
        amountSats: source.value ?? 0,
        address: source.address,
        txid: source.txid,
      });
    } else if (server) {
      const title =
        server.kind === 'incoming_token'
          ? t('notifications.incomingToken')
          : t('notifications.incomingBch');
      setIncomingFlag({
        key: incomingSourceKey,
        title,
        address: server.address,
        txid: server.txid,
      });
    }

    const timer = window.setTimeout(() => setIncomingFlag(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [incomingServer, incomingSourceKey, incomingUtxo, locale, t]);
  // Sync is explicit here. Background wallet synchronization is owned by the
  // shared worker lifecycle so returning to Home does not start another full
  // network, UTXO, and history pass.
  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;
    const walletSession = captureActiveWalletSession(currentWalletId);
    if (!walletSession) return;

    dispatch(setFetchingUTXOs(true));
    setRefreshFailed(false);

    try {
      await ElectrumService.ensureFreshConnection();
      if (!isActiveWalletSession(walletSession)) return;

      // Fetch materialized addresses first. Account discovery can scan several
      // HD windows and must not hide a current balance behind a slow search.
      const walletUtxos = await fetchActiveWalletUtxos(
        walletSession,
        undefined,
        { discover: false, force: true, trackWalletSync: true }
      );
      if (!walletUtxos) return;
      if (import.meta.env.DEV) {
        const coins = Object.values(walletUtxos).flat();
        console.info('[WalletSync] Home known-address publish', {
          walletId: currentWalletId,
          addressCount: Object.keys(walletUtxos).length,
          coinCount: coins.length,
          totalSats: coins.reduce(
            (total, utxo) => total + (utxo.value ?? utxo.amount ?? 0),
            0
          ),
        });
      }
      dispatch(replaceAllUTXOs({ utxosByAddress: walletUtxos }));
      dbService.scheduleDatabaseSave(currentWalletId);
      dispatch(setInitialized(true));
      const refreshedCategories = Array.from(
        new Set(
          Object.values(walletUtxos)
            .flat()
            .map((utxo) => utxo.token?.category)
            .filter((category): category is string => Boolean(category))
        )
      );
      if (refreshedCategories.length > 0) {
        void preloadTokenMetadata(refreshedCategories);
      }
      await refreshUTXOWorkerSubscriptions();

      // Keep Recent Activity aligned with the refreshed balance. Desktop Sync
      // already uses this shared full-history pass; Capacitor must not leave a
      // received payment invisible until the Transactions screen is opened.
      await refreshWalletTransactionHistory({
        walletId: currentWalletId,
        dispatch,
        sessionGeneration,
        force: true,
      });

      // Continue the full HD address scan after the known-address balance is
      // visible. UTXOService exposes its discovery state to the UI while this
      // follow-up work runs.
      void runWalletUtxoRefreshExclusive(currentWalletId, async () => {
        const discoveredWalletUtxos = await fetchActiveWalletUtxos(
          walletSession,
          undefined,
          { discover: true, force: true }
        );
        if (!discoveredWalletUtxos || !isActiveWalletSession(walletSession)) {
          return;
        }
        if (import.meta.env.DEV) {
          const coins = Object.values(discoveredWalletUtxos).flat();
          console.info('[WalletSync] Home discovered-address publish', {
            walletId: currentWalletId,
            addressCount: Object.keys(discoveredWalletUtxos).length,
            coinCount: coins.length,
            totalSats: coins.reduce(
              (total, utxo) => total + (utxo.value ?? utxo.amount ?? 0),
              0
            ),
          });
        }
        dispatch(replaceAllUTXOs({ utxosByAddress: discoveredWalletUtxos }));
        dbService.scheduleDatabaseSave(currentWalletId);
        dispatch(setInitialized(true));
        await refreshUTXOWorkerSubscriptions();
      }).catch((error) => {
        logError('Home.backgroundAddressDiscovery', error, {
          walletId: currentWalletId,
        });
      });
    } catch (error) {
      setRefreshFailed(true);
      logError('Home.handleRefresh', error, { walletId: currentWalletId });
    } finally {
      // Always clear Syncing for this click — even if the session ended mid-flight.
      dispatch(setFetchingUTXOs(false));
    }
  }, [
    currentWalletId,
    dbService,
    dispatch,
    fetchingUTXOsRedux,
    sessionGeneration,
  ]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('home.title')}
          subtitle={
            viewerOnly
              ? isTestNetwork(currentNetwork)
                ? `${t(networkProfile(currentNetwork).labelKey)} - Browser viewer`
                : 'Browser viewer'
              : isTestNetwork(currentNetwork)
                ? t(networkProfile(currentNetwork).labelKey)
                : undefined
          }
          compact
        />
        <NetworkContextBanner network={currentNetwork} />

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          <SectionCard
            className={`shrink-0 border-2 p-3 ${
              currentNetwork === Network.CHIPNET
                ? 'border-indigo-400/70 bg-indigo-500/5'
                : 'border-emerald-500/70 bg-emerald-500/5'
            }`}
          >
            <SectionHeader
              title={t('home.portfolio')}
              subtitle={t('home.walletOverview')}
              compact
              action={
                <div className="flex items-center gap-2">
                  {addressDiscoveryInProgress && (
                    <div
                      className="flex items-center gap-1.5 text-xs wallet-muted"
                      role="status"
                      aria-live="polite"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--wallet-accent-strong)]" />
                      <span>{t('home.syncing')}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleRefresh}
                    className="wallet-btn-secondary min-h-[44px] px-3 py-1.5 text-sm"
                    disabled={fetchingUTXOsRedux}
                    aria-busy={fetchingUTXOsRedux}
                  >
                    {fetchingUTXOsRedux ? t('home.syncing') : t('home.sync')}
                  </button>
                </div>
              }
            />
            {incomingFlag ? (
              <div
                className="mt-3 flex items-start gap-3 rounded-2xl border border-[var(--wallet-accent)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_54%,transparent)] p-3"
                role="status"
                aria-live="polite"
              >
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--wallet-accent-strong)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold wallet-text-strong">
                    {incomingFlag.title}
                  </div>
                  <div className="mt-1 grid min-w-0 gap-1 text-xs wallet-muted">
                    {incomingFlag.amountSats !== undefined ? (
                      <span className="wallet-text-strong">
                        {t('send.amount')}:{' '}
                        {formatNumber(incomingFlag.amountSats, locale)} sats
                      </span>
                    ) : null}
                    {incomingFlag.address ? (
                      <span className="grid min-w-0 grid-cols-[auto,minmax(0,1fr)] items-center gap-x-2">
                        <span>{t('receive.receiveAddress')}:</span>
                        <MaskedValue
                          value={incomingFlag.address}
                          label={t('receive.receiveAddress')}
                          copySuccessMessageKey="receive.addressCopied"
                          embedded
                          className="block max-w-full truncate text-xs"
                        />
                      </span>
                    ) : (
                      <span>{t('notifications.unknownAddress')}</span>
                    )}
                    <span className="grid min-w-0 grid-cols-[auto,minmax(0,1fr)] items-center gap-x-2">
                      <span>{t('history.transactionId')}:</span>
                      <MaskedValue
                        value={incomingFlag.txid}
                        label={t('history.transactionId')}
                        copySuccessMessageKey="history.transactionCopied"
                        embedded
                        className="block max-w-full truncate text-xs"
                      />
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="min-h-[44px] shrink-0 rounded-xl px-2 text-xs wallet-muted hover:brightness-95"
                  onClick={() => setIncomingFlag(null)}
                  aria-label={t('notifications.dismiss')}
                  title={t('notifications.dismiss')}
                >
                  ✕
                </button>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-left">
                  <div className="text-2xl font-bold wallet-text-strong">
                    {displayMode === 'BCH'
                      ? `${totalBch.toFixed(8)} ${unit}`
                      : totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : t('home.usdUnavailable')}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : t('home.usdPriceUnavailable')
                      : `${totalBch.toFixed(8)} ${unit}`}
                  </div>
                  {stealthSats > 0 && (
                    <div className="mt-0.5 text-[10px] wallet-muted">
                      {displayMode === 'USD'
                        ? totalUsd !== null
                          ? `${t('home.spendableUsd', {
                              amount: `$${((totalBalance / SATSINBITCOIN) * bchUsdQuote!).toFixed(2)}`,
                            })} + ${t('home.stealthUsd', {
                              amount: `$${((stealthSats / SATSINBITCOIN) * bchUsdQuote!).toFixed(2)}`,
                            })}`
                          : t('home.usdUnavailable')
                        : `${t('home.spendableBch', {
                            amount: (totalBalance / SATSINBITCOIN).toFixed(8),
                          })} + ${t('home.stealthBch', {
                            amount: (stealthSats / SATSINBITCOIN).toFixed(8),
                          })}`}
                    </div>
                  )}
                </div>
              </div>
              <BchUsdControl
                value={displayMode.toLowerCase() as 'bch' | 'usd'}
                onChange={(next) =>
                  setDisplayMode(next === 'bch' ? 'BCH' : 'USD')
                }
                className="w-[112px] shrink-0"
              />
            </div>
            {syncNotice && (
              <div
                className="mt-2 flex items-center gap-1 text-xs wallet-muted"
                role="status"
                aria-live="polite"
              >
                <span>{syncNotice}</span>
                <InfoButton
                  id="home-sync-status-help"
                  ariaLabel={t('home.syncStatusHelpLabel')}
                  content={t('home.syncStatusHelp')}
                />
                {walletSyncStatus !== 'unverified' && (
                  <a
                    className="ml-1 inline-flex min-h-[44px] items-center underline"
                    href="#/settings?panel=server"
                  >
                    {t('home.serverSettings')}
                  </a>
                )}
              </div>
            )}
            {refreshFailed && !fetchingUTXOsRedux && (
              <p
                className="mt-2 text-xs text-[var(--wallet-danger-text)]"
                role="alert"
              >
                {t('home.refreshFailed')}
              </p>
            )}
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title={t('home.quickActions')}
              compact
              className="items-center"
              action={
                viewerOnly ? undefined : (
                  <button
                    type="button"
                    onClick={homeConnect.openPopup}
                    disabled={homeConnect.scanning || homeConnect.submitting}
                    className="wallet-card inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_42%,transparent)] px-3 text-[var(--wallet-accent-strong)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70 self-center"
                    aria-label={t('home.scanQr')}
                    title={t('home.scanQr')}
                  >
                    <span className="text-sm font-semibold wallet-text-strong">
                      {t('home.scanQr')}
                    </span>
                    <FaQrcode
                      className={`text-base ${homeConnect.scanning ? 'animate-pulse' : ''}`}
                    />
                  </button>
                )
              }
            />
            <div className="flex items-stretch gap-2.5">
              <QuickActionButton
                title={t('home.receive')}
                testId="home-receive-action"
                icon={<FaArrowDown />}
                attention={Boolean(incomingFlag)}
                onClick={() =>
                  navigate('/receive', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
              {!viewerOnly && (
                <QuickActionButton
                  title={t('home.send')}
                  testId="home-send-action"
                  icon={<FaArrowUp />}
                  onClick={() =>
                    navigate('/send', {
                      state: { returnTo: `/home/${currentWalletId ?? ''}` },
                    })
                  }
                />
              )}
            </div>
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title={t('actions.advancedActions')}
              subtitle={t('actions.deeperTools')}
              compact
            />
            <div className="space-y-2.5">
              <SettingsRow
                title={t('assets.title')}
                description={t('assets.quickInventory')}
                compact
                onClick={() =>
                  navigate('/assets', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
              <SettingsRow
                title={t('apps.title')}
                description={t('apps.subtitle')}
                compact
                onClick={() =>
                  navigate('/apps', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
            </div>
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title={t('home.recentActivity')}
              subtitle={t('home.latestActivity')}
              compact
              action={
                <button
                  className="wallet-link inline-flex min-h-[44px] items-center px-2 text-sm"
                  onClick={() => navigate(`/transactions/${currentWalletId}`)}
                >
                  {t('home.viewAll')}
                </button>
              }
            />
            <div className="space-y-2.5">
              {recentTransactions.length > 0 ? (
                recentTransactions.map((tx) => {
                  void fusionDepthRev;
                  const walletIdNum = Number(currentWalletId);
                  const fused =
                    Number.isFinite(walletIdNum) &&
                    walletIdNum > 0 &&
                    isFusionTransaction(walletIdNum, tx.tx_hash);
                  const confirmed = isTxConfirmed(tx) || !isMempoolLike(tx);
                  return (
                    <div key={tx.tx_hash} className="relative">
                      <SettingsRow
                        title={
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <StatusChip
                              tone={confirmed ? 'success' : 'warning'}
                            >
                              {fused
                                ? `Fused · ${confirmed ? t('home.confirmed') : t('home.pending')}`
                                : confirmed
                                  ? t('home.confirmed')
                                  : t('home.pending')}
                            </StatusChip>
                          </span>
                        }
                        description={
                          <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
                            <span>
                              {tx.height > 0
                                ? `${t('home.block')} ${tx.height}`
                                : t('home.pendingConfirmation')}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{t('history.transactionId')}:</span>
                            <MaskedValue
                              value={tx.tx_hash}
                              label={t('history.transactionId')}
                              ariaLabel={t('history.copyTransaction')}
                              copySuccessMessageKey="history.transactionCopied"
                              embedded
                              className="max-w-[180px] truncate font-mono"
                            />
                          </span>
                        }
                        right={<span className="pr-10">›</span>}
                        compact
                        onClick={() =>
                          navigate(`/transactions/${currentWalletId}`, {
                            state: {
                              openTransaction: {
                                txid: tx.tx_hash,
                                height: tx.height,
                              },
                            },
                          })
                        }
                      />
                      <div className="absolute right-1 top-1/2 z-10 -translate-y-1/2">
                        <InfoButton
                          id={`home-history-status-${tx.tx_hash}`}
                          ariaLabel={t('history.statusHelpLabel')}
                          content={t('history.statusHelp')}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <EmptyState message={t('home.noRecentActivity')} />
              )}
            </div>
          </SectionCard>

          <SectionCard className="shrink-0 p-2.5">
            <PriceFeed compact />
          </SectionCard>
        </div>
      </div>
      {!viewerOnly && homeConnect.popupOpen ? (
        <HomeConnectPopup
          uri={homeConnect.uri}
          onChange={homeConnect.setUri}
          onScan={() => void homeConnect.scanQr()}
          onConnect={() => void homeConnect.connectUri(homeConnect.uri)}
          onClose={homeConnect.closePopup}
          scanning={homeConnect.scanning}
          submitting={homeConnect.submitting}
          streamScanning={homeConnect.streamScanning}
          onStreamScan={homeConnect.scanStreamQr}
          onStreamComplete={homeConnect.completeStreamScan}
        />
      ) : null}
    </WalletScreen>
  );
};

export default Home;
