// Desktop Home — swapped in for src/features/home/Home.tsx (vite.desktop.config.ts).
//
// FAITHFUL COPY of upstream Home.tsx. The ONLY behavioural change is the balance
// unit label: it reads `unit` (BCH on mainnet, tBCH on chipnet/testnet) via the
// shared `unitFor` instead of a hardcoded "BCH", so test coins aren't mislabelled
// as mainnet value. When upstream Home.tsx changes, re-copy this file and reapply
// the three marked spots (import, `const unit`, the two `${unit}` strings).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { FaArrowDown, FaArrowUp, FaBitcoin, FaQrcode } from 'react-icons/fa';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
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
import { SATSINBITCOIN } from '../../utils/constants';
import SettingsRow from '../../components/ui/SettingsRow';
import EmptyState from '../../components/ui/EmptyState';
import { shortenTxHash } from '../../utils/shortenHash';
import { takeRecentTransactions } from '../../utils/transactionHistoryOrder';
import { isFusionTransaction } from './fusionCoinDepth';
import { useFusionDepthRevision } from './useFusionDepthRevision';
import { FusionBadge } from '../../components/FusionBadge';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { classifyScannedQrPayload } from '../../utils/qrScan';
import { unitFor } from './unitLabel'; // ← desktop-only: per-network unit label

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
  const dispatch = useDispatch<AppDispatch>();
  const dbService = useMemo(() => DatabaseService(), []);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const fusionDepthRev = useFusionDepthRevision(Number(currentWalletId) || 0);
  const sessionGeneration = useSelector(
    (state: RootState) => state.wallet_id.sessionGeneration ?? 0
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
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
  const transactions = useSelector(
    (state: RootState) => state.transactions.transactions[currentWalletId]
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const unit = unitFor(currentNetwork); // ← desktop-only: BCH / tBCH
  const bchUsdQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']?.price
  );
  const [displayMode, setDisplayMode] = useState<'BCH' | 'USD'>('BCH');
  const [scanBusy, setScanBusy] = useState(false);
  const [syncElapsedSec, setSyncElapsedSec] = useState(0);

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
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
  // Sort by block height / unconfirmed — NOT array index. Redux history is
  // merge order from Electrum, so slice(-N).reverse() put old txs on top and
  // new fused CoinJoins lower. Same rule as full History (newest first).
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

  // Feed per-address history progress into the shared store field so the Home
  // progress bar (rendered under the Sync button) moves for the whole sync —
  // both the worker bootstrap phases and this history pass.
  const reportSyncProgress = useCallback(
    (percent: number) => dispatch(setSyncingProgress(percent)),
    [dispatch]
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
    reportSyncProgress(2);

    try {
      // Same network path as open-bootstrap for balances: scripthash batches,
      // no second BIP44 rediscovery (open already expanded the key set).
      //
      // Do NOT use runWalletUtxoRefresh here. That coordinator joins any
      // in-flight background reconcile (subscriptions / block tip), which has
      // no onProgress and often still runs discovery — so the UI froze at 8%
      // for a minute while we waited on someone else's task. Manual Sync is
      // user-initiated: run our own fast path only.
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
          discover: false,
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
          subtitle={currentNetwork === Network.CHIPNET ? 'Chipnet' : undefined}
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
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={handleRefresh}
                    className="wallet-btn-secondary px-3 py-1.5 text-sm"
                    disabled={fetchingUTXOsRedux}
                  >
                    {fetchingUTXOsRedux ? 'Syncing…' : 'Sync'}
                  </button>
                  {(fetchingUTXOsRedux && syncingProgress !== null) && (
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
                      ? `${totalBch.toFixed(8)} ${unit}`
                      : totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : 'USD unavailable'}
                  </div>
                  <div className="text-xs wallet-muted">
                    {displayMode === 'BCH'
                      ? totalUsd !== null
                        ? `$${totalUsd.toFixed(2)} USD`
                        : 'USD price unavailable'
                      : `${totalBch.toFixed(8)} ${unit}`}
                  </div>
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDisplayMode((mode) => (mode === 'BCH' ? 'USD' : 'BCH'))
                }
                className="flex h-14 w-14 items-center justify-center rounded-3xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)] transition hover:brightness-[1.04]"
                aria-label={`Toggle ${unit} and USD balance`}
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
              <QuickActionButton
                title="Send"
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
                          : fused
                            ? 'Broadcast — waiting for block'
                            : 'Unconfirmed'
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
                              : 'Fused · Unconfirmed'
                            : tx.height > 0
                              ? 'Confirmed'
                              : 'Unconfirmed'}
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
