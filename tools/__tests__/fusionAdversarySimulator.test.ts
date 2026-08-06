import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  simulateSybil,
  simulateTiming,
  simulateChainAnalysis,
  simulateCoordinatorCollusion,
  simulateEclipse,
  runFullSimulation,
} from '../fusionAdversarySimulator';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('simulateSybil', () => {
  it('small attacker has low win probability', () => {
    const result = simulateSybil({ totalPeers: 20, attackerPeers: 2 });
    expect(result.winProbability).toBeCloseTo(0.1, 1);
    expect(result.riskLevel).toBe('low');
    expect(result.canSteal).toBe(false);
  });

  it('large attacker has high win probability', () => {
    const result = simulateSybil({ totalPeers: 10, attackerPeers: 5 });
    expect(result.winProbability).toBe(0.5);
    expect(result.riskLevel).toBe('critical');
  });

  it('attacker cannot steal even when coordinating', () => {
    const result = simulateSybil({ totalPeers: 5, attackerPeers: 4 });
    expect(result.canSteal).toBe(false);
    expect(result.learnsFullMapping).toBe(true);
  });
});

describe('simulateTiming', () => {
  it('uniform jitter makes timing uncorrelated', () => {
    const result = simulateTiming({
      peerCount: 10,
      inputsPerPeer: 3,
    });
    expect(result.correlationPossible).toBe(false);
    expect(result.attackAccuracy).toBeLessThan(0.2);
  });

  it('more peers reduces accuracy', () => {
    const few = simulateTiming({ peerCount: 5, inputsPerPeer: 3 });
    const many = simulateTiming({ peerCount: 20, inputsPerPeer: 3 });
    expect(many.attackAccuracy).toBeLessThan(few.attackAccuracy);
  });
});

describe('simulateChainAnalysis', () => {
  it('overlapping tiers are not distinguishable', () => {
    // Deterministic samples spanning each tier's full band so ranges overlap
    // (Math.random() alone was flaky under CI: sparse samples can de-overlap).
    let step = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      step += 1;
      return step % 2 === 0 ? 0.05 : 0.95;
    });
    const result = simulateChainAnalysis({
      tiers: [100_000, 120_000, 150_000],
      outputsPerTier: 10,
      participantsPerRound: 10,
    });
    expect(result.tierLeakage).toBe(false);
  });

  it('widely separated tiers may leak', () => {
    const result = simulateChainAnalysis({
      tiers: [10_000, 1_000_000],
      outputsPerTier: 3,
      participantsPerRound: 5,
    });
    // Few outputs per tier + few participants = more leakage risk
    expect(result.outputCount).toBe(6);
  });
});

describe('simulateCoordinatorCollusion', () => {
  it('coordinator learns mapping but cannot steal', () => {
    const result = simulateCoordinatorCollusion({
      participantCount: 10,
    });
    expect(result.learnsInputOutputMapping).toBe(true);
    expect(result.canStealFunds).toBe(false);
    expect(result.canForgeSignatures).toBe(false);
  });

  it('per-component submission prevents cross-round linkage', () => {
    const withPc = simulateCoordinatorCollusion({
      participantCount: 10,
      usePerComponentSubmission: true,
    });
    const withoutPc = simulateCoordinatorCollusion({
      participantCount: 10,
      usePerComponentSubmission: false,
    });
    expect(withPc.crossRoundLinkage).toBe(false);
    expect(withoutPc.crossRoundLinkage).toBe(true);
  });
});

describe('simulateEclipse', () => {
  it('controlling few relays has low isolation probability', () => {
    const result = simulateEclipse({
      controlledRelays: 1,
      totalRelays: 10,
    });
    expect(result.isolationProbability).toBeCloseTo(0.001, 2);
    expect(result.canIsolate).toBe(false);
  });

  it('controlling many relays increases risk', () => {
    const result = simulateEclipse({
      controlledRelays: 8,
      totalRelays: 10,
      victimRelayConnections: 2,
    });
    expect(result.isolationProbability).toBeGreaterThan(0.5);
    expect(result.riskLevel).toBe('critical');
  });
});

describe('runFullSimulation', () => {
  it('produces a complete report', () => {
    const report = runFullSimulation({
      totalPeers: 20,
      attackerPeers: 3,
      inputsPerPeer: 5,
      tiers: [50_000, 100_000, 200_000],
      outputsPerTier: 4,
      controlledRelays: 2,
      totalRelays: 10,
    });
    expect(report.sybil).toBeDefined();
    expect(report.timing).toBeDefined();
    expect(report.chainAnalysis).toBeDefined();
    expect(report.coordinatorCollusion).toBeDefined();
    expect(report.eclipse).toBeDefined();
    expect(['low', 'medium', 'high', 'critical']).toContain(report.overallRisk);
  });
});
