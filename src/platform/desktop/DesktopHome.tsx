// Desktop Home — swapped in for src/features/home/Home.tsx (vite.desktop.config.ts).
//
// This renderer intentionally mirrors Home's information hierarchy and shared
// safety/comprehension behaviors. Desktop-only sync progress and the shared
// Home connect popup remain local to this renderer, so changes to Home.tsx must
// be reconciled here as well.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaQrcode } from 'react-icons/fa';
import { AppDispatch, RootState } from '../../state/store';
import {
  setFetchingUTXOs,
  setSyncingProgress,
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
import {
  captureActiveWalletSession,
  fetchActiveWalletUtxos,
  isActiveWalletSession,
} from '../../services/WalletUtxoRefreshService';
import { logError } from '../../utils/errorHandling';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';
import { Network } from '../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { SATSINBITCOIN } from '../../utils/constants';
import { selectRpaStealthSats } from '../../state/slices/walletSpecialActivitySlice';
import type { TransactionHistoryItem } from '../../types/types';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import {
  isMempoolLike,
  takeRecentTransactions,
} from '../../utils/transactionHistoryOrder';
import { isTxConfirmed } from '../../utils/txConfirmation';
import { isFusionTransaction } from './fusionCoinDepth';
import { useFusionDepthRevision } from './useFusionDepthRevision';
import HomeConnectPopup from '../../components/home/HomeConnectPopup';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import { useHomeConnect } from '../../features/home/useHomeConnect';
import { unitFor } from '../../utils/unitLabel';
import { useI18n } from '../../i18n/useI18n';
import BchUsdControl from '../../components/ui/BchUsdControl';
import NetworkContextBanner from '../../components/ui/NetworkContextBanner';
import MaskedValue from '../../components/ui/MaskedValue';
import { formatNumber } from '../../i18n/format';
import InfoButton from '../../components/ui/InfoButton';
import StatusChip from '../../components/ui/StatusChip';

type QuickActionButtonProps = {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  attention?: boolean;
};

function getQuickActionTextClass(title: string) {
  return `min-w-0 truncate leading-none tracking-normal text-[clamp(0.98rem,3.1vw,1.08rem)] font-semibold wallet-text-strong ${
    title.length > 5 ? 'tracking-[-0.01em]' : ''
  }`;
}

const EMPTY_TRANSACTIONS: TransactionHistoryItem[] = [];

function QuickActionButton({
  title,
  icon,
  onClick,
  attention = false,
}: QuickActionButtonProps) {
  return (
    <button
      type="button"
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

const Home: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const fusionDepthRev = useFusionDepthRevision(Number(currentWalletId) || 0);
  const sessionGeneration = useSelector(
    (state: RootState) => state.wallet_id.sessionGeneration ?? 0
  );
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
  );
  const walletSyncStatus = useSelector(
    (state: RootState) => state.utxos.walletSyncStatus
  );
  const syncingProgress = useSelector(
    (state: RootState) => state.utxos.syncingProgress
  );
  const syncingStartedAtMs = useSelector(
    (state: RootState) => state.utxos.syncingStartedAtMs
  );
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );
  const stealthSats = useSelector((state: RootState) =>
    selectRpaStealthSats(state, currentWalletId)
  );
  const transactions = useSelector((state: RootState) => {
    const byWallet = state.transactions.transactions;
    return (
      byWallet[currentWalletId] ??
      byWallet[String(currentWalletId)] ??
      EMPTY_TRANSACTIONS
    );
  });
  const currentNetwork = useSelector(selectCurrentNetwork);
  const unit = unitFor(currentNetwork);
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const homeConnect = useHomeConnect();
  const { t, locale } = useI18n();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [syncElapsedSec, setSyncElapsedSec] = useState(0);
  const [incomingFlag, setIncomingFlag] = useState<{
    key: string;
    title: string;
    amountSats?: number;
    address: string | null;
    txid: string;
  } | null>(null);

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

  // Wall-clock only. Multi-phase sync (markers → Electrum batch → history)
  // freezes the % bar for long stretches; any "%/s → seconds left" estimate
  // will lie (e.g. 49% · 61s · ~1s left). Show percent + elapsed and stop there.
  //
  // Start time lives in Redux (syncingStartedAtMs), not local Date.now() on
  // effect mount — leaving Home mid-sync unmounted the counter and remount
  // restarted it at 0s while the same scan was still running.
  useEffect(() => {
    if (!fetchingUTXOsRedux || syncingStartedAtMs == null) {
      setSyncElapsedSec(0);
      return;
    }
    const tick = () => {
      setSyncElapsedSec(
        Math.max(0, Math.floor((Date.now() - syncingStartedAtMs) / 1000))
      );
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [fetchingUTXOsRedux, syncingStartedAtMs]);
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
  // Sort by block height / unconfirmed — NOT array index. Redux history is
  // merge order from Electrum, so slice(-N).reverse() put old txs on top and
  // new fused CoinJoins lower. Same rule as full History (newest first).
  const recentTransactions = useMemo(
    () => takeRecentTransactions(transactions, 3),
    [transactions]
  );
  // Feed per-address history progress into the shared store field so the Home
  // progress bar (rendered under the Sync button) moves for the whole sync —
  // both the worker bootstrap phases and this history pass.
  const reportSyncProgress = useCallback(
    (percent: number) => dispatch(setSyncingProgress(percent)),
    [dispatch]
  );

  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;
    const walletSession = captureActiveWalletSession(currentWalletId);
    if (!walletSession) return;

    setRefreshFailed(false);
    dispatch(setFetchingUTXOs(true));
    reportSyncProgress(2);

    try {
      // Same network path as open-bootstrap for balances: scripthash batches
      // plus the shared regular/CashFusion/Cauldron branch discovery.
      //
      // Do NOT use runWalletUtxoRefresh here. That coordinator joins any
      // in-flight background reconcile (subscriptions / block tip), which has
      // no onProgress and can hide the branch scan behind someone else's task.
      // Manual Sync is user-initiated: run our own fast path so discovery and
      // its progress remain visible on desktop just as they are on mobile.
      //
      // Manual Sync = force recheck (clear status hashes) but does NOT wipe
      // the ledger. Rebuild Wallet in Settings is the nuclear wipe.
      reportSyncProgress(5);
      try {
        const ledger = await import('./WalletLedgerService');
        // Manual Sync: clear status hashes then force listunspent all (HOT).
        await ledger.clearAddressStatuses(currentWalletId);
      } catch {
        /* optional — status table may not exist */
      }
      // Best-effort socket; do not block forever on resubscribe.
      try {
        await Promise.race([
          ElectrumService.ensureFreshConnection(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch {
        /* listunspent reconnects */
      }
      if (!isActiveWalletSession(walletSession)) return;
      reportSyncProgress(10);

      if (!isActiveWalletSession(walletSession)) return;
      const walletUtxos = await fetchActiveWalletUtxos(
        walletSession,
        undefined,
        {
          discover: true,
          trackWalletSync: true,
          // Statuses were cleared above; force still short-circuits any race
          // where a concurrent path rewrote a status before listunspent.
          force: true,
          onProgress: (done, total) => {
            if (total <= 0) {
              reportSyncProgress(12);
              return;
            }
            // 12–55% = UTXO batches (include 0/N so the bar moves before the
            // first Electrum chunk returns).
            reportSyncProgress(12 + Math.round(43 * (done / total)));
          },
        }
      );
      if (walletUtxos) {
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
      }
      reportSyncProgress(55);

      // Sync means the whole wallet, not just its coins. Refreshing UTXOs alone
      // moved the balance while Recent Activity stayed as it was.
      await refreshWalletTransactionHistory({
        walletId: currentWalletId,
        dispatch,
        sessionGeneration,
        // Do not join a background history pass (no onProgress → bar stuck at
        // 55%). Force re-fetches every address after statuses were cleared.
        force: true,
        onProgress: (pct) => {
          // 55–100% = history pass
          reportSyncProgress(55 + Math.round(0.45 * pct));
        },
      });
    } catch (error) {
      setRefreshFailed(true);
      logError('Home.handleRefresh', error, { walletId: currentWalletId });
    } finally {
      // Always clear Syncing for this click — even if the wallet session was
      // cancelled mid-flight (HMR / lock). Leaving the flag true freezes the button.
      dispatch(setFetchingUTXOs(false));
      dispatch(setSyncingProgress(null));
    }
  }, [
    currentWalletId,
    dbService,
    dispatch,
    fetchingUTXOsRedux,
    reportSyncProgress,
    sessionGeneration,
  ]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('home.title')}
          subtitle={
            currentNetwork === Network.CHIPNET
              ? t('network.chipnet')
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
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={handleRefresh}
                    className="wallet-btn-secondary min-h-[44px] px-3 py-1.5 text-sm"
                    disabled={fetchingUTXOsRedux}
                  >
                    {fetchingUTXOsRedux ? t('home.syncing') : t('home.sync')}
                  </button>
                  {fetchingUTXOsRedux && syncingProgress !== null && (
                    <div className="flex items-center gap-1.5 text-xs wallet-muted">
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--wallet-accent-soft)_45%,transparent)]">
                        <div
                          className="h-full rounded-full bg-[var(--wallet-accent-strong)] transition-[width] duration-300"
                          style={{ width: `${syncingProgress}%` }}
                        />
                      </div>
                      <span className="whitespace-nowrap">
                        {syncingProgress}%
                        {syncElapsedSec > 0 ? ` · ${syncElapsedSec}s` : ''}
                        {syncingProgress >= 100 ? ' · done' : ' · working…'}
                      </span>
                    </div>
                  )}
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
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs wallet-muted">
                    {incomingFlag.amountSats !== undefined ? (
                      <span className="wallet-text-strong">
                        {t('send.amount')}:{' '}
                        {formatNumber(incomingFlag.amountSats, locale)} sats
                      </span>
                    ) : null}
                    {incomingFlag.address ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <span>{t('receive.receiveAddress')}:</span>
                        <MaskedValue
                          value={incomingFlag.address}
                          label={t('receive.receiveAddress')}
                          copySuccessMessageKey="receive.addressCopied"
                          embedded
                          className="text-xs"
                        />
                      </span>
                    ) : (
                      <span>{t('notifications.unknownAddress')}</span>
                    )}
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <span>{t('history.transactionId')}:</span>
                      <MaskedValue
                        value={incomingFlag.txid}
                        label={t('history.transactionId')}
                        copySuccessMessageKey="history.transactionCopied"
                        embedded
                        className="text-xs"
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
              <div>
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
                  id="desktop-home-sync-status-help"
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
              }
            />
            <div className="flex items-stretch gap-2.5">
              <QuickActionButton
                title={t('home.receive')}
                icon={<FaArrowDown />}
                attention={Boolean(incomingFlag)}
                onClick={() =>
                  navigate('/receive', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
              <QuickActionButton
                title={t('home.send')}
                icon={<FaArrowUp />}
                onClick={() =>
                  navigate('/send', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
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
                                : isMempoolLike(tx)
                                  ? t('home.pendingConfirmation')
                                  : t('home.confirmed')}
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
                          navigate(`/transactions/${currentWalletId}`)
                        }
                      />
                      <div className="absolute right-1 top-1/2 z-10 -translate-y-1/2">
                        <InfoButton
                          id={`desktop-home-history-status-${tx.tx_hash}`}
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
      {homeConnect.popupOpen ? (
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
