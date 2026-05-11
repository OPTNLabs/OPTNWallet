import type { UTXO } from '../../types/types';
import type {
  ParyonContractBundleName,
  ParyonFlowPlan,
  ParyonFlowPlanGroup,
  ParyonFlowSubplan,
  ParyonLiveContractState,
  ParyonLiveMarketState,
  ParyonPositionIndex,
  ParyonPositionKind,
  ParyonPositionRecord,
  ParyonPositionState,
  ParyonReadinessState,
  ParyonSystemHealth,
  ParyonThreadFreshness,
  ParyonThreadHealth,
  ParyonWorkspaceSnapshot,
} from './types';

export const PARYON_THREAD_TARGETS = [
  'PriceContract',
  'Borrowing',
  'StabilityPool',
  'Redeemer',
  'LoanKeyFactory',
] as const satisfies readonly ParyonContractBundleName[];

type ParyonThreadTargetName = (typeof PARYON_THREAD_TARGETS)[number];

const MUTABLE_THREAD_NAMES = new Set<ParyonContractBundleName>([
  'PriceContract',
]);

const MINTING_THREAD_NAMES = new Set<ParyonContractBundleName>([
  'Borrowing',
  'StabilityPool',
  'Redeemer',
  'LoanKeyFactory',
]);

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim() || '0');
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function normalizeName(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function outpointIndex(utxo: UTXO): number {
  return Number.isFinite(utxo.tx_pos) ? utxo.tx_pos : 0;
}

function capabilityRank(capability: 'none' | 'mutable' | 'minting' | null): number {
  switch (capability) {
    case 'minting':
      return 2;
    case 'mutable':
      return 1;
    default:
      return 0;
  }
}

function expectedThreadCapability(
  name: ParyonContractBundleName
): 'mutable' | 'minting' | null {
  if (MUTABLE_THREAD_NAMES.has(name)) return 'mutable';
  if (MINTING_THREAD_NAMES.has(name)) return 'minting';
  return null;
}

function classifyPositionKind(contractNames: string[]): ParyonPositionKind {
  const names = contractNames.map(normalizeName);
  if (names.some((name) => name.includes('redeemer') || name.includes('redemption'))) {
    return 'redemption';
  }
  if (
    names.some(
      (name) =>
        name.includes('stabilitypool') ||
        name.includes('collector') ||
        name.includes('payout') ||
        name.includes('addliquidity') ||
        name.includes('withdrawfrompool')
    )
  ) {
    return 'stability-pool';
  }
  if (names.some((name) => name.includes('loankey'))) {
    return 'authority';
  }
  if (names.some((name) => name === 'loan' || name.includes('borrow') || name.includes('manage'))) {
    return 'loan';
  }
  return 'system';
}

function classifyPositionState(
  kind: ParyonPositionKind,
  contractNames: string[]
): ParyonPositionState {
  const names = new Set(contractNames.map(normalizeName));

  switch (kind) {
    case 'loan':
      if (names.has('loan') && names.has('loansidecar')) return 'live';
      if (names.has('loan')) return 'pending';
      return 'unknown';
    case 'stability-pool':
      if (names.has('stabilitypool')) return 'live';
      return 'pending';
    case 'redemption':
      if (names.has('redemption') && names.has('redemptionsidecar')) return 'live';
      if (names.has('redemption')) return 'pending';
      if (names.has('redeemer')) return 'locked';
      return 'unknown';
    case 'authority':
      return names.size > 0 ? 'live' : 'unknown';
    case 'system':
      return names.size > 0 ? 'live' : 'unknown';
    default:
      return 'unknown';
  }
}

function buildPositionLabel(kind: ParyonPositionKind, contractNames: string[]): string {
  const primary = contractNames[0] ?? 'Contract';
  switch (kind) {
    case 'loan':
      return contractNames.includes('Loan Sidecar') ? 'Loan bundle' : 'Loan position';
    case 'stability-pool':
      return primary.toLowerCase().includes('collector')
        ? 'Collector bundle'
        : 'Stability pool bundle';
    case 'redemption':
      return 'Redemption bundle';
    case 'authority':
      return 'Authority bundle';
    case 'system':
    default:
      return `${primary} bundle`;
  }
}

function buildPositionWarnings(
  kind: ParyonPositionKind,
  contractNames: string[],
  capability: 'none' | 'mutable' | 'minting' | null
): string[] {
  const warnings: string[] = [];
  const names = new Set(contractNames.map(normalizeName));

  if (kind === 'loan' && !names.has('loansidecar')) {
    warnings.push('Loan sidecar is missing from the indexed bundle.');
  }
  if (kind === 'redemption' && !names.has('redemptionsidecar')) {
    warnings.push('Redemption sidecar is missing from the indexed bundle.');
  }
  if (kind === 'stability-pool' && !names.has('stabilitypoolsidecar')) {
    warnings.push('Stability pool sidecar is missing from the indexed bundle.');
  }
  if (kind === 'authority' && capability !== 'minting') {
    warnings.push('Authority bundle does not expose a minting token capability.');
  }
  if (contractNames.length > 1 && new Set(contractNames).size !== contractNames.length) {
    warnings.push('Repeated contract names were collapsed into a single position.');
  }

  return warnings;
}

function buildPositionDetails(
  txHash: string,
  contractNames: string[],
  tokenCategories: string[],
  outputIndexes: number[],
  tokenAmountAtomic: bigint | null,
  valueSats: bigint
): string[] {
  const details: string[] = [];
  details.push(`tx ${txHash.slice(0, 12)}…`);
  details.push(`Outputs: ${outputIndexes.length}`);
  if (contractNames.length > 0) {
    details.push(`Contracts: ${[...new Set(contractNames)].join(', ')}`);
  }
  if (tokenCategories.length > 0) {
    details.push(`Token categories: ${[...new Set(tokenCategories)].length}`);
  }
  if (tokenAmountAtomic != null) {
    details.push(`Token amount: ${tokenAmountAtomic.toString()}`);
  }
  details.push(`Value: ${valueSats.toString()} sats`);
  return details;
}

type GroupedPosition = {
  txHash: string;
  contractNames: string[];
  outputIndexes: number[];
  tokenCategories: string[];
  tokenAmountAtomic: bigint | null;
  valueSats: bigint;
  capability: 'none' | 'mutable' | 'minting' | null;
};

function groupContractUtxos(utxos: UTXO[]): GroupedPosition[] {
  const groups = new Map<string, GroupedPosition>();

  for (const utxo of utxos) {
    const contractName = String(utxo.contractName ?? '').trim();
    if (!contractName) continue;

    const group = groups.get(utxo.tx_hash) ?? {
      txHash: utxo.tx_hash,
      contractNames: [],
      outputIndexes: [],
      tokenCategories: [],
      tokenAmountAtomic: null,
      valueSats: 0n,
      capability: null,
    };

    group.contractNames.push(contractName);
    group.outputIndexes.push(outpointIndex(utxo));
    group.valueSats += toBigInt(utxo.value ?? utxo.amount ?? 0);

    const category = utxo.token?.category?.trim();
    if (category) {
      group.tokenCategories.push(category);
      const tokenAmount = toBigInt(utxo.token.amount ?? 0);
      group.tokenAmountAtomic =
        group.tokenAmountAtomic == null ? tokenAmount : group.tokenAmountAtomic + tokenAmount;
    }

    const capability = utxo.token?.nft?.capability ?? null;
    if (capabilityRank(capability) > capabilityRank(group.capability)) {
      group.capability = capability;
    }

    groups.set(utxo.tx_hash, group);
  }

  return [...groups.values()].sort((a, b) => a.txHash.localeCompare(b.txHash));
}

export function indexParyonPositions(utxos: UTXO[]): ParyonPositionIndex {
  const groups = groupContractUtxos(utxos);
  const records: ParyonPositionRecord[] = groups.map((group) => {
    const kind = classifyPositionKind(group.contractNames);
    const state = classifyPositionState(kind, group.contractNames);
    const label = buildPositionLabel(kind, group.contractNames);
    const warnings = buildPositionWarnings(kind, group.contractNames, group.capability);

    return {
      kind,
      positionId: `${group.txHash}:${kind}`,
      txHash: group.txHash,
      outputIndexes: [...new Set(group.outputIndexes)].sort((a, b) => a - b),
      contractNames: [...new Set(group.contractNames)],
      tokenCategories: [...new Set(group.tokenCategories)],
      tokenAmountAtomic: group.tokenAmountAtomic,
      valueSats: group.valueSats,
      capability: group.capability,
      state,
      label,
      details: buildPositionDetails(
        group.txHash,
        group.contractNames,
        group.tokenCategories,
        group.outputIndexes,
        group.tokenAmountAtomic,
        group.valueSats
      ),
      warnings,
    };
  });

  const byKind = (kind: ParyonPositionKind) => records.filter((record) => record.kind === kind);

  return {
    loans: byKind('loan'),
    stabilityPool: byKind('stability-pool'),
    redemptions: byKind('redemption'),
    authorities: byKind('authority'),
    system: byKind('system'),
    summary: {
      loans: byKind('loan').length,
      stabilityPool: byKind('stability-pool').length,
      redemptions: byKind('redemption').length,
      authorities: byKind('authority').length,
      system: byKind('system').length,
      total: records.length,
    },
  };
}

function threadFreshnessFor(
  state: ParyonLiveContractState,
  expectedCapability: 'mutable' | 'minting' | null
): { freshness: ParyonThreadFreshness; warnings: string[] } {
  const warnings: string[] = [];

  if (!state.resolved) {
    warnings.push('Thread did not resolve against the live bundle.');
    return { freshness: 'missing', warnings };
  }

  if (state.threadCount === 0) {
    warnings.push('No live contract outputs were discovered for this thread.');
    return { freshness: 'stale', warnings };
  }

  if (expectedCapability != null && state.latestCapability != null && state.latestCapability !== expectedCapability) {
    warnings.push(
      `Expected ${expectedCapability} capability but found ${state.latestCapability}.`
    );
    return { freshness: 'degraded', warnings };
  }

  if (state.threadCount > 1) {
    warnings.push(
      `Multiple live outputs were discovered; routing will prefer ${state.preferredOutpoint ?? 'the first returned output'}.`
    );
  }

  return { freshness: 'fresh', warnings };
}

export function deriveParyonThreadHealth(
  liveContracts: Record<ParyonThreadTargetName, ParyonLiveContractState>
): ParyonThreadHealth[] {
  return PARYON_THREAD_TARGETS.map((name) => {
    const state = liveContracts[name];
    const expectedCapability = expectedThreadCapability(name);
    const freshnessResult = threadFreshnessFor(state, expectedCapability);

    return {
      name,
      tokenId: state.tokenId,
      preferredOutpoint: state.preferredOutpoint,
      threadCount: state.threadCount,
      freshness: freshnessResult.freshness,
      warnings: [...state.warnings, ...freshnessResult.warnings],
    };
  });
}

function threadFreshnessSummary(threadHealth: ParyonThreadHealth[]): ParyonSystemHealth {
  const freshThreads = threadHealth.filter((thread) => thread.freshness === 'fresh').length;
  const degradedThreads = threadHealth.filter((thread) => thread.freshness === 'degraded').length;
  const staleThreads = threadHealth.filter((thread) => thread.freshness !== 'fresh').length;

  return {
    chainHeight: null,
    expectedPeriod: null,
    periodDeltaPeriods: null,
    canWrite: false,
    freshThreads,
    degradedThreads,
    staleThreads,
  };
}

function buildSubplan(args: {
  name: string;
  summary: string;
  ready: boolean;
  blockedReason: string | null;
  steps: string[];
  requirements: string[];
  warnings: string[];
}): ParyonFlowSubplan {
  return {
    name: args.name,
    summary: args.summary,
    ready: args.ready,
    blockedReason: args.blockedReason,
    steps: args.steps,
    requirements: args.requirements,
    warnings: args.warnings,
  };
}

function writeGateReason(
  readiness: ParyonReadinessState,
  verifiedMainnetV1: boolean,
  systemHealth: ParyonSystemHealth
): string | null {
  if (readiness !== 'ready') {
    return 'Deployment config is missing.';
  }
  if (!verifiedMainnetV1) {
    return 'Live write flows are only enabled for verified mainnet-v1.';
  }
  if (!systemHealth.canWrite) {
    return 'Live contract threads or period freshness are stale.';
  }
  return null;
}

export function buildParyonFlowPlans(args: {
  snapshot: Pick<ParyonWorkspaceSnapshot, 'readiness' | 'verifiedMainnetV1'>;
  market: ParyonLiveMarketState;
  positionIndex: ParyonPositionIndex;
  threadHealth: ParyonThreadHealth[];
}): ParyonFlowPlanGroup {
  const systemHealth = {
    chainHeight: args.market.chainHeight,
    expectedPeriod: args.market.expectedPeriod,
    periodDeltaPeriods: args.market.periodDeltaPeriods,
    canWrite: args.market.writeEnabled,
    freshThreads: args.threadHealth.filter((thread) => thread.freshness === 'fresh').length,
    degradedThreads: args.threadHealth.filter((thread) => thread.freshness === 'degraded').length,
    staleThreads: args.threadHealth.filter((thread) => thread.freshness !== 'fresh').length,
  } satisfies ParyonSystemHealth;

  const gateReason = writeGateReason(
    args.snapshot.readiness,
    args.snapshot.verifiedMainnetV1,
    systemHealth
  );

  const hasFreshPrice = args.threadHealth.find((thread) => thread.name === 'PriceContract')?.freshness === 'fresh';
  const hasFreshBorrowing = args.threadHealth.find((thread) => thread.name === 'Borrowing')?.freshness === 'fresh';
  const hasFreshPool = args.threadHealth.find((thread) => thread.name === 'StabilityPool')?.freshness === 'fresh';
  const hasFreshRedeemer = args.threadHealth.find((thread) => thread.name === 'Redeemer')?.freshness === 'fresh';
  const loanManageReady = gateReason == null && args.positionIndex.loans.length > 0 && hasFreshBorrowing;
  const poolManageReady = gateReason == null && args.positionIndex.stabilityPool.length > 0 && hasFreshPool;
  const redemptionManageReady =
    gateReason == null && args.positionIndex.redemptions.length > 0 && hasFreshRedeemer;

  const threadWarningList = args.threadHealth.flatMap((thread) => thread.warnings);

  const loanPlan: ParyonFlowPlan = {
    key: 'loan',
    title: 'Loan lifecycle',
    summary:
      'Borrow opens a loan bundle. manageLoan repays debt, changes collateral, or updates interest while keeping the loan above the minimum live debt floor.',
    ready: gateReason == null && hasFreshBorrowing && hasFreshPrice,
    blockedReason:
      gateReason ??
      (hasFreshBorrowing ? (hasFreshPrice ? null : 'PriceContract is not fresh.') : 'Borrowing thread is not fresh.'),
    warnings: [
      ...threadWarningList,
      ...(args.positionIndex.loans.length === 0 ? ['No live loan positions were indexed yet.'] : []),
    ],
    subplans: [
      buildSubplan({
        name: 'Borrow',
        summary: 'Open a new loan bundle with BCH collateral and a fresh price thread.',
        ready: gateReason == null && hasFreshBorrowing && hasFreshPrice,
        blockedReason:
          gateReason ??
          (hasFreshBorrowing ? (hasFreshPrice ? null : 'Borrowing depends on a fresh PriceContract.') : 'Borrowing thread is not fresh.'),
        steps: [
          'Verify the wallet is on verified live mainnet-v1.',
          'Check the live oracle price and period freshness.',
          'Build the loan, sidecar, and loan-key bundle together.',
        ],
        requirements: [
          'Verified live mainnet-v1 deployment',
          'Fresh Borrowing thread',
          'Fresh PriceContract thread',
        ],
        warnings: threadWarningList,
      }),
      buildSubplan({
        name: 'manageLoan',
        summary: 'Repay debt, add or remove collateral, or change interest on an existing loan.',
        ready: loanManageReady,
        blockedReason:
          gateReason ??
          (args.positionIndex.loans.length > 0
            ? hasFreshBorrowing
              ? null
              : 'Borrowing thread is not fresh.'
            : 'No live loan positions were indexed yet.'),
        steps: [
          'Select a live loan position keyed by loanTokenId.',
          'Confirm the loan-key authority is still in wallet control.',
          'Validate the repayment keeps the loan above the minimum live debt floor.',
        ],
        requirements: [
          'At least one live loan position',
          'Fresh Borrowing thread',
          'Authority over the loan key or delegated manager',
        ],
        warnings: [
          'Repayment below the 100 PUSD minimum is only allowed when a redemption is completing.',
        ],
      }),
    ],
  };

  const poolPlan: ParyonFlowPlan = {
    key: 'pool',
    title: 'Stability pool lifecycle',
    summary:
      'Stake mints a next-epoch receipt. Withdraw burns the receipt and settles the full position. Claim collects payout rewards at epoch boundaries.',
    ready: gateReason == null && hasFreshPool,
    blockedReason: gateReason ?? (hasFreshPool ? null : 'StabilityPool thread is not fresh.'),
    warnings: [
      ...threadWarningList,
      ...(args.positionIndex.stabilityPool.length === 0
        ? ['No live stability-pool positions were indexed yet.']
        : []),
      ...(args.market.periodDeltaPeriods != null && args.market.periodDeltaPeriods !== 0
        ? ['Stability-pool period state is not aligned with the current chain period.']
        : []),
    ],
    subplans: [
      buildSubplan({
        name: 'Stake',
        summary: 'Stake PUSD and receive a receipt locked to the next epoch.',
        ready: gateReason == null && hasFreshPool,
        blockedReason: gateReason ?? (hasFreshPool ? null : 'StabilityPool thread is not fresh.'),
        steps: [
          'Select the PUSD amount to stake.',
          'Confirm the next-epoch receipt behavior.',
          'Stage the stability-pool output and sidecar together.',
        ],
        requirements: ['Verified live mainnet-v1', 'Fresh StabilityPool thread'],
        warnings: [
          'Staked funds earn from the next epoch boundary onward.',
        ],
      }),
      buildSubplan({
        name: 'Withdraw',
        summary: 'Withdraw burns the receipt and returns the full available position.',
        ready: poolManageReady,
        blockedReason:
          gateReason ??
          (args.positionIndex.stabilityPool.length > 0
            ? hasFreshPool
              ? null
              : 'StabilityPool thread is not fresh.'
            : 'No live stability-pool positions were indexed yet.'),
        steps: [
          'Choose the live receipt position to withdraw.',
          'Burn the receipt and settle the full available position.',
          'Apply any liquidation-adjusted pro-rata reduction before payout.',
        ],
        requirements: [
          'At least one stability-pool position',
          'Fresh StabilityPool thread',
        ],
        warnings: [
          'Withdrawals are full receipt burns, not partial free-form exits.',
        ],
      }),
      buildSubplan({
        name: 'Claim',
        summary: 'Claim payout rewards from the epoch-bound Payout contract.',
        ready: poolManageReady && args.market.currentEpoch != null,
        blockedReason:
          gateReason ??
          (args.market.currentEpoch != null
            ? hasFreshPool
              ? null
              : 'StabilityPool thread is not fresh.'
            : 'Current epoch is unavailable from live chain data.'),
        steps: [
          'Confirm the receipt epoch matches an available payout contract.',
          'Collect the proportional BCH reward for the live epoch.',
          'Advance the receipt to the next epoch when applicable.',
        ],
        requirements: [
          'Live payout state',
          'Receipt position in wallet scope',
        ],
        warnings: [
          'Claims only settle at epoch boundaries.',
        ],
      }),
    ],
  };

  const redemptionPlan: ParyonFlowPlan = {
    key: 'redemption',
    title: 'Redemption lifecycle',
    summary:
      'Redemption locks a price, then can swap target loans, finalize after 12 blocks, or cancel near a period boundary when the contract rules require it.',
    ready: gateReason == null && hasFreshRedeemer,
    blockedReason: gateReason ?? (hasFreshRedeemer ? null : 'Redeemer thread is not fresh.'),
    warnings: [
      ...threadWarningList,
      ...(args.positionIndex.redemptions.length === 0
        ? ['No live redemption positions were indexed yet.']
        : []),
    ],
    subplans: [
      buildSubplan({
        name: 'Start redemption',
        summary: 'Lock the redemption price and create the redemption bundle.',
        ready: gateReason == null && hasFreshRedeemer && hasFreshBorrowing,
        blockedReason:
          gateReason ??
          (hasFreshRedeemer
            ? hasFreshBorrowing
              ? null
              : 'Borrowing thread is not fresh.'
            : 'Redeemer thread is not fresh.'),
        steps: [
          'Choose a redeem amount above the minimum size.',
          'Lock the price at the start of redemption.',
          'Create the redemption and sidecar outputs together.',
        ],
        requirements: ['Fresh Redeemer thread', 'Fresh Borrowing thread'],
        warnings: [
          'Lowest-interest redeemable loans must be targeted first, with a small-loan exception below 100 PUSD.',
        ],
      }),
      buildSubplan({
        name: 'Swap',
        summary: 'Retarget a pending redemption to a lower-interest loan if the window is still open.',
        ready: redemptionManageReady,
        blockedReason:
          gateReason ??
          (args.positionIndex.redemptions.length > 0
            ? hasFreshRedeemer
              ? null
              : 'Redeemer thread is not fresh.'
            : 'No live redemption positions were indexed yet.'),
        steps: [
          'Inspect the currently targeted loan and its interest rate.',
          'Replace it with a lower-rate live loan if the contract allows it.',
          'Keep the redemption amount and payout destination consistent.',
        ],
        requirements: [
          'At least one live redemption position',
          'Fresh Redeemer thread',
        ],
        warnings: [
          'Swaps only work within the live redemption window and the same period.',
        ],
      }),
      buildSubplan({
        name: 'Finalize',
        summary: 'Finalize after the 12-block timelock when the period boundary allows it.',
        ready: redemptionManageReady && args.market.periodDeltaPeriods != null,
        blockedReason:
          gateReason ??
          (args.market.periodDeltaPeriods != null
            ? hasFreshRedeemer
              ? null
              : 'Redeemer thread is not fresh.'
            : 'Chain period freshness is unavailable.'),
        steps: [
          'Wait for the 12-block redemption timelock.',
          'Validate sequence and transaction version before finalization.',
          'Complete the BCH payout and close the redemption bundle.',
        ],
        requirements: ['Fresh Redeemer thread', 'Live redemption bundle'],
        warnings: [
          'Redemptions started close to a period boundary may cancel automatically.',
        ],
      }),
      buildSubplan({
        name: 'Cancel',
        summary: 'Cancel a pending redemption if the contract window has closed or the swap window expired.',
        ready: redemptionManageReady,
        blockedReason:
          gateReason ??
          (args.positionIndex.redemptions.length > 0
            ? hasFreshRedeemer
              ? null
              : 'Redeemer thread is not fresh.'
            : 'No live redemption positions were indexed yet.'),
        steps: [
          'Detect the pending redemption window.',
          'Return the redeeming PUSD to the wallet when cancellation is allowed.',
          'Leave the contract system in a fail-closed state.',
        ],
        requirements: ['Live redemption bundle', 'Fresh Redeemer thread'],
        warnings: [
          'Cancellation is a safety path, not a primary redemption flow.',
        ],
      }),
    ],
  };

  const operatorPlan: ParyonFlowPlan = {
    key: 'operator',
    title: 'Operator and maintenance',
    summary:
      'Keep contract threads fresh, route to the preferred thread outputs, and surface chain-height drift before any write flow is unlocked.',
    ready: gateReason == null && systemHealth.freshThreads === args.threadHealth.length,
    blockedReason:
      gateReason ??
      (systemHealth.freshThreads === args.threadHealth.length
        ? null
        : 'One or more live contract threads are stale or degraded.'),
    warnings: [
      ...threadWarningList,
      ...(args.market.periodDeltaPeriods != null && args.market.periodDeltaPeriods !== 0
        ? ['The stability pool period is not synchronized with the chain tip.']
        : []),
    ],
    subplans: [
      buildSubplan({
        name: 'Thread routing',
        summary: 'Route each write flow to the preferred live contract thread.',
        ready: systemHealth.freshThreads === args.threadHealth.length,
        blockedReason:
          systemHealth.freshThreads === args.threadHealth.length
            ? null
            : 'At least one live contract thread is stale or degraded.',
        steps: [
          'Select the preferred outpoint for each live thread.',
          'Warn when multiple live outputs are discovered for the same thread.',
          'Fail closed when a thread does not resolve or returns a capability mismatch.',
        ],
        requirements: ['Live thread health', 'Preferred outpoint per thread'],
        warnings: threadWarningList,
      }),
      buildSubplan({
        name: 'Period freshness',
        summary: 'Compare the live chain period to the stability-pool state before enabling writes.',
        ready: args.market.periodDeltaPeriods === 0,
        blockedReason:
          args.market.periodDeltaPeriods == null
            ? 'Chain height or live period state is unavailable.'
            : args.market.periodDeltaPeriods === 0
              ? null
              : 'The stability pool period is not synchronized with the chain tip.',
        steps: [
          'Read the live chain height.',
          'Derive the expected system period from the deployment parameters.',
          'Block writes until the stability pool catches up.',
        ],
        requirements: ['Chain height', 'Deployment period parameters'],
        warnings: [
          'Borrowers may tolerate stale borrowing threads, but the stability pool must stay synchronized.',
        ],
      }),
    ],
  };

  return {
    loan: loanPlan,
    pool: poolPlan,
    redemption: redemptionPlan,
    operator: operatorPlan,
  };
}

export function buildDefaultSystemHealth(
  threadHealth: ParyonThreadHealth[]
): ParyonSystemHealth {
  return threadFreshnessSummary(threadHealth);
}
