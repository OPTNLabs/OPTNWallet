import { describe, expect, it } from 'vitest';

import { findMerchantPaymentObservation } from '../merchantPaymentMonitoring';

const tokenId = 'ab'.repeat(32);
const proposal = {
  tokenId,
  tokenAmountAtomic: 1_000n,
};

function createUtxo(overrides: Record<string, unknown> = {}) {
  return {
    address: 'bitcoincash:zmerchant',
    height: 0,
    tx_hash: 'cd'.repeat(32),
    tx_pos: 2,
    value: 546,
    token: {
      category: tokenId,
      amount: 1_000,
    },
    ...overrides,
  };
}

describe('merchantPaymentMonitoring', () => {
  it('recognizes an exact pending merchant output', () => {
    expect(
      findMerchantPaymentObservation({
        utxos: [createUtxo()],
        baselineOutpoints: [],
        proposal,
      })
    ).toMatchObject({
      status: 'pending',
      txid: 'cd'.repeat(32),
      outpoint: `${'cd'.repeat(32)}:2`,
    });
  });

  it('recognizes confirmation from a positive chain height', () => {
    expect(
      findMerchantPaymentObservation({
        utxos: [createUtxo({ height: 123 })],
        baselineOutpoints: [],
        proposal,
      })?.status
    ).toBe('confirmed');
  });

  it('ignores baseline, wrong-category, and wrong-amount outputs', () => {
    const baselineTxid = 'ef'.repeat(32);
    expect(
      findMerchantPaymentObservation({
        utxos: [
          createUtxo({ tx_hash: baselineTxid }),
          createUtxo({
            tx_hash: '01'.repeat(32),
            token: { category: '02'.repeat(32), amount: 1_000 },
          }),
          createUtxo({
            tx_hash: '03'.repeat(32),
            token: { category: tokenId, amount: 999 },
          }),
        ],
        baselineOutpoints: [`${baselineTxid}:2`],
        proposal,
      })
    ).toBeNull();
  });
});
