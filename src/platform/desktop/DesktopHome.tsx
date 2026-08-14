// Desktop Home — swapped in for src/features/home/Home.tsx (vite.desktop.config.ts).
//
// Desktop-specific copy of upstream Home.tsx. It keeps the desktop-only balance
// unit behavior while sharing the same translation keys as the mobile screen.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaBitcoin, FaQrcode } from 'react-icons/fa';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
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
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';
import { Network } from '../../state/slices/networkSlice';
import { SATSINBITCOIN } from '../../utils/constants';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import { shortenTxHash } from '../../utils/shortenHash';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { classifyScannedQrPayload } from '../../utils/qrScan';
import { unitFor } from './unitLabel';
import { useI18n } from '../../i18n/useI18n';
import { formatNumber } from '../../i18n/format';

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

const Home: React.FC = () => {
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const sessionGeneration = useSelector(
    (state: RootState) => state.wallet_id.sessionGeneration ?? 0
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
  );
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );
  const transactions = useSelector(
    (state: RootState) => state.transactions.transactions[currentWalletId]
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const unit = unitFor(currentNetwork);
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [scanBusy, setScanBusy] = useState(false);
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  const formattedBch = formatNumber(totalBch, locale, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  });
  const formattedUsd =
    totalUsd !== null
      ? formatNumber(totalUsd, locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : null;
  const recentTransactions = useMemo(
    () => (transactions ?? []).slice(-2).reverse(),
    [transactions]
  );
  const tokenCategories = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(reduxUTXOs)
            .flat()
            .map((utxo) => utxo.token?.category)
            .filter((category): category is string => Boolean(category))
        )
      ),
    [reduxUTXOs]
  );

  useEffect(() => {
    if (!currentWalletId || tokenCategories.length === 0) return;
    void preloadTokenMetadata(tokenCategories);
  }, [currentWalletId, tokenCategories]);

  // Load this wallet's transaction history when it opens.
  //
  // Recent Activity renders `state.transactions`, which only the history fetch
  // populates — and that fetch lived in a hook mounted by the transactions PAGE.
  // This screen mounts no such hook, so the list stayed empty until the user
  // opened that page, which is why "click View all" appeared to sync it. The
  // service publishes the rows already stored in SQLite before going to the
  // network, so the list fills immediately and then updates.
  useEffect(() => {
    if (!currentWalletId) return;
    void refreshWalletTransactionHistory({
      walletId: currentWalletId,
      dispatch,
      sessionGeneration,
    }).catch((error) => {
      logError('DesktopHome.loadHistory', error, { walletId: currentWalletId });
    });
  }, [currentWalletId, dispatch, sessionGeneration]);

  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;
    const walletSession = captureActiveWalletSession(currentWalletId);
    if (!walletSession) return;

    dispatch(setFetchingUTXOs(true));

    try {
      await runWalletUtxoRefresh(currentWalletId, async () => {
        await ElectrumService.reconnect();
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
      // Sync means the whole wallet, not just its coins. Refreshing UTXOs alone
      // moved the balance while Recent Activity stayed as it was.
      await refreshWalletTransactionHistory({
        walletId: currentWalletId,
        dispatch,
        sessionGeneration,
      });
    } catch (error) {
      logError('Home.handleRefresh', error, { walletId: currentWalletId });
    } finally {
      if (isActiveWalletSession(walletSession)) {
        dispatch(setFetchingUTXOs(false));
      }
    }
  }, [
    currentWalletId,
    dbService,
    dispatch,
    fetchingUTXOsRedux,
    sessionGeneration,
  ]);

  const handleScanQr = useCallback(async () => {
    if (scanBusy) return;

    try {
      setScanBusy(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      const scanned = result?.ScanResult?.trim();
      if (!scanned) {
        await Toast.show({ text: t('home.noQrCode') });
        return;
      }

      const parsed = classifyScannedQrPayload(scanned, currentNetwork);
      const returnTo = `/home/${currentWalletId ?? ''}`;

      if (parsed.kind === 'paper-wallet') {
        navigate('/paper-wallet-sweep', {
          state: {
            returnTo,
            scannedWif: parsed.paperWalletWif,
          },
        });
        return;
      }

      if (parsed.kind === 'recipient') {
        navigate('/send', {
          state: {
            returnTo,
            recipient: parsed.normalizedAddress,
            amountBch: parsed.amountRaw ?? '',
          },
        });
        return;
      }

      await Toast.show({
        text: t('home.unsupportedQr'),
      });
    } catch (error) {
      await Toast.show({ text: getBarcodeScannerErrorMessage(error) });
      logError('Home.handleScanQr', error, { walletId: currentWalletId });
    } finally {
      setScanBusy(false);
    }
  }, [currentNetwork, currentWalletId, navigate, scanBusy, t]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title={t('home.title')}
          subtitle={
            currentNetwork === Network.CHIPNET ? t('assets.chipnet') : undefined
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
                      ? `${formattedBch} ${unit}`
                      : formattedUsd !== null
                        ? `$${formattedUsd} USD`
                        : t('home.usdUnavailable')}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${formattedUsd} USD`
                        : t('home.usdPriceUnavailable')
                      : `${formattedBch} ${unit}`}
                  </div>
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
                <button
                  type="button"
                  onClick={() => void handleScanQr()}
                  disabled={scanBusy}
                  className="wallet-card inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_42%,transparent)] px-3 text-[var(--wallet-accent-strong)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70 self-center"
                  aria-label={t('home.scanQr')}
                  title={t('home.scanQr')}
                >
                  <span className="text-sm font-semibold wallet-text-strong">
                    {t('home.scanQr')}
                  </span>
                  <FaQrcode
                    className={`text-base ${scanBusy ? 'animate-pulse' : ''}`}
                  />
                </button>
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
                recentTransactions.map((tx) => (
                  <SettingsRow
                    key={tx.tx_hash}
                    title={shortenTxHash(tx.tx_hash)}
                    description={
                      tx.height > 0
                        ? `${t('home.block')} ${tx.height}`
                        : t('home.pendingConfirmation')
                    }
                    right={
                      <span className="wallet-muted">
                        {tx.height > 0
                          ? t('home.confirmed')
                          : t('home.pending')}
                      </span>
                    }
                    compact
                    onClick={() => navigate(`/transactions/${currentWalletId}`)}
                  />
                ))
              ) : (
                <EmptyState message={t('home.noRecentActivity')} />
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </WalletScreen>
  );
};

export default Home;
