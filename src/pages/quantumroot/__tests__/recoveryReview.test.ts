import { describe, expect, it } from 'vitest';
import { createQuantumrootRecoveryReview } from '../recoveryReview';

const utxo = (value: number, tx_hash: string) => ({
  tx_hash,
  tx_pos: 0,
  value,
  amount: value,
  height: 1,
});

describe('Quantumroot recovery review', () => {
  it('records verified input, fee, destination, and recovery totals', () => {
    const review = createQuantumrootRecoveryReview({
      kind: 'sweep',
      destinationAddress: 'bchtest:qz0example',
      sweptUtxos: [utxo(80_000, 'a'.repeat(64)), utxo(50_000, 'b'.repeat(64))],
      feeSats: 2_000n,
      recoveryAmountSats: 128_000n,
      rawTransaction: '00aa',
      transactionByteLength: 2,
    });

    expect(review.inputSats).toBe(130_000n);
    expect(review.feeSats).toBe(2_000n);
    expect(review.recoveryAmountSats).toBe(128_000n);
    expect(review.destinationAddress).toBe('bchtest:qz0example');
  });

  it('rejects totals that do not match the selected inputs', () => {
    expect(() =>
      createQuantumrootRecoveryReview({
        kind: 'spend',
        destinationAddress: 'bchtest:qz0example',
        sweptUtxos: [utxo(80_000, 'a'.repeat(64))],
        feeSats: 2_000n,
        recoveryAmountSats: 70_000n,
        rawTransaction: '00aa',
        transactionByteLength: 2,
      })
    ).toThrow('totals could not be verified');
  });

  it('accounts for a protected successor output in authorized recovery', () => {
    const review = createQuantumrootRecoveryReview({
      kind: 'authorized',
      destinationAddress: 'bchtest:qz0example',
      sweptUtxos: [utxo(80_000, 'a'.repeat(64)), utxo(1_000, 'b'.repeat(64))],
      feeSats: 2_000n,
      recoveryAmountSats: 78_000n,
      reservedOutputSats: 1_000n,
      rawTransaction: '00aabb',
      transactionByteLength: 3,
    });

    expect(review.reservedOutputSats).toBe(1_000n);
    expect(review.inputSats).toBe(81_000n);
  });
});
