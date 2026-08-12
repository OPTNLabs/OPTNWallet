import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

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
  formatUsdCents,
  loadParyonNativeSnapshot,
  paryonNativeViewReducer,
  PARYON_NATIVE_VIEWS,
  shortHex,
  type ParyonNativeSnapshot,
  type ParyonNativeView,
  type ParyonTransactionPlan,
} from '../../../services/paryon/native';
import type { ParyonLiveMarketState } from '../../../services/paryon/native';
import type { ParyonExecutionPlan } from '../../../services/paryon/types';
import { ContainedSwipeConfirmModal } from '../mint-cashtokens-poc/components/uiPrimitives';

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

type SectionTarget = 'actions' | 'deployment' | 'system-map';

const DEFAULT_MARKET: ParyonLiveMarketState = {
  oraclePriceCentsPerBch: null,
  currentPeriod: null,
  currentEpoch: null,
  writeEnabled: false,
  verifiedMainnetV1: false,
};

function toCurrency(value: bigint | null): string {
  return value == null ? '—' : formatUsdCents(value);
}

function toBch(value: bigint | null): string {
  return value == null ? '—' : formatBchSats(value);
}

function stateTone(
  enabled: boolean | null,
  fallback: 'positive' | 'neutral' | 'warning' = 'neutral'
): 'positive' | 'neutral' | 'warning' {
  if (enabled == null) return fallback;
  return enabled ? 'positive' : 'warning';
}

export default function ParyonWorkspaceApp({ sdk, app }: Props) {
  const network = sdk.wallet.getContext().network;
  const snapshot = useMemo(() => resolveParyonWorkspaceSnapshot(network), [network]);
  const readinessCopy = useMemo(() => buildParyonReadinessCopy(snapshot), [snapshot]);

  const [view, dispatchView] = useReducer(paryonNativeViewReducer, 'dashboard' as ParyonNativeView);
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

  const actionsRef = useRef<HTMLElement | null>(null);
  const deploymentRef = useRef<HTMLElement | null>(null);
  const contractsRef = useRef<HTMLElement | null>(null);

  const writeEnabled = nativeSnapshot?.market.writeEnabled ?? false;
  const positionSummary = nativeSnapshot?.positionIndex.summary ?? {
    loans: 0,
    stabilityPool: 0,
    redemptions: 0,
    authorities: 0,
    system: 0,
    total: 0,
  };
  const positionIndex = nativeSnapshot?.positionIndex ?? null;
  const threadHealth = nativeSnapshot?.threadHealth ?? [];
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

  const scrollToSection = (target: SectionTarget) => {
    const ref =
      target === 'actions'
        ? actionsRef.current
        : target === 'deployment'
          ? deploymentRef.current
          : contractsRef.current;
    ref?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const primaryActionTarget: SectionTarget = snapshot.primaryAction.targetSection;

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

  const renderNav = () => (
    <div className="sticky top-0 z-20 -mx-4 border-b border-white/6 bg-[#09070d]/92 px-4 py-3 backdrop-blur">
      <div className="overflow-x-auto">
        <div className="flex min-w-max gap-2">
          {PARYON_NATIVE_VIEWS.map((item) => {
            const active = item.view === view;
            return (
              <button
                key={item.view}
                type="button"
                onClick={() => dispatchView({ type: 'navigate', view: item.view })}
                className={[
                  'rounded-full border px-4 py-2 text-left transition',
                  active
                    ? 'border-[#b35cff]/40 bg-[#2d183f] text-white shadow-[0_10px_30px_rgba(120,50,186,0.18)]'
                    : 'border-white/10 bg-white/5 text-white/78 hover:bg-white/8',
                ].join(' ')}
              >
                <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em]">
                  {item.label}
                </div>
                <div className="mt-1 text-[0.72rem] leading-4 text-white/58">
                  {item.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderDashboard = () => (
    <div className="space-y-4">
      <section
        data-section="overview"
        className="rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(171,92,255,0.24),transparent_30%),linear-gradient(180deg,#20172c_0%,#13101a_56%,#0c0a10_100%)] p-4 shadow-[0_20px_70px_rgba(0,0,0,0.42)]"
      >
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
                ? 'A native BCH-backed stablecoin dashboard with borrow, stake, and redeem flows kept entirely inside OPTN Wallet.'
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

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="rounded-full bg-[#a43dfc] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(147,61,255,0.35)] transition hover:bg-[#b451ff]"
            onClick={() => scrollToSection(primaryActionTarget)}
          >
            {snapshot.primaryAction.label}
          </button>
          <button
            type="button"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/90 transition hover:bg-white/10"
            onClick={() =>
              writeEnabled
                ? scrollToSection('system-map')
                : scrollToSection('deployment')
            }
          >
            {writeEnabled ? 'View production state' : 'View deployment details'}
          </button>
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

      <section
        data-section="balances"
        className="rounded-[1.75rem] border border-[#30d3ad]/20 bg-[linear-gradient(180deg,#0c9377_0%,#0b7e68_100%)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.26)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/72">
              OPTN Wallet
            </div>
            <div className="mt-1 text-xl font-bold text-white">Balances</div>
          </div>
          <div className="rounded-full bg-black/20 px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-white/80">
            Spendable
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
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

      <section
        data-section="actions"
        ref={actionsRef}
        className="rounded-[1.75rem] border border-white/10 bg-[rgba(27,24,35,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Actions</h2>
            <p className="mt-1 text-sm text-white/62">
              {writeEnabled
                ? 'Loan, stability pool, and redemption flows stay native, compact, and wallet-owned.'
                : 'Stablecoin actions stay gated until deployment verification and live thread health pass.'}
            </p>
          </div>
          <Badge tone={writeEnabled ? 'positive' : 'warning'}>{writeEnabled ? 'Live' : 'Read only'}</Badge>
        </div>

        {flowPlans ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <CompactStatusRow label="Loan plan" value={flowPlans.loan.ready ? 'Ready' : 'Blocked'} />
            <CompactStatusRow label="Pool plan" value={flowPlans.pool.ready ? 'Ready' : 'Blocked'} />
            <CompactStatusRow
              label="Redeem plan"
              value={flowPlans.redemption.ready ? 'Ready' : 'Blocked'}
            />
            <CompactStatusRow
              label="Operator"
              value={flowPlans.operator.ready ? 'Ready' : 'Review'}
            />
          </div>
        ) : null}

        <div className="mt-3 grid gap-3">
          <LaunchCard
            tone="borrow"
            title="Loan"
            description="Open or manage a PUSD loan against BCH collateral."
            metricLabel="Min collateral"
            metricValue={
              borrowPreview.primaryMetricValue === 'Awaiting price'
                ? 'Awaiting price'
                : borrowPreview.primaryMetricValue
            }
            buttonLabel="Open Loan"
            enabled={writeEnabled}
            onClick={() => dispatchView({ type: 'navigate', view: 'borrow' })}
          />
          <LaunchCard
            tone="stake"
            title="Stability Pool"
            description="Stake PUSD, then withdraw or claim through the epoch-aware pool."
            metricLabel="Receipt epoch"
            metricValue={stakePreview.primaryMetricValue}
            buttonLabel="Open Pool"
            enabled={writeEnabled}
            onClick={() => dispatchView({ type: 'navigate', view: 'stake' })}
          />
          <LaunchCard
            tone="redeem"
            title="Redemption"
            description="Redeem PUSD for BCH at the locked oracle price."
            metricLabel="Estimated payout"
            metricValue={redeemPreview.primaryMetricValue}
            buttonLabel="Open Redemption"
            enabled={writeEnabled}
            onClick={() => dispatchView({ type: 'navigate', view: 'redeem' })}
          />
        </div>
      </section>

      <section
        data-section="deployment"
        ref={deploymentRef}
        className="rounded-[1.75rem] border border-white/10 bg-[rgba(24,21,31,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Deployment</h2>
            <p className="mt-1 text-sm leading-6 text-white/65">{snapshot.verificationSummary}</p>
          </div>
          <Badge tone={snapshot.verifiedMainnetV1 ? 'positive' : 'warning'}>
            {snapshot.verifiedMainnetV1 ? 'Verified' : 'Check config'}
          </Badge>
        </div>

        <div className="mt-3 rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-4 py-3 text-sm leading-6 text-[#ffc76d]">
          {writeWarning}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <InfoRow label="Oracle public key" value={shortHex(snapshot.config.oraclePublicKey)} />
          <InfoRow
            label="Protocol fee bytecode"
            value={shortHex(snapshot.config.protocolFeeLockingBytecode)}
          />
          <InfoRow label="Start block" value={String(snapshot.config.startBlockHeight)} />
          <InfoRow
            label="Period length"
            value={`${snapshot.config.periodLengthBlocks} blocks`}
          />
        </div>

        <details
          data-section="resources"
          className="mt-3 rounded-[1.4rem] border border-white/10 bg-black/15 p-3"
        >
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Token IDs</h3>
                <p className="mt-1 text-xs text-white/55">Tap to inspect the verified bundle.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                Compact
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-2">
            {Object.entries(snapshot.config.tokenIds).map(([key, value]) => (
              <div key={key} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                <div className="text-[0.68rem] uppercase tracking-[0.22em] text-white/55">
                  {key}
                </div>
                <div className="mt-1 break-all text-sm text-white/90">{shortHex(value)}</div>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section
        data-section="system-map"
        ref={contractsRef}
        className="rounded-[1.75rem] border border-white/10 bg-[rgba(24,21,31,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Production state</h2>
            <p className="mt-1 text-sm leading-6 text-white/65">
              Indexed positions, routing health, and the live contract bundle.
            </p>
          </div>
          <Badge tone={writeEnabled ? 'positive' : 'warning'}>
            {writeEnabled ? 'Write ready' : 'Read only'}
          </Badge>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <CompactStatusRow label="Loans" value={String(positionSummary.loans)} />
          <CompactStatusRow label="Stability pool" value={String(positionSummary.stabilityPool)} />
          <CompactStatusRow label="Redemptions" value={String(positionSummary.redemptions)} />
          <CompactStatusRow
            label="Fresh threads"
            value={`${nativeSnapshot?.systemHealth.freshThreads ?? 0}/${threadHealth.length || 5}`}
          />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <CompactStatusRow
            label="Period delta"
            value={
              nativeSnapshot?.systemHealth.periodDeltaPeriods == null
                ? 'Unknown'
                : nativeSnapshot.systemHealth.periodDeltaPeriods === 0
                  ? 'Synced'
                  : `${nativeSnapshot.systemHealth.periodDeltaPeriods > 0 ? '+' : ''}${nativeSnapshot.systemHealth.periodDeltaPeriods}`
            }
          />
          <CompactStatusRow
            label="Positions"
            value={String(positionIndex?.summary.total ?? positionSummary.total)}
          />
        </div>

        <details className="mt-3 rounded-[1.4rem] border border-white/10 bg-black/15 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Indexed positions</h3>
                <p className="mt-1 text-xs text-white/55">Loan, pool, redemption, and authority bundles.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                {positionIndex?.summary.total ?? 0}
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-2">
            {nativeSnapshot?.positionIndex ? (
              (
                [
                  ...nativeSnapshot.positionIndex.loans,
                  ...nativeSnapshot.positionIndex.stabilityPool,
                  ...nativeSnapshot.positionIndex.redemptions,
                  ...nativeSnapshot.positionIndex.authorities,
                  ...nativeSnapshot.positionIndex.system,
                ] as const
              ).map((record) => (
                <div key={record.positionId} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
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
                </div>
              ))
            ) : (
              <InfoPanel tone="neutral">Loading indexed positions…</InfoPanel>
            )}
          </div>
        </details>

        <details className="mt-3 rounded-[1.4rem] border border-white/10 bg-black/15 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Thread routing</h3>
                <p className="mt-1 text-xs text-white/55">Preferred live outputs and freshness warnings.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                {threadHealth.filter((thread) => thread.freshness === 'fresh').length}/{threadHealth.length || 5}
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-2">
            {threadHealth.length > 0 ? (
              threadHealth.map((thread) => (
                <div key={thread.name} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">{thread.name}</div>
                      <div className="mt-1 text-xs text-white/58">
                        {thread.threadCount} live outputs · {shortHex(thread.tokenId)}
                      </div>
                    </div>
                    <Badge tone={thread.freshness === 'fresh' ? 'positive' : 'warning'}>
                      {thread.freshness}
                    </Badge>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-white/70">
                    Preferred outpoint: {thread.preferredOutpoint ?? 'unresolved'}
                  </div>
                  {thread.warnings.length > 0 ? (
                    <div className="mt-2 rounded-xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-3 py-2 text-xs leading-5 text-[#ffc76d]">
                      {thread.warnings.join(' ')}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <InfoPanel tone="neutral">Loading thread routing…</InfoPanel>
            )}
          </div>
        </details>

        <details className="mt-3 rounded-[1.4rem] border border-white/10 bg-black/15 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Live contract bundle</h3>
                <p className="mt-1 text-xs text-white/55">Core verified contracts bundled with the app.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                {snapshot.contractCount}
              </span>
            </div>
          </summary>
          <div className="mt-3 grid gap-2">
            {PARYON_CORE_CONTRACTS.map((name) => {
              const contract = snapshot.contractsByName[name];
              return (
                <div key={name} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
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
        </details>

        <details className="mt-3 rounded-[1.4rem] border border-white/10 bg-black/15 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Compiled bundle</h3>
                <p className="mt-1 text-xs text-white/55">All compiled contracts are bundled.</p>
              </div>
              <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
                Preview
              </span>
            </div>
          </summary>
          <div className="mt-4 flex flex-wrap gap-2">
            {snapshot.artifactNames.map((name) => (
              <span
                key={name}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[0.72rem] font-medium text-white/78"
              >
                {name}
              </span>
            ))}
          </div>
        </details>
      </section>

      <details
        data-section="debug"
        className="rounded-[1.75rem] border border-white/10 bg-[rgba(24,21,31,0.96)] p-4 shadow-[0_18px_54px_rgba(0,0,0,0.28)]"
      >
        <summary className="cursor-pointer list-none">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Operator debug</h2>
              <p className="mt-1 text-sm leading-6 text-white/65">
                Compact debug view for support and integration work.
              </p>
            </div>
            <span className="text-[0.72rem] uppercase tracking-[0.2em] text-white/45">
              Hidden
            </span>
          </div>
        </summary>
        <pre className="mt-4 overflow-auto rounded-3xl border border-white/10 bg-black/25 p-4 text-[0.72rem] leading-5 text-white/85">
{JSON.stringify(
  {
    network: snapshot.network,
    readiness: snapshot.readiness,
    deploymentProfile: snapshot.deploymentProfile,
    verifiedMainnetV1: snapshot.verifiedMainnetV1,
    market: {
      oraclePriceCentsPerBch: nativeSnapshot?.market.oraclePriceCentsPerBch?.toString() ?? '(loading)',
      currentPeriod: nativeSnapshot?.market.currentPeriod ?? '(loading)',
      currentEpoch: nativeSnapshot?.market.currentEpoch ?? '(loading)',
      writeEnabled: nativeSnapshot?.market.writeEnabled ?? false,
    },
    walletBalances: nativeSnapshot
      ? {
          bchSats: nativeSnapshot.balances.bchSats.toString(),
          pusdAtomic: nativeSnapshot.balances.pusdAtomic.toString(),
          spendableUtxoCount: nativeSnapshot.balances.spendableUtxoCount,
          tokenUtxoCount: nativeSnapshot.balances.tokenUtxoCount,
        }
      : '(loading)',
    contractCounts: nativeSnapshot
      ? {
          price: nativeSnapshot.liveContracts.PriceContract.utxoCount,
          borrowing: nativeSnapshot.liveContracts.Borrowing.utxoCount,
          stabilityPool: nativeSnapshot.liveContracts.StabilityPool.utxoCount,
          redeemer: nativeSnapshot.liveContracts.Redeemer.utxoCount,
          loanKeyFactory: nativeSnapshot.liveContracts.LoanKeyFactory.utxoCount,
        }
      : '(loading)',
  },
  null,
  2
)}
        </pre>
      </details>
    </div>
  );

  const renderBorrow = () => (
    <ActionScreen
      title="Loan"
      subtitle="Open or manage a live loan inside OPTN Wallet with the verified mainnet rules."
      preview={borrowPreview}
      plan={executionPlans?.borrow ?? null}
      writeEnabled={writeEnabled}
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
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
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
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
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
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

  const renderHistory = () => (
    <ScreenShell
      title="Positions"
      subtitle="Wallet-linked loan, pool, and redemption state derived from native UTXO index."
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
    >
      <div className="space-y-3">
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

        <div className="space-y-2">
          {historyLines.length === 0 ? (
            <InfoPanel tone="neutral">
              No Paryon-linked wallet history is available yet. Open a borrow, stake, or redeem flow to populate the native history view.
            </InfoPanel>
          ) : (
            historyLines.map((line) => (
              <div key={line} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm leading-6 text-white/86">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </ScreenShell>
  );

  const renderStats = () => (
    <ScreenShell
      title="Operator"
      subtitle="Thread health, routing, and production readiness from the live bundle."
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
    >
      <div className="space-y-3">
        <StatGrid
          items={[
            {
              label: 'Oracle price',
              value: toCurrency(market.oraclePriceCentsPerBch),
              sublabel: 'USD per BCH from PriceContract',
            },
            {
              label: 'Chain height',
              value:
                nativeSnapshot?.market.chainHeight != null
                  ? String(nativeSnapshot.market.chainHeight)
                  : '—',
              sublabel: 'Latest live block height',
            },
            {
              label: 'Current period',
              value:
                nativeSnapshot?.market.currentPeriod != null
                  ? String(nativeSnapshot.market.currentPeriod)
                  : '—',
              sublabel: 'Period state derived from StabilityPool',
            },
            {
              label: 'Expected period',
              value:
                nativeSnapshot?.market.expectedPeriod != null
                  ? String(nativeSnapshot.market.expectedPeriod)
                  : '—',
              sublabel: 'Derived from chain height and deployment params',
            },
          ]}
        />

        <StatGrid
          items={[
            {
              label: 'Write mode',
              value: writeEnabled ? 'Enabled' : 'Read only',
              sublabel: writeEnabled ? 'Verified live mainnet-v1' : 'Fail-closed until verified',
            },
            {
              label: 'Fresh threads',
              value: nativeSnapshot?.systemHealth.freshThreads != null ? String(nativeSnapshot.systemHealth.freshThreads) : '—',
              sublabel: 'Live contract threads routed cleanly',
            },
            {
              label: 'Stale threads',
              value: nativeSnapshot?.systemHealth.staleThreads != null ? String(nativeSnapshot.systemHealth.staleThreads) : '—',
              sublabel: 'Threads requiring operator review',
            },
            {
              label: 'Live positions',
              value: nativeSnapshot?.positionIndex.summary.total != null
                ? String(nativeSnapshot.positionIndex.summary.total)
                : '—',
              sublabel: 'Loan, pool, redemption, and authority bundles',
            },
          ]}
        />

        <section className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
          <h3 className="text-sm font-semibold text-white">Plan readiness</h3>
          <div className="mt-3 grid grid-cols-2 gap-2">
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
        </section>

        <section className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
          <h3 className="text-sm font-semibold text-white">Thread routing</h3>
          <div className="mt-3 space-y-2">
            {threadHealth.length > 0 ? (
              threadHealth.map((thread) => (
                <div key={thread.name} className="rounded-2xl border border-white/10 bg-black/12 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">{thread.name}</div>
                      <div className="mt-1 text-xs text-white/58">
                        {thread.threadCount} live outputs · {shortHex(thread.tokenId)}
                      </div>
                    </div>
                    <Badge tone={thread.freshness === 'fresh' ? 'positive' : 'warning'}>
                      {thread.freshness}
                    </Badge>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-white/72">
                    Preferred outpoint: {thread.preferredOutpoint ?? 'unresolved'}
                  </div>
                  {thread.warnings.length > 0 ? (
                    <div className="mt-2 rounded-2xl border border-[#ffb84d]/20 bg-[#5b2d0f]/70 px-3 py-2 text-xs leading-5 text-[#ffc76d]">
                      {thread.warnings.join(' ')}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <InfoPanel tone="neutral">Loading live contract thread health…</InfoPanel>
            )}
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
          <h3 className="text-sm font-semibold text-white">Live contract outputs</h3>
          <div className="mt-3 space-y-2">
            {nativeSnapshot ? (
              ([
                ['PriceContract', nativeSnapshot.liveContracts.PriceContract],
                ['Borrowing', nativeSnapshot.liveContracts.Borrowing],
                ['StabilityPool', nativeSnapshot.liveContracts.StabilityPool],
                ['Redeemer', nativeSnapshot.liveContracts.Redeemer],
                ['LoanKeyFactory', nativeSnapshot.liveContracts.LoanKeyFactory],
              ] as const).map(([name, contract]) => (
                <div key={name} className="rounded-2xl border border-white/10 bg-black/12 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">{name}</div>
                      <div className="mt-1 text-xs text-white/58">
                        {contract.utxoCount} live outputs · {toBch(contract.totalValueSats)}
                      </div>
                    </div>
                    <Badge tone={contract.resolved ? 'positive' : 'warning'}>
                      {contract.resolved ? 'Live' : 'Query failed'}
                    </Badge>
                  </div>
                  <div className="mt-2 break-all font-mono text-[0.72rem] leading-5 text-white/68">
                    {shortHex(contract.address)}
                  </div>
                </div>
              ))
            ) : (
              <InfoPanel tone="neutral">Loading live contract statistics…</InfoPanel>
            )}
          </div>
        </section>
      </div>
    </ScreenShell>
  );

  const renderFaq = () => (
    <ScreenShell
      title="FAQ"
      subtitle="Short answers for the live stablecoin wallet surface."
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
    >
      <div className="space-y-3">
        <FaqCard
          q="Why does the wallet only write on mainnet-v1?"
          a="The live deployment bundle is verified against the exact mainnet contract values. Anything else stays read-only and fail-closed."
        />
        <FaqCard
          q="What happens if deployment config is missing?"
          a="The wallet shows the missing fields and keeps borrow, stake, and redeem flows disabled until the deployment env is complete."
        />
        <FaqCard
          q="Why is redeem delayed?"
          a="Finalization uses a 12-block timelock to protect the redemption path and keep the contract logic consensus-safe."
        />
        <FaqCard
          q="Is this app external-window based?"
          a="No. The ParyonUSD experience is rendered natively inside the OPTN Wallet shell."
        />
      </div>
    </ScreenShell>
  );

  const renderDocs = () => (
    <ScreenShell
      title="Docs"
      subtitle="Native in-app protocol notes and contract summaries."
      onBack={() => dispatchView({ type: 'navigate', view: 'dashboard' })}
    >
      <div className="space-y-3">
        <DocsCard
          title="Borrow"
          body="A loan requires BCH collateral, the live oracle price, and the launch-phase collateral floor. The preview computes the 110% threshold before any native action is staged."
        />
        <DocsCard
          title="Stake"
          body="Staking PUSD enters the stability pool. Receipts unlock with the next epoch, and withdrawals settle pro-rata against the live pool state."
        />
        <DocsCard
          title="Redeem"
          body="Redemption locks in the oracle price plus the 0.5% fee, then finalizes under the 12-block timelock. The native preview shows the expected BCH payout."
        />
        <DocsCard
          title="System map"
          body="The wallet keeps the verified bundle visible: PriceContract, Borrowing, StabilityPool, Redeemer, LoanKeyFactory, and the helper contracts that make up the live system."
        />
      </div>
    </ScreenShell>
  );

  const renderView = () => {
    switch (view) {
      case 'borrow':
        return renderBorrow();
      case 'stake':
        return renderStake();
      case 'redeem':
        return renderRedeem();
      case 'history':
        return renderHistory();
      case 'stats':
        return renderStats();
      case 'faq':
        return renderFaq();
      case 'docs':
        return renderDocs();
      case 'dashboard':
      default:
        return renderDashboard();
    }
  };

  return (
    <div className="container mx-auto max-w-md px-4 pb-6 pt-4 text-white wallet-page sm:max-w-lg">
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
    </div>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
      <div className="text-[0.72rem] uppercase tracking-[0.22em] text-white/55">
        {label}
      </div>
      <div className="mt-1 break-all text-sm leading-6 text-white/90">{value}</div>
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

function LaunchCard({
  tone,
  title,
  description,
  metricLabel,
  metricValue,
  buttonLabel,
  onClick,
  enabled,
}: {
  tone: 'borrow' | 'stake' | 'redeem';
  title: string;
  description: string;
  metricLabel: string;
  metricValue: string;
  buttonLabel: string;
  onClick: () => void;
  enabled: boolean;
}) {
  const toneStyles = {
    borrow: {
      border: 'border-[#b744ff]/18',
      accent: 'bg-[#b744ff]',
      button: 'bg-[#c13cff] hover:bg-[#d04cff]',
    },
    stake: {
      border: 'border-[#3a78ff]/18',
      accent: 'bg-[#3a78ff]',
      button: 'bg-[#3a78ff] hover:bg-[#4b88ff]',
    },
    redeem: {
      border: 'border-[#9b4dff]/18',
      accent: 'bg-[#9b4dff]',
      button: 'bg-[#9b4dff] hover:bg-[#ad5fff]',
    },
  }[tone];

  return (
    <div className={`rounded-[1.5rem] border ${toneStyles.border} bg-white/5 p-4`}>
      <div className="flex items-start gap-3">
        <div className={`mt-1 h-3 w-3 shrink-0 rounded-full ${toneStyles.accent}`} />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-white">{title}</div>
          <p className="mt-2 text-sm leading-6 text-white/68">{description}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-black/12 px-3 py-3">
        <div>
          <div className="text-[0.68rem] uppercase tracking-[0.22em] text-white/55">
            {metricLabel}
          </div>
          <div className="mt-1 text-sm font-semibold text-white">{metricValue}</div>
        </div>
        <button
          type="button"
          className={`inline-flex items-center justify-center rounded-full px-4 py-3 text-sm font-semibold text-white transition ${
            enabled ? toneStyles.button : 'bg-white/10 text-white/60'
          }`}
          onClick={onClick}
          disabled={!enabled}
        >
          {buttonLabel}
        </button>
      </div>
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
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-[2rem] border border-white/10 bg-[rgba(27,24,35,0.96)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-white/55">
              Native screen
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
            Dashboard
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
    <div className="grid grid-cols-2 gap-3">
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

function FaqCard({
  q,
  a,
}: {
  q: string;
  a: string;
}) {
  return (
    <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
      <div className="text-sm font-semibold text-white">{q}</div>
      <div className="mt-2 text-sm leading-6 text-white/72">{a}</div>
    </div>
  );
}

function DocsCard({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-2 text-sm leading-6 text-white/72">{body}</div>
    </div>
  );
}
