import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition } from '../../../types/addons';
import {
  PARYON_CORE_CONTRACTS,
  resolveParyonWorkspaceSnapshot,
} from '../../../services/paryon/ParyonService';
import { executeBorrowLoan, executeStakeLiquidity } from '../../../services/paryon/transactions';
import { buildParyonExecutionPlans } from '../../../services/paryon/execution';
import {
  buildBorrowPreview,
  buildParyonReadinessCopy,
  buildRedeemPreview,
  buildStakePreview,
  buildWalletHistoryLines,
  formatBchSats,
  formatPusdAtomic,
  loadParyonNativeSnapshot,
  shortHex,
  type ParyonNativeSnapshot,
  type ParyonActionPreview,
  type ParyonTransactionPlan,
} from '../../../services/paryon/native';
import type { ParyonLiveMarketState } from '../../../services/paryon/native';
import type { ParyonExecutionPlan } from '../../../services/paryon/types';
import { ContainedSwipeConfirmModal } from '../mint-cashtokens-poc/components/uiPrimitives';
import { getReturnPath } from '../../../utils/navigation';
import WalletScreen from '../../../components/ui/WalletScreen';
import SegmentedSubnav from '../../../components/ui/SegmentedSubnav';

type Props = {
  sdk: AddonSDK;
  app: AddonAppDefinition;
};

type BorrowForm = {
  borrowAmount: string;
  collateralBch: string;
};

type StakeForm = {
  stakeAmount: string;
};

type RedeemForm = {
  redeemAmount: string;
};

type ConfirmState = {
  open: boolean;
  preview: ParyonTransactionPlan | null;
  action: 'borrow' | 'stake' | 'redeem' | null;
};

type ParyonWorkspaceView = 'overview' | 'borrow' | 'stake' | 'redeem' | 'positions';

type PositionTab = 'loans' | 'stakes' | 'redemptions';

const DEFAULT_MARKET: ParyonLiveMarketState = {
  oraclePriceCentsPerBch: null,
  currentPeriod: null,
  currentEpoch: null,
  chainHeight: null,
  expectedPeriod: null,
  periodDeltaPeriods: null,
  writeEnabled: false,
  verifiedMainnetV1: false,
};

function stateTone(
  enabled: boolean | null,
  fallback: 'positive' | 'neutral' | 'warning' = 'neutral'
): 'positive' | 'neutral' | 'warning' {
  if (enabled == null) return fallback;
  return enabled ? 'positive' : 'warning';
}

export default function ParyonWorkspaceApp({ sdk, app }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const network = sdk.wallet.getContext().network;
  const backTarget = getReturnPath(location, '/apps');
  const snapshot = useMemo(() => resolveParyonWorkspaceSnapshot(network), [network]);
  const readinessCopy = useMemo(() => buildParyonReadinessCopy(snapshot), [snapshot]);

  const [view, setView] = useState<ParyonWorkspaceView>('overview');
  const [positionTab, setPositionTab] = useState<PositionTab>('loans');
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [nativeSnapshot, setNativeSnapshot] = useState<ParyonNativeSnapshot | null>(null);
  const [loadingNativeSnapshot, setLoadingNativeSnapshot] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [borrowForm, setBorrowForm] = useState<BorrowForm>({
    borrowAmount: '100.00',
    collateralBch: '0.25',
  });
  const [stakeForm, setStakeForm] = useState<StakeForm>({ stakeAmount: '100.00' });
  const [redeemForm, setRedeemForm] = useState<RedeemForm>({ redeemAmount: '100.00' });
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    preview: null,
    action: null,
  });
  const lastDebugLogRef = useRef<string | null>(null);

  const writeEnabled = nativeSnapshot?.market.writeEnabled ?? false;
  const positionSummary = nativeSnapshot?.positionIndex.summary ?? {
    loans: 0,
    stabilityPool: 0,
    redemptions: 0,
    authorities: 0,
    system: 0,
    total: 0,
  };
  const flowPlans = nativeSnapshot?.flowPlans ?? null;
  const market = nativeSnapshot?.market ?? DEFAULT_MARKET;
  const executionPlans = useMemo(
    () =>
      nativeSnapshot
        ? buildParyonExecutionPlans({
            snapshot: {
              readiness: snapshot.readiness,
              verifiedMainnetV1: snapshot.verifiedMainnetV1,
            },
            market,
            nativeSnapshot: {
              positionIndex: nativeSnapshot.positionIndex,
              threadHealth: nativeSnapshot.threadHealth,
              systemHealth: nativeSnapshot.systemHealth,
            },
          })
        : null,
    [nativeSnapshot, snapshot.readiness, snapshot.verifiedMainnetV1, market]
  );
  const borrowPreview = useMemo(
    () =>
      buildBorrowPreview({
        snapshot,
        market,
        borrowAmountText: borrowForm.borrowAmount,
        collateralBchText: borrowForm.collateralBch,
      }),
    [snapshot, market, borrowForm.borrowAmount, borrowForm.collateralBch]
  );
  const stakePreview = useMemo(
    () =>
      buildStakePreview({
        snapshot,
        market,
        stakeAmountText: stakeForm.stakeAmount,
      }),
    [snapshot, market, stakeForm.stakeAmount]
  );
  const redeemPreview = useMemo(
    () =>
      buildRedeemPreview({
        snapshot,
        market,
        redeemAmountText: redeemForm.redeemAmount,
      }),
    [snapshot, market, redeemForm.redeemAmount]
  );
  const historyLines = useMemo(
    () => buildWalletHistoryLines(nativeSnapshot?.walletUtxos ?? []),
    [nativeSnapshot?.walletUtxos]
  );
  const writeWarning =
    snapshot.readiness === 'missing-config'
      ? 'Deployment config is missing. This workspace stays read-only until the required env values are set.'
      : !snapshot.verifiedMainnetV1
        ? 'Deployment inputs are present but do not match the verified live mainnet-v1 bundle.'
        : loadingNativeSnapshot
          ? 'Loading live contract threads and period state…'
          : writeEnabled
            ? 'Live mainnet-v1 is verified and the contract threads are healthy.'
            : 'Live mainnet-v1 is verified, but one or more contract threads or the pool period are stale.';

  const positionsForTab = useMemo(() => {
    if (!nativeSnapshot?.positionIndex) return [];
    switch (positionTab) {
      case 'loans':
        return nativeSnapshot.positionIndex.loans;
      case 'stakes':
        return nativeSnapshot.positionIndex.stabilityPool;
      case 'redemptions':
        return nativeSnapshot.positionIndex.redemptions;
      default:
        return [];
    }
  }, [nativeSnapshot?.positionIndex, positionTab]);

  const selectedPosition = useMemo(() => {
    if (positionsForTab.length === 0) return null;
    if (selectedPositionId == null) return positionsForTab[0];
    return positionsForTab.find((record) => record.positionId === selectedPositionId) ?? positionsForTab[0];
  }, [positionsForTab, selectedPositionId]);

  const positionLifecycleSummary = useMemo(
    () =>
      positionsForTab.reduce(
        (summary, record) => {
          if (record.state === 'live') summary.live += 1;
          else if (record.state === 'pending') summary.pending += 1;
          else if (record.state === 'locked') summary.locked += 1;
          else summary.other += 1;
          return summary;
        },
        { live: 0, pending: 0, locked: 0, other: 0 }
      ),
    [positionsForTab]
  );
  const protocolSnapshotItems = useMemo(() => {
    const threadHealth = nativeSnapshot?.threadHealth ?? [];
    const systemHealth = nativeSnapshot?.systemHealth ?? null;
    const threadTotal = systemHealth
      ? systemHealth.freshThreads + systemHealth.degradedThreads + systemHealth.staleThreads
      : threadHealth.length;

    return [
      {
        label: 'Oracle price',
        value:
          nativeSnapshot == null
            ? 'Loading…'
            : market.oraclePriceCentsPerBch != null
              ? `$${(Number(market.oraclePriceCentsPerBch) / 100).toFixed(2)}`
              : 'Unavailable',
        sublabel:
          market.oraclePriceCentsPerBch != null
            ? 'Live BCH/USD oracle'
            : 'Waiting for a fresh price thread',
      },
      {
        label: 'Period',
        value:
          nativeSnapshot == null
            ? 'Loading…'
            : market.currentPeriod != null
              ? `Period ${market.currentPeriod}`
              : 'Unavailable',
        sublabel:
          market.currentEpoch != null
            ? `Epoch ${market.currentEpoch}`
            : 'Chain period not resolved',
      },
      {
        label: 'Threads',
        value:
          nativeSnapshot == null
            ? 'Loading…'
            : `${systemHealth?.freshThreads ?? 0}/${threadTotal || 0} fresh`,
        sublabel:
          nativeSnapshot != null
            ? `${systemHealth?.staleThreads ?? 0} stale, ${systemHealth?.degradedThreads ?? 0} degraded`
            : 'Loading live contract threads',
      },
      {
        label: 'Positions',
        value:
          nativeSnapshot == null ? 'Loading…' : String(nativeSnapshot.positionIndex.summary.total),
        sublabel: 'Loans, stakes, and redemptions',
      },
    ];
  }, [market, nativeSnapshot]);
  const liveThreadItems = useMemo(
    () =>
      nativeSnapshot
        ? Object.values(nativeSnapshot.liveContracts).map((contract) => ({
            name: contract.name,
            freshness: contract.freshness,
            threadCount: contract.threadCount,
            utxoCount: contract.utxoCount,
            preferredOutpoint: contract.preferredOutpoint,
            warnings: contract.warnings,
          }))
        : [],
    [nativeSnapshot]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadNativeSnapshot() {
      setLoadingNativeSnapshot(true);
      setLoadError(null);

      try {
        const loaded = await loadParyonNativeSnapshot(sdk, snapshot);
        if (cancelled) return;
        setNativeSnapshot(loaded);
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : 'Failed to load Paryon workspace data'
        );
      } finally {
        if (!cancelled) {
          setLoadingNativeSnapshot(false);
        }
      }
    }

    void loadNativeSnapshot();

    return () => {
      cancelled = true;
    };
  }, [sdk, snapshot]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [view]);

  useEffect(() => {
    if (positionsForTab.length === 0) {
      setSelectedPositionId(null);
      return;
    }
    if (!positionsForTab.some((record) => record.positionId === selectedPositionId)) {
      setSelectedPositionId(positionsForTab[0].positionId);
    }
  }, [positionsForTab, selectedPositionId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return;
    const debugState = {
      view,
      positionTab,
      readiness: snapshot.readiness,
      verifiedMainnetV1: snapshot.verifiedMainnetV1,
      deploymentProfile: snapshot.deploymentProfile,
      network: snapshot.network,
      contractCount: snapshot.contractCount,
      loadError,
      statusMessage,
      writeEnabled,
      writeWarning,
      oraclePriceCentsPerBch: market.oraclePriceCentsPerBch?.toString() ?? null,
      currentPeriod: market.currentPeriod,
      currentEpoch: market.currentEpoch,
      chainHeight: market.chainHeight,
      expectedPeriod: market.expectedPeriod,
      periodDeltaPeriods: market.periodDeltaPeriods,
      systemHealth: nativeSnapshot?.systemHealth
        ? {
            chainHeight: nativeSnapshot.systemHealth.chainHeight,
            expectedPeriod: nativeSnapshot.systemHealth.expectedPeriod,
            periodDeltaPeriods: nativeSnapshot.systemHealth.periodDeltaPeriods,
            canWrite: nativeSnapshot.systemHealth.canWrite,
            freshThreads: nativeSnapshot.systemHealth.freshThreads,
            degradedThreads: nativeSnapshot.systemHealth.degradedThreads,
            staleThreads: nativeSnapshot.systemHealth.staleThreads,
          }
        : null,
      liveContracts: nativeSnapshot
        ? Object.fromEntries(
            Object.entries(nativeSnapshot.liveContracts).map(([name, contract]) => [
              name,
              {
                freshness: contract.freshness,
                threadCount: contract.threadCount,
                utxoCount: contract.utxoCount,
                warnings: contract.warnings,
                preferredOutpoint: contract.preferredOutpoint,
              },
            ])
          )
        : null,
      positions: nativeSnapshot?.positionIndex?.summary ?? null,
      selectedPosition: selectedPosition
        ? {
            positionId: selectedPosition.positionId,
            kind: selectedPosition.kind,
            state: selectedPosition.state,
            warnings: selectedPosition.warnings,
          }
        : null,
      flowPlans: flowPlans
        ? {
            loan: flowPlans.loan.ready,
            pool: flowPlans.pool.ready,
            redemption: flowPlans.redemption.ready,
            operator: flowPlans.operator.ready,
          }
        : null,
    };
    const signature = JSON.stringify(debugState);
    if (signature === lastDebugLogRef.current) return;
    lastDebugLogRef.current = signature;
    console.log('[Paryon] app state snapshot', signature);
  }, [
    flowPlans,
    loadError,
    market,
    nativeSnapshot,
    positionTab,
    selectedPosition,
    snapshot,
    statusMessage,
    view,
    writeEnabled,
    writeWarning,
  ]);

  const openPreview = (preview: ParyonActionPreview) => {
    setConfirmState({
      open: true,
      preview,
      action: view === 'borrow' ? 'borrow' : view === 'stake' ? 'stake' : 'redeem',
    });
  };

  const closePreview = () => {
    setConfirmState({ open: false, preview: null, action: null });
  };

  const confirmPreview = async () => {
    if (!confirmState.preview) return;
    if (confirmState.action === 'borrow') {
      if (!nativeSnapshot) {
        setStatusMessage('Live wallet state is still loading.');
        return;
      }
      try {
        setStatusMessage('Building and broadcasting the live borrow transaction…');
        const result = await executeBorrowLoan({
          sdk,
          snapshot,
          nativeSnapshot,
          borrowAmountText: borrowForm.borrowAmount,
          collateralBchText: borrowForm.collateralBch,
        });
        setStatusMessage(`Borrow transaction broadcast${result.txid ? `: ${result.txid}` : ''}.`);
        closePreview();
        return;
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (confirmState.action === 'stake') {
      if (!nativeSnapshot) {
        setStatusMessage('Live wallet state is still loading.');
        return;
      }
      try {
        setStatusMessage('Building and broadcasting the live stake transaction…');
        const result = await executeStakeLiquidity({
          sdk,
          snapshot,
          nativeSnapshot,
          stakeAmountText: stakeForm.stakeAmount,
        });
        setStatusMessage(`Stake transaction broadcast${result.txid ? `: ${result.txid}` : ''}.`);
        closePreview();
        return;
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setStatusMessage(`${confirmState.preview.title} preview staged inside OPTN Wallet.`);
    closePreview();
  };

  const renderNav = () => (
    <SegmentedSubnav
      value={view}
      onChange={setView}
      className="sticky top-0 z-20 -mx-4 border-b border-white/6 bg-[#09070d]/92 px-4 py-3 backdrop-blur"
      options={[
        { value: 'overview', label: 'Overview' },
        { value: 'borrow', label: 'Borrow' },
        { value: 'stake', label: 'Stake' },
        { value: 'redeem', label: 'Redeem' },
        { value: 'positions', label: 'Positions' },
      ]}
    />
  );

  const renderOverview = () => (
    <div className="space-y-4">
      <section data-section="overview" className="rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(171,92,255,0.24),transparent_30%),linear-gradient(180deg,#20172c_0%,#13101a_56%,#0c0a10_100%)] p-4 shadow-[0_20px_70px_rgba(0,0,0,0.42)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#ae64ff]/30 bg-[#241533]/90 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-[#ebddff]">
              <span className="h-2 w-2 rounded-full bg-[#b86bff]" />
              ParyonUSD
            </div>
            <h1 className="mt-3 text-[1.95rem] font-extrabold tracking-[-0.08em] text-white">
              {app.name}
            </h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-white/70">
              {snapshot.verifiedMainnetV1
                ? 'ParyonUSD actions inside OPTN Wallet: borrow BCH collateral, stake PUSD, redeem against live positions, and review tracked positions.'
                : snapshot.verificationSummary}
            </p>
          </div>
          <div className="shrink-0 rounded-[1.2rem] border border-white/10 bg-white/5 px-3 py-2.5 text-center backdrop-blur">
            <div className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-white/55">
              Network
            </div>
            <div className="mt-1 text-[1.35rem] font-bold capitalize text-white">
              {snapshot.network}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone={stateTone(snapshot.verifiedMainnetV1, 'warning')}>
            {readinessCopy.label}
          </Badge>
          <Badge tone={stateTone(snapshot.verifiedMainnetV1, 'neutral')}>
            {snapshot.deploymentProfile === 'mainnet-v1'
              ? 'Verified live deployment'
              : snapshot.deploymentProfile}
          </Badge>
          <Badge tone="neutral">{snapshot.contractCount} contracts bundled</Badge>
        </div>
      </section>

      {loadError ? (
        <StatusBanner tone="warning">
          Wallet data refresh failed: {loadError}. The workspace stays available in read-only mode.
        </StatusBanner>
      ) : null}

      {statusMessage ? (
        <StatusBanner tone="positive">{statusMessage}</StatusBanner>
      ) : null}

      <StatusBanner tone={snapshot.verifiedMainnetV1 && writeEnabled ? 'positive' : 'warning'}>
        {writeWarning}
      </StatusBanner>

      <section data-section="protocol-snapshot" className="rounded-[1.75rem] border border-white/10 bg-[rgba(27,24,35,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Protocol snapshot</h2>
            <p className="mt-1 text-sm text-white/62">
              Live ParyonUSD state surfaced separately from wallet balances.
            </p>
          </div>
          <Badge tone={stateTone(nativeSnapshot?.systemHealth?.canWrite ?? false, 'warning')}>
            {nativeSnapshot?.systemHealth?.canWrite ? 'Writable' : 'Read only'}
          </Badge>
        </div>

        <div className="mt-3">
          <StatGrid items={protocolSnapshotItems} />
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-black/10 px-3 py-2 text-xs leading-5 text-white/82">
          {nativeSnapshot == null
            ? 'Loading protocol state and contract threads…'
            : market.oraclePriceCentsPerBch == null
              ? 'Oracle price has not resolved yet, so borrow and redeem previews stay conservative.'
              : `Oracle price and period state are available. ${nativeSnapshot.systemHealth.freshThreads} live threads indexed.`}
        </div>

        <div className="mt-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Live contract threads</h3>
              <p className="mt-1 text-xs text-white/55">
                Individual thread health for the verified deployment.
              </p>
            </div>
            <Badge tone={stateTone((nativeSnapshot?.systemHealth?.freshThreads ?? 0) > 0, 'warning')}>
              {nativeSnapshot?.systemHealth?.freshThreads ?? 0} fresh
            </Badge>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {liveThreadItems.map((thread) => (
              <div
                key={thread.name}
                className="rounded-2xl border border-white/10 bg-black/12 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">{thread.name}</div>
                    <div className="mt-1 text-xs text-white/55">
                      {thread.threadCount} output{thread.threadCount === 1 ? '' : 's'} ·{' '}
                      {thread.utxoCount} wallet UTXOs
                    </div>
                  </div>
                  <Badge tone={thread.freshness === 'fresh' ? 'positive' : 'warning'}>
                    {thread.freshness}
                  </Badge>
                </div>
                {thread.preferredOutpoint ? (
                  <div className="mt-2 break-all text-[0.72rem] leading-5 text-white/58">
                    {thread.preferredOutpoint}
                  </div>
                ) : null}
                {thread.warnings.length > 0 ? (
                  <div className="mt-2 rounded-xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-3 py-2 text-xs leading-5 text-[#ffc76d]">
                    {thread.warnings.join(' ')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section data-section="balances" className="rounded-[1.75rem] border border-[#30d3ad]/20 bg-[linear-gradient(180deg,#0c9377_0%,#0b7e68_100%)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.26)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/72">
              Overview
            </div>
            <div className="mt-1 text-xl font-bold text-white">Balances</div>
          </div>
          <div className="rounded-full bg-black/20 px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-white/80">
            Spendable
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BalanceCard
            label="BCH"
            value={loadingNativeSnapshot ? 'Loading…' : formatBchSats(nativeSnapshot?.balances.bchSats ?? 0n)}
            sublabel="Available BCH"
          />
          <BalanceCard
            label="PUSD"
            value={loadingNativeSnapshot ? 'Loading…' : formatPusdAtomic(nativeSnapshot?.balances.pusdAtomic ?? 0n)}
            sublabel="Available stablecoin"
            align="right"
          />
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-black/10 px-3 py-2 text-xs leading-5 text-white/82">
          {loadingNativeSnapshot
            ? 'Loading wallet balances and live contract state…'
            : `Derived from wallet UTXOs only. ${nativeSnapshot?.balances.spendableUtxoCount ?? 0} spendable outputs, ${nativeSnapshot?.balances.tokenUtxoCount ?? 0} token outputs.`}
        </div>
      </section>

      <section data-section="actions" className="rounded-[1.75rem] border border-white/10 bg-[rgba(27,24,35,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Primary actions</h2>
            <p className="mt-1 text-sm text-white/62">
              Borrow, stake, redeem, or review positions from a single mobile surface.
            </p>
          </div>
          <Badge tone={writeEnabled ? 'positive' : 'warning'}>{writeEnabled ? 'Live' : 'Read only'}</Badge>
        </div>

        <div className="mt-3 grid gap-3">
          <button
            type="button"
            className="rounded-[1.5rem] border border-[#b744ff]/18 bg-white/5 px-4 py-4 text-left transition hover:bg-white/10"
            onClick={() => setView('borrow')}
          >
            <div className="text-base font-semibold text-white">Borrow</div>
            <div className="mt-1 text-sm leading-6 text-white/68">
              Open or manage a PUSD loan against BCH collateral.
            </div>
            <div className="mt-3 text-xs uppercase tracking-[0.22em] text-white/52">
              Min collateral: {borrowPreview.primaryMetricValue}
            </div>
          </button>
          <button
            type="button"
            className="rounded-[1.5rem] border border-[#3a78ff]/18 bg-white/5 px-4 py-4 text-left transition hover:bg-white/10"
            onClick={() => setView('stake')}
          >
            <div className="text-base font-semibold text-white">Stake</div>
            <div className="mt-1 text-sm leading-6 text-white/68">
              Deposit PUSD into the stability pool and track epoch-bound claims.
            </div>
            <div className="mt-3 text-xs uppercase tracking-[0.22em] text-white/52">
              Receipt epoch: {stakePreview.primaryMetricValue}
            </div>
          </button>
          <button
            type="button"
            className="rounded-[1.5rem] border border-[#9b4dff]/18 bg-white/5 px-4 py-4 text-left transition hover:bg-white/10"
            onClick={() => setView('redeem')}
          >
            <div className="text-base font-semibold text-white">Redeem</div>
            <div className="mt-1 text-sm leading-6 text-white/68">
              Redeem PUSD for BCH at the live oracle price with 12-block finalization.
            </div>
            <div className="mt-3 text-xs uppercase tracking-[0.22em] text-white/52">
              Estimated payout: {redeemPreview.primaryMetricValue}
            </div>
          </button>
          <button
            type="button"
            className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4 text-left transition hover:bg-white/10"
            onClick={() => setView('positions')}
          >
            <div className="text-base font-semibold text-white">Positions</div>
            <div className="mt-1 text-sm leading-6 text-white/68">
              Review active loans, stake receipts, and redemption state.
            </div>
            <div className="mt-3 text-xs uppercase tracking-[0.22em] text-white/52">
              {positionSummary.total} tracked positions
            </div>
          </button>
        </div>
      </section>

      <section data-section="safety" className="rounded-[1.75rem] border border-[#ffb84d]/20 bg-[rgba(36,25,15,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Safety rails</h2>
            <p className="mt-1 text-sm leading-6 text-white/68">
              Keep the protocol constraints visible before you open a position.
            </p>
          </div>
          <Badge tone={snapshot.verifiedMainnetV1 && writeEnabled ? 'positive' : 'warning'}>
            {writeEnabled ? 'Live rules' : 'Read only'}
          </Badge>
        </div>

        <div className="mt-3 grid gap-3">
          <div className="rounded-[1.4rem] border border-white/10 bg-black/15 p-4">
            <div className="text-sm font-semibold text-white">Borrow</div>
            <div className="mt-2 text-sm leading-6 text-white/72">
              Minimum collateral ratio is 110%. The borrow preview calculates liquidation price
              from the live oracle, and lower rates sit earlier in redemption priority.
            </div>
          </div>
          <div className="rounded-[1.4rem] border border-white/10 bg-black/15 p-4">
            <div className="text-sm font-semibold text-white">Stake</div>
            <div className="mt-2 text-sm leading-6 text-white/72">
              Minimum stake amount is 100 PUSD. Stakes are locked until the next epoch boundary,
              and BCH payouts are claimable after each epoch.
            </div>
          </div>
          <div className="rounded-[1.4rem] border border-white/10 bg-black/15 p-4">
            <div className="text-sm font-semibold text-white">Redeem</div>
            <div className="mt-2 text-sm leading-6 text-white/72">
              Minimum redemption amount is 100 PUSD. Redemptions finalize after 12 blocks and
              should be treated as a delayed multi-step flow, not an instant swap.
            </div>
          </div>
        </div>
      </section>

      <details data-section="protocol-details" className="rounded-[1.75rem] border border-white/10 bg-[rgba(24,21,31,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]">
        <summary className="cursor-pointer list-none">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Protocol details</h2>
              <p className="mt-1 text-sm leading-6 text-white/65">
                Live deployment values, routing health, and contract bundle metadata.
              </p>
            </div>
            <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
              Compact
            </span>
          </div>
        </summary>

        <div className="mt-4 space-y-3">
          <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Deployment</h3>
                <p className="mt-1 text-xs text-white/55">{snapshot.verificationSummary}</p>
              </div>
              <Badge tone={snapshot.verifiedMainnetV1 ? 'positive' : 'warning'}>
                {snapshot.verifiedMainnetV1 ? 'Verified' : 'Check config'}
              </Badge>
            </div>
            <div className="mt-3 rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-4 py-3 text-sm leading-6 text-[#ffc76d]">
              {!snapshot.verifiedMainnetV1
                ? 'Live writes stay disabled until the verified bundle is matched.'
                : loadingNativeSnapshot
                  ? 'Loading live contract threads and period state…'
                  : writeEnabled
                    ? 'Live mainnet-v1 is verified and the contract threads are healthy.'
                    : 'Live mainnet-v1 is verified, but one or more contract threads or the pool period are stale.'}
            </div>
          </div>

          <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
            <h3 className="text-sm font-semibold text-white">Readiness</h3>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <CompactStatusRow label="Loan plan" value={flowPlans?.loan.ready ? 'Ready' : 'Blocked'} />
              <CompactStatusRow label="Pool plan" value={flowPlans?.pool.ready ? 'Ready' : 'Blocked'} />
              <CompactStatusRow
                label="Redeem plan"
                value={flowPlans?.redemption.ready ? 'Ready' : 'Blocked'}
              />
              <CompactStatusRow
                label="Operator"
                value={flowPlans?.operator.ready ? 'Ready' : 'Review'}
              />
            </div>
          </div>

          <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
            <h3 className="text-sm font-semibold text-white">Live bundle</h3>
            <div className="mt-3 grid gap-2">
              {PARYON_CORE_CONTRACTS.map((name) => {
                const contract = snapshot.contractsByName[name];
                return (
                  <div key={name} className="rounded-2xl border border-white/10 bg-black/12 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-white">{name}</div>
                        <div className="mt-1 text-xs text-white/58">
                          {contract.abiNames.length} callable entrypoints
                        </div>
                      </div>
                      <Badge tone={contract.resolved ? 'positive' : 'warning'}>
                        {contract.resolved ? 'resolved' : 'needs config'}
                      </Badge>
                    </div>
                    <div className="mt-2 break-all font-mono text-[0.72rem] leading-5 text-white/68">
                      {shortHex(contract.address)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </details>

      <button
        type="button"
        className="wallet-btn-danger mt-2 w-full rounded-full px-4 py-3 text-sm font-semibold"
        onClick={() => navigate(backTarget)}
      >
        Back
      </button>
    </div>
  );

  const renderBorrow = () => (
    <ActionScreen
      title="Loan"
      subtitle="Open or manage a live loan inside OPTN Wallet with the verified mainnet rules."
      preview={borrowPreview}
      plan={executionPlans?.borrow ?? null}
      writeEnabled={writeEnabled}
      onBack={() => setView('overview')}
      onReview={() => openPreview(borrowPreview)}
      form={
        <div className="space-y-3">
          <Field
            label="Loan amount"
            value={borrowForm.borrowAmount}
            onChange={(value) => setBorrowForm((current) => ({ ...current, borrowAmount: value }))}
            placeholder="100.00"
            helper="Minimum 100.00 PUSD"
          />
          <Field
            label="Collateral (BCH)"
            value={borrowForm.collateralBch}
            onChange={(value) => setBorrowForm((current) => ({ ...current, collateralBch: value }))}
            placeholder="0.25"
            helper="Borrow preview computes the 110% minimum from the live oracle price."
          />
        </div>
      }
    />
  );

  const renderStake = () => (
    <ActionScreen
      title="Stability Pool"
      subtitle="Stake into the stability pool to earn liquidations and claims from the live epoch schedule."
      preview={stakePreview}
      plan={executionPlans?.stake ?? null}
      writeEnabled={writeEnabled}
      onBack={() => setView('overview')}
      onReview={() => openPreview(stakePreview)}
      form={
        <Field
          label="Stake amount"
          value={stakeForm.stakeAmount}
          onChange={(value) => setStakeForm({ stakeAmount: value })}
          placeholder="100.00"
          helper="Minimum 100.00 PUSD and receipts unlock on the next epoch."
        />
      }
    />
  );

  const renderRedeem = () => (
    <ActionScreen
      title="Redemption"
      subtitle="Redeem PUSD for BCH at the locked oracle rate, with the native timelock and fee rules enforced in the preview."
      preview={redeemPreview}
      plan={executionPlans?.redeem ?? null}
      writeEnabled={writeEnabled}
      onBack={() => setView('overview')}
      onReview={() => openPreview(redeemPreview)}
      form={
        <Field
          label="Redeem amount"
          value={redeemForm.redeemAmount}
          onChange={(value) => setRedeemForm({ redeemAmount: value })}
          placeholder="100.00"
          helper="Minimum 100.00 PUSD, timelocked for 12 blocks during finalization."
        />
      }
    />
  );

  const renderPositions = () => (
    <ScreenShell
      data-section="positions"
      title="Positions"
      subtitle="Wallet-linked loan, pool, and redemption state derived from native UTXO index."
      onBack={() => setView('overview')}
    >
      <div className="space-y-3">
        <SegmentedSubnav
          value={positionTab}
          onChange={setPositionTab}
          options={[
            { value: 'loans', label: 'Loans' },
            { value: 'stakes', label: 'Stakes' },
            { value: 'redemptions', label: 'Redemptions' },
          ]}
        />

        <StatGrid
          items={[
            {
              label: 'Loans',
              value: String(nativeSnapshot?.positions.loans ?? 0),
              sublabel: 'Open loan UTXOs in wallet state',
            },
            {
              label: 'Stakes',
              value: String(nativeSnapshot?.positions.stakes ?? 0),
              sublabel: 'Stability pool and receipt positions',
            },
            {
              label: 'Redemptions',
              value: String(nativeSnapshot?.positions.redemptions ?? 0),
              sublabel: 'Redemption-linked wallet positions',
            },
          ]}
        />

        {positionLifecycleSummary.pending > 0 || positionLifecycleSummary.locked > 0 ? (
          <InfoPanel tone="warning">
            {positionLifecycleSummary.pending > 0
              ? `${positionLifecycleSummary.pending} pending position${
                  positionLifecycleSummary.pending === 1 ? '' : 's'
                } need follow-up or confirmation. `
              : ''}
            {positionLifecycleSummary.locked > 0
              ? `${positionLifecycleSummary.locked} locked position${
                  positionLifecycleSummary.locked === 1 ? '' : 's'
                } are waiting on the next protocol boundary.`
              : ''}
          </InfoPanel>
        ) : null}

        <div className="space-y-2">
          {positionsForTab.length === 0 ? (
            <InfoPanel tone="neutral">
              {positionTab === 'loans'
                ? 'No live loan positions are indexed yet.'
                : positionTab === 'stakes'
                  ? 'No live stability-pool positions are indexed yet.'
                  : 'No live redemption positions are indexed yet.'}
            </InfoPanel>
          ) : (
            positionsForTab.map((record) => (
              <button
                key={record.positionId}
                type="button"
                className={`block w-full rounded-2xl border px-3 py-3 text-left transition ${
                  selectedPosition?.positionId === record.positionId
                    ? 'border-[var(--wallet-accent)] bg-white/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
                onClick={() => setSelectedPositionId(record.positionId)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-white">{record.label}</div>
                    <div className="mt-1 text-xs text-white/58">
                      {record.kind} · {record.state} · {record.contractNames.join(', ')}
                    </div>
                  </div>
                  <Badge tone={record.warnings.length > 0 ? 'warning' : 'neutral'}>
                    {record.warnings.length > 0 ? 'Review' : 'Live'}
                  </Badge>
                </div>
                <div className="mt-2 text-xs leading-5 text-white/70">
                  {record.details.slice(0, 2).join(' · ')}
                </div>
                {record.warnings.length > 0 ? (
                  <div className="mt-2 rounded-xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-3 py-2 text-xs leading-5 text-[#ffc76d]">
                    {record.warnings.join(' ')}
                  </div>
                ) : null}
              </button>
            ))
          )}
        </div>

        {selectedPosition ? (
          <section className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Selected position</h3>
                <p className="mt-1 text-xs text-white/55">
                  Drill-down snapshot for the currently selected loan, stake, or redemption.
                </p>
              </div>
              <Badge tone={selectedPosition.state === 'live' ? 'positive' : 'warning'}>
                {selectedPosition.state}
              </Badge>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <CompactStatusRow label="Kind" value={selectedPosition.kind} />
              <CompactStatusRow label="Value" value={`${selectedPosition.valueSats.toString()} sats`} />
              <CompactStatusRow
                label="Token amount"
                value={
                  selectedPosition.tokenAmountAtomic != null
                    ? selectedPosition.tokenAmountAtomic.toString()
                    : '—'
                }
              />
              <CompactStatusRow label="Outputs" value={selectedPosition.outputIndexes.join(', ')} />
            </div>

            <div className="mt-3 rounded-2xl border border-white/10 bg-black/12 p-3 text-sm leading-6 text-white/84">
              {selectedPosition.details.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>

            {selectedPosition.warnings.length > 0 ? (
              <div className="mt-3 rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-4 py-3 text-sm leading-6 text-[#ffc76d]">
                {selectedPosition.warnings.join(' ')}
              </div>
            ) : null}

            <div className="mt-3 rounded-2xl border border-white/10 bg-black/12 px-4 py-3 text-sm leading-6 text-white/76">
              Management paths are protocol-aware and shown here as reference only until the
              specific detail actions are wired into the add-on flow.
            </div>
          </section>
        ) : null}

        <details className="rounded-[1.4rem] border border-white/10 bg-white/5 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Wallet history</h3>
                <p className="mt-1 text-xs text-white/55">Last wallet-linked Paryon outputs.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                {historyLines.length}
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-2">
            {historyLines.length === 0 ? (
              <InfoPanel tone="neutral">
                Open a borrow, stake, or redeem flow to populate the history view.
              </InfoPanel>
            ) : (
              historyLines.map((line) => (
                <div key={line} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm leading-6 text-white/86">
                  {line}
                </div>
              ))
            )}
          </div>
        </details>
      </div>
    </ScreenShell>
  );

  const renderView = () => {
    switch (view) {
      case 'overview':
        return renderOverview();
      case 'borrow':
        return renderBorrow();
      case 'stake':
        return renderStake();
      case 'redeem':
        return renderRedeem();
      case 'positions':
        return renderPositions();
      default:
        return renderOverview();
    }
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md" className="text-white">
      <div className="space-y-4">
        {renderNav()}
        {renderView()}
      </div>

      {confirmState.open ? (
        <ContainedSwipeConfirmModal
          open={confirmState.open}
          title={confirmState.preview?.title ?? 'Review action'}
          subtitle={
            confirmState.preview
              ? `${confirmState.preview.amountLabel} · ${confirmState.preview.primaryMetricLabel}: ${confirmState.preview.primaryMetricValue}`
              : undefined
          }
          warning={
            confirmState.preview?.warnings?.length
              ? confirmState.preview.warnings.join(' • ')
              : confirmState.preview?.blockedReason
                ? confirmState.preview.blockedReason
                : undefined
          }
          canConfirm={Boolean(confirmState.preview?.canProceed)}
          onCancel={closePreview}
          onConfirm={() => void confirmPreview()}
        >
          {confirmState.preview ? (
            <div className="space-y-3">
              <PreviewMetric
                label={confirmState.preview.primaryMetricLabel}
                value={confirmState.preview.primaryMetricValue}
              />
              <PreviewMetric
                label={confirmState.preview.secondaryMetricLabel}
                value={confirmState.preview.secondaryMetricValue}
              />
              <div className="space-y-2 rounded-2xl border border-white/10 bg-black/15 p-3 text-sm leading-6 text-white/82">
                {confirmState.preview.details.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              {confirmState.preview.warnings.length > 0 ? (
                <div className="rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-4 py-3 text-sm leading-6 text-[#ffc76d]">
                  {confirmState.preview.warnings.join(' ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </ContainedSwipeConfirmModal>
      ) : null}
    </WalletScreen>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: 'positive' | 'neutral' | 'warning';
  children: React.ReactNode;
}) {
  const styles = {
    positive: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    neutral: 'border-white/10 bg-white/5 text-white/72',
    warning: 'border-[#ffb84d]/20 bg-[#5b2d0f]/70 text-[#ffc76d]',
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.18em] ${styles}`}
    >
      {children}
    </span>
  );
}

function StatusBanner({
  tone,
  children,
}: {
  tone: 'positive' | 'neutral' | 'warning';
  children: React.ReactNode;
}) {
  const styles = {
    positive: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    neutral: 'border-white/10 bg-white/5 text-white/82',
    warning: 'border-[#ffb84d]/20 bg-[#5b2d0f]/70 text-[#ffc76d]',
  }[tone];

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${styles}`}>
      {children}
    </div>
  );
}

function BalanceCard({
  label,
  value,
  sublabel,
  align = 'left',
}: {
  label: string;
  value: string;
  sublabel: string;
  align?: 'left' | 'right';
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-black/12 px-4 py-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/68">
        {label}
      </div>
      <div className="mt-2 text-[1.95rem] font-bold tracking-[-0.04em] text-white">
        {value}
      </div>
      <div className="mt-1 text-xs leading-5 text-white/68">{sublabel}</div>
    </div>
  );
}

function CompactStatusRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/12 px-3 py-2.5">
      <div className="text-[0.64rem] uppercase tracking-[0.22em] text-white/55">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function ActionScreen({
  title,
  subtitle,
  preview,
  plan,
  writeEnabled,
  onBack,
  onReview,
  form,
}: {
  title: string;
  subtitle: string;
  preview: ParyonActionPreview;
  plan?: ParyonExecutionPlan | null;
  writeEnabled: boolean;
  onBack: () => void;
  onReview: () => void;
  form: React.ReactNode;
}) {
  return (
    <ScreenShell title={title} subtitle={subtitle} onBack={onBack}>
      <div className="space-y-3">
        <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-white/55">
                Preview
              </div>
              <div className="mt-1 text-lg font-semibold text-white">
                {preview.amountLabel}
              </div>
            </div>
            <Badge tone={preview.canProceed && writeEnabled ? 'positive' : 'warning'}>
              {preview.canProceed && writeEnabled ? 'Ready' : 'Blocked'}
            </Badge>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <PreviewMetric label={preview.primaryMetricLabel} value={preview.primaryMetricValue} />
            <PreviewMetric label={preview.secondaryMetricLabel} value={preview.secondaryMetricValue} />
          </div>

          <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-black/15 p-3 text-sm leading-6 text-white/82">
            {preview.details.map((detail) => (
              <div key={detail}>{detail}</div>
            ))}
          </div>

          {preview.warnings.length > 0 ? (
            <div className="mt-3 rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-4 py-3 text-sm leading-6 text-[#ffc76d]">
              {preview.warnings.join(' ')}
            </div>
          ) : null}

          {preview.blockedReason ? (
            <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-white/82">
              {preview.blockedReason}
            </div>
          ) : null}
        </div>

        <div className="rounded-[1.6rem] border border-white/10 bg-[rgba(26,22,34,0.98)] p-4">
          <div className="text-base font-semibold text-white">Native form</div>
          <div className="mt-4 space-y-3">{form}</div>
        </div>

        {plan ? (
          <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-white/55">
                  Execution plan
                </div>
                <div className="mt-1 text-sm font-semibold text-white">{plan.summary}</div>
              </div>
              <Badge tone={plan.ready ? 'positive' : 'warning'}>
                {plan.ready ? 'Ready' : 'Blocked'}
              </Badge>
            </div>
            {plan.target ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-black/12 px-3 py-3 text-sm leading-6 text-white/82">
                Target: {plan.target.label} · {plan.target.state} · {plan.target.txHash.slice(0, 12)}…
              </div>
            ) : null}
            <div className="mt-3 grid gap-2">
              <CompactStatusRow label="Outputs" value={String(plan.outputTemplate.length)} />
              <CompactStatusRow label="Validation" value={String(plan.validation.length)} />
            </div>
            <div className="mt-3 space-y-2 rounded-2xl border border-white/10 bg-black/12 p-3 text-sm leading-6 text-white/82">
              {plan.outputTemplate.slice(0, 5).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          className={`w-full rounded-full px-4 py-3 text-sm font-semibold text-white transition ${
            preview.canProceed && writeEnabled
              ? 'bg-[#a43dfc] hover:bg-[#b451ff]'
              : 'cursor-not-allowed bg-white/10 text-white/60'
          }`}
          disabled={!preview.canProceed || !writeEnabled}
          onClick={onReview}
        >
          Review plan
        </button>
      </div>
    </ScreenShell>
  );
}

function ScreenShell({
  dataSection,
  title,
  subtitle,
  onBack,
  children,
}: {
  dataSection?: string;
  title: string;
  subtitle: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <section
        data-section={dataSection}
        className="rounded-[2rem] border border-white/10 bg-[rgba(27,24,35,0.96)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/55">
              Paryon workspace
            </div>
            <h2 className="mt-1 text-[1.9rem] font-extrabold tracking-[-0.06em] text-white">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/90 transition hover:bg-white/10"
            onClick={onBack}
          >
            Overview
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-white/65">{subtitle}</p>
      </section>

      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  helper,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  helper: string;
}) {
  return (
    <label className="block">
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/55">
        {label}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        className="mt-2 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-base text-white outline-none placeholder:text-white/30 focus:border-[#b35cff]/40"
      />
      <div className="mt-2 text-xs leading-5 text-white/58">{helper}</div>
    </label>
  );
}

function PreviewMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/12 px-3 py-3">
      <div className="text-[0.68rem] uppercase tracking-[0.22em] text-white/55">
        {label}
      </div>
      <div className="mt-1 break-words text-sm font-semibold text-white">{value}</div>
    </div>
  );
}

function StatGrid({
  items,
}: {
  items: Array<{ label: string; value: string; sublabel: string }>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4">
          <div className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-white/55">
            {item.label}
          </div>
          <div className="mt-2 text-2xl font-bold tracking-[-0.04em] text-white">
            {item.value}
          </div>
          <div className="mt-1 text-xs leading-5 text-white/68">{item.sublabel}</div>
        </div>
      ))}
    </div>
  );
}

function InfoPanel({
  tone,
  children,
}: {
  tone: 'positive' | 'neutral' | 'warning';
  children: React.ReactNode;
}) {
  const styles = {
    positive: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    neutral: 'border-white/10 bg-white/5 text-white/82',
    warning: 'border-[#ffb84d]/20 bg-[#5b2d0f]/70 text-[#ffc76d]',
  }[tone];
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${styles}`}>{children}</div>
  );
}
