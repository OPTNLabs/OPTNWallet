import { describe, expect, it } from 'vitest';

import {
  analyzeFusionTx,
  compareTiers,
  type FusionInput,
  type FusionOutput,
} from '../fusionPrivacyAnalyzer';

function makeInputs(count: number, value: number): FusionInput[] {
  return Array.from({ length: count }, (_, i) => ({
    value,
    txid: `${'ab'.repeat(31)}${i.toString(16).padStart(2, '0')}`,
    index: 0,
  }));
}

function makeOutputs(count: number, value: number): FusionOutput[] {
  return Array.from({ length: count }, () => ({
    value,
    script: '76a914' + '00'.repeat(20) + '88ac',
  }));
}

describe('analyzeFusionTx', () => {
  it('returns high score for well-formed fusion tx', () => {
    const inputs = makeInputs(5, 100_000);
    const outputs = [
      { value: 50_000, script: '76a914' + 'aa'.repeat(20) + '88ac' },
      { value: 48_000, script: '76a914' + 'bb'.repeat(20) + '88ac' },
    ];
    const report = analyzeFusionTx({
      inputs,
      outputs,
      fee: 500,
      tier: 100_000,
      participantCount: 10,
    });
    expect(report.overallScore).toBeGreaterThan(50);
    expect(report.warnings.length).toBeLessThan(3);
  });

  it('warns when outputs have same script (reused address)', () => {
    const inputs = makeInputs(3, 50_000);
    const outputs = makeOutputs(3, 15_000); // all same script
    const report = analyzeFusionTx({
      inputs,
      outputs,
      fee: 300,
      tier: 50_000,
      participantCount: 8,
    });
    expect(report.inputOutputLinkage.uniqueScripts).toBe(1);
    expect(report.warnings.some((w) => w.includes('scripts'))).toBe(true);
  });

  it('detects tier leakage in fee pattern', () => {
    const inputs = makeInputs(2, 1_000_000);
    const outputs = makeOutputs(2, 500_000);
    // Fee exactly proportional to tier: 1_000_000 * 0.001 * 5 = 5000
    const report = analyzeFusionTx({
      inputs,
      outputs,
      fee: 5000,
      tier: 1_000_000,
      participantCount: 5,
    });
    expect(report.feePattern.tierLeakage).toBe(true);
  });
});

describe('compareTiers', () => {
  it('detects distinguishable tiers', () => {
    const tierA = 10_000;
    const tierB = 1_000_000;
    const outputsA = [{ value: 5_000, script: 'aa' }, { value: 6_000, script: 'bb' }];
    const outputsB = [{ value: 500_000, script: 'cc' }, { value: 600_000, script: 'dd' }];
    const result = compareTiers(tierA, tierB, outputsA, outputsB);
    expect(result.distinguishable).toBe(true);
    expect(result.valueOverlap).toBeLessThan(0.3);
  });

  it('detects overlapping tiers', () => {
    const tierA = 100_000;
    const tierB = 120_000;
    const outputsA = [{ value: 80_000, script: 'aa' }, { value: 100_000, script: 'bb' }];
    const outputsB = [{ value: 90_000, script: 'cc' }, { value: 110_000, script: 'dd' }];
    const result = compareTiers(tierA, tierB, outputsA, outputsB);
    expect(result.distinguishable).toBe(false);
  });
});
