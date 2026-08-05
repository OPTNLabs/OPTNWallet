// Desktop Home — swapped in for src/features/home/Home.tsx (vite.desktop.config.ts).
//
// FAITHFUL COPY of upstream Home.tsx. The ONLY behavioural change is the balance
// unit label: it reads `unit` (BCH on mainnet, tBCH on chipnet/testnet) via the
// shared `unitFor` instead of a hardcoded "BCH", so test coins aren't mislabelled
// as mainnet value. When upstream Home.tsx changes, re-copy this file and reapply
// the three marked spots (import, `const unit`, the two `${unit}` strings).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { isFusionTransaction } from './fusionCoinDepth';
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
  const [syncEtaSec, setSyncEtaSec] = useState<number | null>(null);
  const [syncElapsedSec, setSyncElapsedSec] = useState(0);
  // null = unknown / frozen; number = seconds; 0 = done
  const [syncEtaHonest, setSyncEtaHonest] = useState<boolean>(true);

  // Wall-clock ticker while a sync is in flight. The long UTXO/header network
  // batch is one atomic round-trip that cannot sub-divide its progress, so the
  // % bar alone would sit frozen for seconds during it. A live elapsed counter
  // is the honest indicator that the scan is actually progressing.
  const syncStartTsRef = useRef<number | null>(null);
  useEffect(() => {
    if (!fetchingUTXOsRedux) {
      setSyncElapsedSec(0);
      syncStartTsRef.current = null;
      return;
    }
    const startTs = Date.now();
    syncStartTsRef.current = startTs;
    const interval = setInterval(() => {
      setSyncElapsedSec(Math.floor((Date.now() - startTs) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [fetchingUTXOsRedux]);

  // ETA must not lie. Phase markers jump 5→8→10→20% in milliseconds, which made
  // a rate-based ETA claim "~2s left" while discovery/Electrum sat at 20% for a
  // minute. Rules:
  //  1) Ignore flash phase jumps (big % in tiny dt) for the rate sample.
  //  2) Floor remaining time with overall pace: elapsed * (100-p)/p.
  //  3) If % has not moved for several seconds, drop the optimistic "~Ns left"
  //     and show "working…" instead of a fake countdown.
  const rateRef = useRef<number | null>(null);
  const lastProgressRef = useRef<number | null>(null);
  const lastProgressChangeTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!fetchingUTXOsRedux || syncingProgress === null) {
      if (!fetchingUTXOsRedux) {
        rateRef.current = null;
        lastProgressRef.current = null;
        lastProgressChangeTsRef.current = null;
        setSyncEtaSec(null);
        setSyncEtaHonest(true);
      }
      return;
    }

    const now = Date.now();
    const lastP = lastProgressRef.current;
    const lastChangeTs = lastProgressChangeTsRef.current;
    const elapsedSec = Math.max(
      0,
      syncStartTsRef.current
        ? (now - syncStartTsRef.current) / 1000
        : syncElapsedSec
    );

    if (syncingProgress >= 100) {
      setSyncEtaSec(0);
      setSyncEtaHonest(true);
      lastProgressRef.current = syncingProgress;
      lastProgressChangeTsRef.current = now;
      return;
    }

    if (lastP !== null && syncingProgress < lastP) {
      // History pass (or other phase) restarted the bar — forget rate.
      rateRef.current = null;
      lastProgressRef.current = syncingProgress;
      lastProgressChangeTsRef.current = now;
      setSyncEtaSec(null);
      setSyncEtaHonest(true);
      return;
    }

    const progressed =
      lastP === null || syncingProgress > lastP + 0.01;

    if (progressed) {
      if (
        lastP !== null &&
        lastChangeTs !== null &&
        syncingProgress > lastP
      ) {
        const dtSec = (now - lastChangeTs) / 1000;
        const delta = syncingProgress - lastP;
        // Phase markers (5→20 in <0.75s) are not real work rate.
        const isFlashJump = dtSec < 0.75 || delta / Math.max(dtSec, 0.001) > 25;
        if (!isFlashJump && dtSec >= 0.5) {
          const instRate = delta / dtSec; // %/s
          const clamped = Math.min(15, Math.max(0.05, instRate));
          rateRef.current =
            rateRef.current === null
              ? clamped
              : rateRef.current * 0.6 + clamped * 0.4;
        }
      }
      lastProgressRef.current = syncingProgress;
      lastProgressChangeTsRef.current = now;
    }

    const stuckForSec =
      lastProgressChangeTsRef.current !== null
        ? (now - lastProgressChangeTsRef.current) / 1000
        : 0;

    // Overall pace floor: if 20% took 76s, remaining is not 2s.
    let overallEta: number | null = null;
    if (elapsedSec >= 3 && syncingProgress >= 1 && syncingProgress < 100) {
      overallEta = Math.ceil(
        (elapsedSec * (100 - syncingProgress)) / syncingProgress
      );
    }

    let rateEta: number | null = null;
    if (rateRef.current !== null && rateRef.current > 0) {
      rateEta = Math.ceil((100 - syncingProgress) / rateRef.current);
    }

    // Frozen bar → do not advertise a short countdown.
    if (stuckForSec >= 4) {
      setSyncEtaHonest(false);
      setSyncEtaSec(overallEta);
      return;
    }

    setSyncEtaHonest(true);
    if (overallEta !== null && rateEta !== null) {
      // Conservative: never promise faster than overall pace.
      setSyncEtaSec(Math.max(overallEta, rateEta));
    } else {
      setSyncEtaSec(overallEta ?? rateEta);
    }
  }, [fetchingUTXOsRedux, syncingProgress, syncElapsedSec]);
  const totalBch = totalBalance / SATSINBITCOIN;
  const totalUsd =
    typeof bchUsdQuote === 'number' ? totalBch * bchUsdQuote : null;
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
      // Sync means the whole wallet, not just its coins. Refreshing UTXOs alone
      // moved the balance while Recent Activity stayed as it was.
      await refreshWalletTransactionHistory({
        walletId: currentWalletId,
        dispatch,
        sessionGeneration,
        onProgress: reportSyncProgress,
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
                        {syncEtaSec === 0
                          ? ' · done'
                          : !syncEtaHonest
                            ? // % frozen (Electrum/discovery) — do not invent a short countdown
                              ' · working…'
                            : syncEtaSec !== null && syncEtaSec > 0
                              ? ` · ~${Math.max(1, syncEtaSec)}s left`
                              : '…'}
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
                  const fused =
                    !!currentWalletId &&
                    isFusionTransaction(currentWalletId, tx.tx_hash);
                  return (
                  <SettingsRow
                    key={tx.tx_hash}
                    title={shortenTxHash(tx.tx_hash)}
                    description={
                      tx.height > 0
                        ? `Block ${tx.height}`
                        : 'Pending confirmation'
                    }
                    right={
                      <span className="flex items-center gap-1.5">
                        {fused && (
                          <span className="text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">
                            Fused
                          </span>
                        )}
                        <span className="wallet-muted">
                          {tx.height > 0 ? 'Confirmed' : 'Pending'}
                        </span>
                      </span>
                    }
                    compact
                    onClick={() => navigate(`/transactions/${currentWalletId}`)}
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
