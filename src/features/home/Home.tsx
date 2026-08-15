import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaBitcoin, FaQrcode } from 'react-icons/fa';
import { AppDispatch, RootState } from '../../state/store';
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
import { runWalletUtxoRefresh } from '../../services/RefreshCoordinator';
import {
  captureActiveWalletSession,
  fetchActiveWalletUtxos,
  isActiveWalletSession,
} from '../../services/WalletUtxoRefreshService';
import { refreshUTXOWorkerSubscriptions } from '../../workers/UTXOWorkerService';
import { logError } from '../../utils/errorHandling';
import { Network } from '../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { SATSINBITCOIN } from '../../utils/constants';
import { selectRpaStealthSats } from '../../state/slices/walletSpecialActivitySlice';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import { shortenTxHash } from '../../utils/shortenHash';
import { takeRecentTransactions } from '../../utils/transactionHistoryOrder';
import { isFusionTransaction } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import { FusionBadge } from '../../components/FusionBadge';
import HomeConnectPopup from '../../components/home/HomeConnectPopup';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import { useHomeConnect } from './useHomeConnect';
import { useI18n } from '../../i18n/useI18n';

type QuickActionButtonProps = {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
};

function getQuickActionTextClass(title: string) {
  return `min-w-0 truncate leading-none tracking-normal text-[clamp(0.98rem,3.1vw,1.08rem)] font-semibold wallet-text-strong ${
    title.length > 5 ? 'tracking-[-0.01em]' : ''
  }`;
}

function QuickActionButton({ title, icon, onClick }: QuickActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="wallet-card flex min-h-[4.9rem] min-w-0 flex-[1_1_0%] items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition hover:brightness-[0.98]"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)]">
        {icon}
      </div>
      <span className={getQuickActionTextClass(title)}>{title}</span>
    </button>
  );
}

type HomeProps = {
  viewerOnly?: boolean;
};

const Home: React.FC<HomeProps> = ({ viewerOnly = false }) => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const fusionDepthRev = useFusionDepthRevision(Number(currentWalletId) || 0);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
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
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const homeConnect = useHomeConnect();
  const totalBch = (totalBalance + stealthSats) / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  // Sort by height / unconfirmed — not array index (Electrum merge order).
  const recentTransactions = useMemo(
    () => takeRecentTransactions(transactions, 3),
    [transactions]
  );
  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;
    const walletSession = captureActiveWalletSession(currentWalletId);
    if (!walletSession) return;

    dispatch(setFetchingUTXOs(true));

    try {
      await runWalletUtxoRefresh(currentWalletId, async () => {
        await ElectrumService.ensureFreshConnection();
        if (!isActiveWalletSession(walletSession)) return;
        const walletUtxos = await fetchActiveWalletUtxos(walletSession);
        if (!walletUtxos) return;
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
      });
    } catch (error) {
      logError('Home.handleRefresh', error, { walletId: currentWalletId });
    } finally {
      // Always clear Syncing for this click — even if the session ended mid-flight.
      dispatch(setFetchingUTXOs(false));
    }
  }, [currentWalletId, dbService, dispatch, fetchingUTXOsRedux]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('home.title')}
          subtitle={
            viewerOnly
              ? currentNetwork === Network.CHIPNET
                ? `${t('assets.chipnet')} - Browser viewer`
                : 'Browser viewer'
              : currentNetwork === Network.CHIPNET
                ? t('assets.chipnet')
                : undefined
          }
          compact
        />

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          <SectionCard className="shrink-0 p-2.5">
            <PriceFeed compact />
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title={t('home.portfolio')}
              subtitle={t('home.walletOverview')}
              compact
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                  disabled={fetchingUTXOsRedux}
                >
                  {fetchingUTXOsRedux ? t('home.syncing') : t('home.sync')}
                </button>
              }
            />
            <div className="flex items-center justify-between gap-3">
              <div>
                <button
                  type="button"
                  onClick={() =>
                    setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))
                  }
                  className="text-left"
                >
                  <div className="text-2xl font-bold wallet-text-strong">
                    {displayMode === 'BCH'
                      ? `${totalBch.toFixed(8)} BCH`
                      : totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : t('home.usdUnavailable')}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : t('home.usdPriceUnavailable')
                      : `${totalBch.toFixed(8)} BCH`}
                  </div>
                  {stealthSats > 0 && (
                    <div className="text-[10px] wallet-muted mt-0.5">
                      {(totalBalance / SATSINBITCOIN).toFixed(8)} spendable
                      {' + '}
                      {(stealthSats / SATSINBITCOIN).toFixed(8)} stealth
                    </div>
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))
                }
                className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                aria-label={t('home.toggleBalance')}
              >
                <FaBitcoin className="text-2xl" />
              </button>
            </div>
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
                    className="wallet-card inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_42%,transparent)] px-3 text-[var(--wallet-accent-strong)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70 self-center"
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
                icon={<FaArrowDown />}
                onClick={() =>
                  navigate('/receive', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
              {!viewerOnly && (
                <QuickActionButton
                  title={t('home.send')}
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
              title={t('home.recentActivity')}
              subtitle={t('home.latestActivity')}
              compact
              action={
                <button
                  className="wallet-link text-sm"
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
                  return (
                    <SettingsRow
                      key={tx.tx_hash}
                      title={
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="font-mono truncate">
                            {shortenTxHash(tx.tx_hash)}
                          </span>
                          {fused ? <FusionBadge asTx /> : null}
                        </span>
                      }
                      description={
                        tx.height > 0
                          ? `${t('home.block')} ${tx.height}`
                          : t('home.pendingConfirmation')
                      }
                      right={
                        <span
                          className={
                            fused
                              ? 'text-xs font-semibold text-emerald-400 whitespace-nowrap'
                              : 'wallet-muted text-xs whitespace-nowrap'
                          }
                        >
                          {fused
                            ? tx.height > 0
                              ? `Fused · ${t('home.confirmed')}`
                              : `Fused · ${t('home.pending')}`
                            : tx.height > 0
                              ? t('home.confirmed')
                              : t('home.pending')}
                        </span>
                      }
                      compact
                      onClick={() =>
                        navigate(`/transactions/${currentWalletId}`)
                      }
                    />
                  );
                })
              ) : (
                <EmptyState message={t('home.noRecentActivity')} />
              )}
            </div>
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
        />
      ) : null}
    </WalletScreen>
  );
};

export default Home;
