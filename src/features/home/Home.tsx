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
import { Network } from '../../state/slices/networkSlice';
import { SATSINBITCOIN } from '../../utils/constants';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import { shortenTxHash } from '../../utils/shortenHash';
import { takeRecentTransactions } from '../../utils/transactionHistoryOrder';
import { isFusionTransaction } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import { FusionBadge } from '../../components/FusionBadge';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { classifyScannedQrPayload } from '../../utils/qrScan';

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
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const fusionDepthRev = useFusionDepthRevision(Number(currentWalletId) || 0);
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
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [scanBusy, setScanBusy] = useState(false);
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  // Sort by height / unconfirmed — not array index (Electrum merge order).
  const recentTransactions = useMemo(
    () => takeRecentTransactions(transactions, 8),
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
        await Toast.show({ text: 'No QR code detected. Try again.' });
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
        text: 'QR scanned, but it was not a supported wallet payload.',
      });
    } catch (error) {
      await Toast.show({ text: getBarcodeScannerErrorMessage(error) });
      logError('Home.handleScanQr', error, { walletId: currentWalletId });
    } finally {
      setScanBusy(false);
    }
  }, [currentNetwork, currentWalletId, navigate, scanBusy]);

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          title="Home"
          subtitle={
            viewerOnly
              ? currentNetwork === Network.CHIPNET
                ? 'Chipnet - Browser viewer'
                : 'Browser viewer'
              : currentNetwork === Network.CHIPNET
                ? 'Chipnet'
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
              title="Portfolio"
              subtitle="Wallet overview"
              compact
              action={
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="wallet-btn-secondary px-3 py-1.5 text-sm"
                  disabled={fetchingUTXOsRedux}
                >
                  {fetchingUTXOsRedux ? 'Syncing…' : 'Sync'}
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
                        : 'USD unavailable'}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : 'USD price unavailable'
                      : `${totalBch.toFixed(8)} BCH`}
                  </div>
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))
                }
                className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                aria-label="Toggle BCH and USD balance"
              >
                <FaBitcoin className="text-2xl" />
              </button>
            </div>
          </SectionCard>

          <SectionCard className="shrink-0 p-3">
            <SectionHeader
              title="Quick Actions"
              compact
              className="items-center"
              action={
                viewerOnly ? undefined : (
                  <button
                    type="button"
                    onClick={() => void handleScanQr()}
                    disabled={scanBusy}
                    className="wallet-card inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_42%,transparent)] px-3 text-[var(--wallet-accent-strong)] transition hover:brightness-[1.03] disabled:cursor-not-allowed disabled:opacity-70 self-center"
                    aria-label="Scan QR"
                    title="Scan QR"
                  >
                    <span className="text-sm font-semibold wallet-text-strong">
                      Scan QR
                    </span>
                    <FaQrcode
                      className={`text-base ${scanBusy ? 'animate-pulse' : ''}`}
                    />
                  </button>
                )
              }
            />
            <div className="flex items-stretch gap-2.5">
              <QuickActionButton
                title="Receive"
                icon={<FaArrowDown />}
                onClick={() =>
                  navigate('/receive', {
                    state: { returnTo: `/home/${currentWalletId ?? ''}` },
                  })
                }
              />
              {!viewerOnly && (
                <QuickActionButton
                  title="Send"
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
              title="Recent Activity"
              subtitle="Latest wallet activity"
              compact
              action={
                <button
                  className="wallet-link text-sm"
                  onClick={() => navigate(`/transactions/${currentWalletId}`)}
                >
                  View all
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
                          ? `Block ${tx.height}`
                          : 'Pending confirmation'
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
                              ? 'Fused · Confirmed'
                              : 'Fused · Pending'
                            : tx.height > 0
                              ? 'Confirmed'
                              : 'Pending'}
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
                <EmptyState message="No recent activity yet." />
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </WalletScreen>
  );
};

export default Home;
