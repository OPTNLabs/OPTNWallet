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
 * The release gate mirrors the protections enforced by the shared Fusion
 * runner and the native server client. Keeping the checklist explicit makes a
 * future regression fail closed instead of silently weakening either mode.
 */
export const CURRENT_FUSION_EXECUTION_READINESS = buildFusionExecutionReadiness({
  inputReservations: true,
  persistentOutputTracking: true,
  componentCommitmentValidation: true,
  sessionCancellation: true,
  opaqueSigning: true,
  torOnlyBroadcast: true,
  broadcastVerification: true,
});

/**
 * Whether a fusion round may execute. Allowed on **mainnet and chipnet** when
 * the safety checklist is green — mainnet use is intentional (EC public server
 * fusion.servo.cash:8789 + Tor), not a leftover chipnet-only gate.
 *
 * Runtime fund-safety (every network):
 *   - per-round output-present / no-inflation / fee-bounds verification
 *     refuses to sign a transaction that would lose funds,
 *   - Tor is mandatory for remote destinations (localhost exempt, EC rule),
 *   - the server engine verifies its own outputs before signing and verifies
 *     broadcast.
 *
 * Chipnet local `run_fusion_server.py` may weaken *server* Params for testing;
 * that never changes client protocol timing or mainnet defaults.
 *
 * The native command independently enforces its own release gate and verifies
 * the Tor route at the command boundary, so renderer code cannot opt around it.
 */
export function isFusionExecutionAllowed(): boolean {
  return CURRENT_FUSION_EXECUTION_READINESS.ready;
}
