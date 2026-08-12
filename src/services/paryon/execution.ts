import type {
  ParyonExecutionPlan,
  ParyonExecutionTarget,
  ParyonLiveMarketState,
  ParyonPositionRecord,
  ParyonWorkspaceSnapshot,
} from './types';
import type { ParyonNativeSnapshot } from './native';

function selectRecord(
  records: ParyonPositionRecord[],
  preferredStates: ParyonPositionRecord['state'][] = ['live', 'pending', 'locked']
): ParyonPositionRecord | null {
  for (const state of preferredStates) {
    const selected = records.find((record) => record.state === state);
    if (selected) return selected;
  }
  return records[0] ?? null;
}

function toTarget(record: ParyonPositionRecord | null): ParyonExecutionTarget | null {
  if (!record) return null;
  return {
    positionId: record.positionId,
    txHash: record.txHash,
    kind: record.kind,
    label: record.label,
    state: record.state,
  };
}

function baseExecutionPlan(args: {
  action: ParyonExecutionPlan['action'];
  ready: boolean;
  blockedReason: string | null;
  target: ParyonExecutionTarget | null;
  summary: string;
  outputTemplate: string[];
  validation: string[];
  warnings: string[];
}): ParyonExecutionPlan {
  return {
    action: args.action,
    ready: args.ready,
    blockedReason: args.blockedReason,
    target: args.target,
    summary: args.summary,
    outputTemplate: args.outputTemplate,
    validation: args.validation,
    warnings: args.warnings,
  };
}

function writeGateReason(
  snapshot: Pick<ParyonWorkspaceSnapshot, 'readiness' | 'verifiedMainnetV1'>,
  market: Pick<ParyonLiveMarketState, 'writeEnabled'>
): string | null {
  if (snapshot.readiness !== 'ready') return 'Deployment config is missing.';
  if (!snapshot.verifiedMainnetV1) return 'Live write flows are only enabled for verified mainnet-v1.';
  if (!market.writeEnabled) return 'Live contract threads or period freshness are stale.';
  return null;
}

export function buildParyonExecutionPlans(args: {
  snapshot: Pick<ParyonWorkspaceSnapshot, 'readiness' | 'verifiedMainnetV1'>;
  market: Pick<ParyonLiveMarketState, 'writeEnabled' | 'currentEpoch' | 'periodDeltaPeriods'>;
  nativeSnapshot: Pick<ParyonNativeSnapshot, 'positionIndex' | 'threadHealth' | 'systemHealth'>;
}): {
  borrow: ParyonExecutionPlan;
  manageLoan: ParyonExecutionPlan;
  stake: ParyonExecutionPlan;
  withdraw: ParyonExecutionPlan;
  claim: ParyonExecutionPlan;
  redeem: ParyonExecutionPlan;
  swap: ParyonExecutionPlan;
  finalize: ParyonExecutionPlan;
  cancel: ParyonExecutionPlan;
} {
  const gateReason = writeGateReason(args.snapshot, args.market);
  const loanRecord = selectRecord(args.nativeSnapshot.positionIndex.loans);
  const poolRecord = selectRecord(args.nativeSnapshot.positionIndex.stabilityPool);
  const redemptionRecord = selectRecord(args.nativeSnapshot.positionIndex.redemptions);
  const freshPrice = args.nativeSnapshot.threadHealth.find((thread) => thread.name === 'PriceContract')?.freshness === 'fresh';
  const freshBorrowing = args.nativeSnapshot.threadHealth.find((thread) => thread.name === 'Borrowing')?.freshness === 'fresh';
  const freshPool = args.nativeSnapshot.threadHealth.find((thread) => thread.name === 'StabilityPool')?.freshness === 'fresh';
  const freshRedeemer = args.nativeSnapshot.threadHealth.find((thread) => thread.name === 'Redeemer')?.freshness === 'fresh';

  return {
    borrow: baseExecutionPlan({
      action: 'borrow',
      ready: gateReason == null && freshPrice && freshBorrowing,
      blockedReason:
        gateReason ??
        (freshBorrowing
          ? freshPrice
            ? null
            : 'Borrowing needs a fresh PriceContract.'
          : 'Borrowing thread is not fresh.'),
      target: null,
      summary: 'Plan a new loan bundle with BCH collateral, loan-sidecar state, and loan-key authority.',
      outputTemplate: [
        'Borrowing contract',
        'PriceContract',
        'Loan bundle',
        'Loan sidecar',
        'Loan key output',
        'Borrowed PUSD output',
        'BCH change / protocol fee outputs',
      ],
      validation: [
        'Borrow minimum debt >= 100.00 PUSD',
        'Collateral >= 110% of borrowed value',
        'Fresh oracle price',
      ],
      warnings: [],
    }),
    manageLoan: baseExecutionPlan({
      action: 'manageLoan',
      ready: gateReason == null && freshBorrowing && loanRecord != null,
      blockedReason:
        gateReason ??
        (loanRecord ? (freshBorrowing ? null : 'Borrowing thread is not fresh.') : 'No live loan position is indexed yet.'),
      target: toTarget(loanRecord),
      summary: 'Plan repayment, collateral adjustment, or interest updates for the selected loan position.',
      outputTemplate: [
        'Loan input',
        'Loan sidecar input',
        'Manage/repay contract',
        'Updated loan output',
        'Updated sidecar output',
        'Change / fee outputs',
      ],
      validation: [
        'Loan position must be live',
        'Loan key authority must be in wallet control',
        'Repayment may not violate the debt floor',
      ],
      warnings: ['Repayment below 100.00 PUSD is only allowed during redemption completion.'],
    }),
    stake: baseExecutionPlan({
      action: 'stake',
      ready: gateReason == null && freshPool,
      blockedReason:
        gateReason ?? (freshPool ? null : 'StabilityPool thread is not fresh.'),
      target: null,
      summary: 'Plan a stability-pool stake with next-epoch receipt state.',
      outputTemplate: [
        'StabilityPool input',
        'StabilityPool sidecar input',
        'Receipt output',
        'PUSD stake output',
        'Change / payout outputs',
      ],
      validation: [
        'Stake minimum >= 100.00 PUSD',
        'Receipt unlocks at the next epoch',
      ],
      warnings: ['Withdrawals burn the full receipt; partial free-form exits are not supported.'],
    }),
    withdraw: baseExecutionPlan({
      action: 'withdraw',
      ready: gateReason == null && freshPool && poolRecord != null,
      blockedReason:
        gateReason ??
        (poolRecord ? (freshPool ? null : 'StabilityPool thread is not fresh.') : 'No live stability-pool position is indexed yet.'),
      target: toTarget(poolRecord),
      summary: 'Plan a full receipt burn and settle the wallet’s live stability-pool position.',
      outputTemplate: [
        'StabilityPool input',
        'StabilityPool sidecar input',
        'Withdraw contract',
        'Returned PUSD output',
        'BCH payout output',
        'Change output',
      ],
      validation: [
        'Receipt epoch must match the live pool epoch',
        'Withdrawal settles the full available position',
      ],
      warnings: ['Pro-rata liquidation adjustments are applied before payout.'],
    }),
    claim: baseExecutionPlan({
      action: 'claim',
      ready: gateReason == null && freshPool && args.market.currentEpoch != null,
      blockedReason:
        gateReason ??
        (args.market.currentEpoch != null
          ? freshPool
            ? null
            : 'StabilityPool thread is not fresh.'
          : 'Current epoch is unavailable from live chain data.'),
      target: toTarget(poolRecord),
      summary: 'Plan an epoch-bound claim from the payout contract.',
      outputTemplate: [
        'Payout input',
        'StabilityPool input',
        'Claim contract',
        'BCH payout output',
        'Change output',
      ],
      validation: ['Claim requires a live epoch boundary'],
      warnings: ['Claims do not bypass the pool receipt lifecycle.'],
    }),
    redeem: baseExecutionPlan({
      action: 'redeem',
      ready: gateReason == null && freshRedeemer && freshBorrowing,
      blockedReason:
        gateReason ??
        (freshRedeemer
          ? freshBorrowing
            ? null
            : 'Borrowing thread is not fresh.'
          : 'Redeemer thread is not fresh.'),
      target: toTarget(redemptionRecord),
      summary: 'Plan a redemption bundle that locks price and targets the lowest-interest loan route.',
      outputTemplate: [
        'Loan input',
        'Loan sidecar input',
        'Redeem contract',
        'Redemption contract',
        'Redemption sidecar',
        'Burn / payout outputs',
      ],
      validation: [
        'Redeem minimum >= 100.00 PUSD',
        'Target loans must satisfy the lowest-interest routing rule',
        'Finalization delay is 12 blocks',
      ],
      warnings: ['Redemption can swap or cancel near a period boundary.'],
    }),
    swap: baseExecutionPlan({
      action: 'swap',
      ready: gateReason == null && freshRedeemer && redemptionRecord != null,
      blockedReason:
        gateReason ??
        (redemptionRecord ? (freshRedeemer ? null : 'Redeemer thread is not fresh.') : 'No live redemption position is indexed yet.'),
      target: toTarget(redemptionRecord),
      summary: 'Plan a redemption retarget to a lower-interest live loan while the swap window is open.',
      outputTemplate: ['Redeemer input', 'Redemption output', 'Redemption sidecar output', 'Change output'],
      validation: ['Swap requires a live redemption position'],
      warnings: ['Swap preserves the existing redemption amount and payout destination.'],
    }),
    finalize: baseExecutionPlan({
      action: 'finalize',
      ready: gateReason == null && freshRedeemer && args.market.periodDeltaPeriods != null,
      blockedReason:
        gateReason ??
        (args.market.periodDeltaPeriods != null
          ? freshRedeemer
            ? null
            : 'Redeemer thread is not fresh.'
          : 'Chain period freshness is unavailable.'),
      target: toTarget(redemptionRecord),
      summary: 'Plan a redemption finalization after the 12-block timelock clears.',
      outputTemplate: ['Redeemer input', 'Redemption output', 'Redemption sidecar output', 'Payout output', 'Change output'],
      validation: ['Timelock must be satisfied before finalization'],
      warnings: ['Finalization may be replaced by cancel if the period boundary advances.'],
    }),
    cancel: baseExecutionPlan({
      action: 'cancel',
      ready: gateReason == null && freshRedeemer && redemptionRecord != null,
      blockedReason:
        gateReason ??
        (redemptionRecord ? (freshRedeemer ? null : 'Redeemer thread is not fresh.') : 'No live redemption position is indexed yet.'),
      target: toTarget(redemptionRecord),
      summary: 'Plan a redemption cancellation when the window has closed or the boundary has moved.',
      outputTemplate: ['Redeemer input', 'Redemption output', 'Redemption sidecar output', 'Returned PUSD output'],
      validation: ['Cancel only applies to pending redemption state'],
      warnings: ['Cancellation is a safety path, not the primary happy path.'],
    }),
  };
}
