export type ParyonConfirmationAction = 'borrow' | 'stake' | 'redeem' | null;

type ParyonPreviewLike = {
  action: string;
  amountAtomic: bigint | null;
  amountLabel: string;
  primaryMetricLabel: string;
  primaryMetricValue: string;
  secondaryMetricLabel: string;
  secondaryMetricValue: string;
  details: string[];
  warnings: string[];
  canProceed: boolean;
  blockedReason: string | null;
};

export function canConfirmParyonAction(
  action: ParyonConfirmationAction,
  canProceed: boolean,
  writeEnabled: boolean
): boolean {
  return canProceed && (action === 'redeem' || writeEnabled);
}

export function paryonConfirmationLabel(
  action: ParyonConfirmationAction
): string {
  return action === 'redeem' ? 'Finish preview' : 'Confirm and broadcast';
}

/** Require the review to describe the same live preview at confirmation time. */
export function matchesParyonPreview(
  reviewed: ParyonPreviewLike | null,
  current: ParyonPreviewLike | null
): boolean {
  if (!reviewed || !current) return false;
  return (
    reviewed.action === current.action &&
    reviewed.amountAtomic === current.amountAtomic &&
    reviewed.amountLabel === current.amountLabel &&
    reviewed.primaryMetricLabel === current.primaryMetricLabel &&
    reviewed.primaryMetricValue === current.primaryMetricValue &&
    reviewed.secondaryMetricLabel === current.secondaryMetricLabel &&
    reviewed.secondaryMetricValue === current.secondaryMetricValue &&
    reviewed.blockedReason === current.blockedReason &&
    reviewed.canProceed === current.canProceed &&
    reviewed.details.join('\u0000') === current.details.join('\u0000') &&
    reviewed.warnings.join('\u0000') === current.warnings.join('\u0000')
  );
}
