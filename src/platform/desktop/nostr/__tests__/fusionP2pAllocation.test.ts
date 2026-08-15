import { describe, expect, it } from 'vitest';

import { planP2pOutputValues } from '../fusionP2pAllocation';
import {
  assembleFusionTx,
  verifyFusionSafety,
  type FusionInputRef,
  type PeerContribution,
} from '../fusionRound';

const pubkey = `02${'11'.repeat(32)}`;

function input(seed: string, value: number): FusionInputRef {
  return {
    prevTxid: seed.repeat(64),
    prevIndex: 0,
    value,
    pubkey,
  };
}

describe('P2P Fusion output allocation', () => {
  it('assigns the unequal-wallet remainder to outputs instead of a 29,999,124 sat fee', () => {
    const inputs = [input('a', 700_000_000), input('b', 130_000_000), input('c', 130_000_000)];
    const random = [0.9, 0.1, 0.7, 0.3, 0.8, 0.2, 0.6, 0.4];
    let cursor = 0;
    const contributions: PeerContribution[] = inputs.map((mine, peerIndex) => {
      const plan = planP2pOutputValues({
        inputs: [mine],
        participantCount: inputs.length,
        feerate: 1_000,
        randomUnit: () => random[(cursor++ + peerIndex) % random.length],
      });
      expect(plan.values.length).toBeGreaterThanOrEqual(2);
      expect(plan.values.length).toBeLessThanOrEqual(6);
      expect(plan.values.every((value) => value >= 10_000)).toBe(true);
      expect(plan.values.reduce((sum, value) => sum + value, 0)).toBe(
        mine.value - plan.feeShare
      );
      return {
        inputs: [mine],
        outputs: plan.values.map((value, outputIndex) => ({
          script: `76a914${(peerIndex * 10 + outputIndex)
            .toString(16)
            .padStart(40, '0')}88ac`,
          value,
        })),
      };
    });

    const assembled = assembleFusionTx(contributions);
    const fee =
      assembled.inputs.reduce((sum, item) => sum + item.value, 0) -
      assembled.outputs.reduce((sum, item) => sum + item.value, 0);
    expect(fee).toBeLessThan(2_000);
    contributions.forEach((mine) =>
      expect(verifyFusionSafety(assembled, mine, 1_000).ok).toBe(true)
    );
  });

  it('fails before registration when two non-dust outputs plus a normal fee do not fit', () => {
    expect(() =>
      planP2pOutputValues({
        inputs: [input('d', 20_100)],
        participantCount: 2,
        feerate: 1_000,
        randomUnit: () => 0.5,
      })
    ).toThrow(/two Fusion outputs/i);
  });
});
