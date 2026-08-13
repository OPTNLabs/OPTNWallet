import { describe, expect, it } from 'vitest';

import {
  CURRENT_FUSION_EXECUTION_READINESS,
  buildFusionExecutionReadiness,
} from '../FusionExecutionSafety';

describe('CashFusion execution safety gate', () => {
  it('allows execution only when every wallet-safety prerequisite is present', () => {
    const readiness = buildFusionExecutionReadiness({
      inputReservations: true,
      persistentOutputTracking: true,
      componentCommitmentValidation: true,
      sessionCancellation: true,
      opaqueSigning: true,
      torOnlyBroadcast: true,
      broadcastVerification: true,
    });

    expect(readiness).toEqual({ ready: true, blockers: [] });
  });

  it('fails closed while a prerequisite is missing', () => {
    const readiness = buildFusionExecutionReadiness({
      inputReservations: false,
      persistentOutputTracking: false,
      componentCommitmentValidation: false,
      sessionCancellation: false,
      opaqueSigning: false,
      torOnlyBroadcast: false,
      broadcastVerification: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain('wallet-wide input reservation');
    expect(readiness.blockers).toContain('persistent fresh-output tracking');
    expect(readiness.blockers).toContain('full component-commitment and fee-integrity validation');
    expect(readiness.blockers).toContain('an opaque native signing boundary');
  });

  it('keeps the current product execution path paused', () => {
    expect(CURRENT_FUSION_EXECUTION_READINESS.ready).toBe(false);
    expect(CURRENT_FUSION_EXECUTION_READINESS.blockers.length).toBeGreaterThan(0);
  });
});
