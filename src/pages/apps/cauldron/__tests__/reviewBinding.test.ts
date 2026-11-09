import { describe, expect, it } from 'vitest';
import {
  matchesReviewedPoolTransaction,
  matchesReviewedTradeQuote,
} from '../reviewBinding';

function build(fee = 100n, output = 900n) {
  return {
    estimatedFeeSatoshis: fee,
    signRequest: {
      transaction: {
        transaction: {
          version: 2,
          locktime: 0,
          inputs: [
            {
              outpointTransactionHash: new Uint8Array(32).fill(1),
              outpointIndex: 0,
              sequenceNumber: 0xffffffff,
              unlockingBytecode: new Uint8Array(),
            },
          ],
          outputs: [
            { lockingBytecode: new Uint8Array([0x51]), valueSatoshis: output },
          ],
        },
      },
    },
  };
}

describe('Cauldron pool review binding', () => {
  it('accepts a byte-identical rebuild', () => {
    expect(matchesReviewedPoolTransaction(build(), build())).toBe(true);
  });

  it('requires another review when fee, output, or selected outpoint changes', () => {
    const reviewed = build();
    expect(matchesReviewedPoolTransaction(reviewed, build(101n))).toBe(false);
    expect(matchesReviewedPoolTransaction(reviewed, build(100n, 899n))).toBe(
      false
    );
    const changedInput = build();
    changedInput.signRequest.transaction.transaction.inputs[0].outpointIndex = 1;
    expect(matchesReviewedPoolTransaction(reviewed, changedInput)).toBe(false);
  });
});

describe('Cauldron swap quote binding', () => {
  it('requires another review for any changed quote amount or signed transaction', () => {
    const reviewed = { ...build(), totalSupply: 1_000n, totalDemand: 900n };
    expect(
      matchesReviewedTradeQuote(reviewed, {
        ...build(),
        totalSupply: 1_000n,
        totalDemand: 900n,
      })
    ).toBe(true);
    expect(
      matchesReviewedTradeQuote(reviewed, {
        ...build(),
        totalSupply: 1_001n,
        totalDemand: 900n,
      })
    ).toBe(false);
    expect(
      matchesReviewedTradeQuote(reviewed, {
        ...build(),
        totalSupply: 1_000n,
        totalDemand: 901n,
      })
    ).toBe(false);
    expect(
      matchesReviewedTradeQuote(reviewed, {
        ...build(100n, 899n),
        totalSupply: 1_000n,
        totalDemand: 900n,
      })
    ).toBe(false);
  });
});
