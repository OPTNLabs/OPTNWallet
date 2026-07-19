/**
 * A deny-by-default guard for any code path that could start a CashFusion
 * round. The protocol client must not be exposed as a spending feature until
 * these wallet guarantees are implemented and independently reviewed.
 */
export interface FusionExecutionSafetyRequirements {
  inputReservations: boolean;
  persistentOutputTracking: boolean;
  componentCommitmentValidation: boolean;
  sessionCancellation: boolean;
  opaqueSigning: boolean;
  torOnlyBroadcast: boolean;
  broadcastVerification: boolean;
}

export interface FusionExecutionReadiness {
  ready: boolean;
  blockers: string[];
}

export function buildFusionExecutionReadiness(
  requirements: FusionExecutionSafetyRequirements
): FusionExecutionReadiness {
  const blockers: string[] = [];

  if (!requirements.inputReservations) blockers.push('wallet-wide input reservation');
  if (!requirements.persistentOutputTracking) blockers.push('persistent fresh-output tracking');
  if (!requirements.componentCommitmentValidation) blockers.push('full component-commitment and fee-integrity validation');
  if (!requirements.sessionCancellation) blockers.push('round cancellation on wallet, lock, and network changes');
  if (!requirements.opaqueSigning) blockers.push('an opaque native signing boundary');
  if (!requirements.torOnlyBroadcast) blockers.push('a Tor-only broadcast route');
  if (!requirements.broadcastVerification) blockers.push('broadcast and wallet-state verification');

  return { ready: blockers.length === 0, blockers };
}

/**
 * These capabilities do not exist yet. Keeping their status explicit and
 * local makes every manual, automatic, and P2P caller fail closed until each
 * condition has a real implementation behind it.
 */
export const CURRENT_FUSION_EXECUTION_READINESS = buildFusionExecutionReadiness({
  inputReservations: false,
  persistentOutputTracking: false,
  componentCommitmentValidation: false,
  sessionCancellation: false,
  opaqueSigning: false,
  torOnlyBroadcast: false,
  broadcastVerification: false,
});
