export type ParyonConfirmationAction = 'borrow' | 'stake' | 'redeem' | null;

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
