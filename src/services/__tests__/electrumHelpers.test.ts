import { describe, expect, it } from 'vitest';

import {
  deriveFeeSats,
  isTransactionHistoryArray,
  mapUtxoRows,
  normalizeParticipantRows,
  toVisibilityFromResponse,
} from '../electrum/helpers';

describe('electrumHelpers', () => {
  it('normalizes participant rows defensively', () => {
    expect(
      normalizeParticipantRows([
        { address: 'bitcoincash:q1', amountSats: 100, outputIndex: 0 },
        { address: 123, amountSats: 'bad' },
      ])
    ).toEqual([
      { address: 'bitcoincash:q1', amountSats: 100, outputIndex: 0 },
      { address: 'Unknown', amountSats: undefined, outputIndex: undefined },
    ]);
  });

  it('maps UTXO rows and preserves token normalization inputs', () => {
    expect(
      mapUtxoRows('bitcoincash:q1', [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 1,
          value: 546,
          height: 12,
          token_data: { category: 'cat', amount: 5 },
        },
      ])
    ).toEqual([
      expect.objectContaining({
        address: 'bitcoincash:q1',
        tx_hash: 'a'.repeat(64),
        tx_pos: 1,
        value: 546,
        amount: 546,
        height: 12,
      }),
    ]);
  });

  it('derives fee from known inputs and outputs when explicit fee is missing', () => {
    expect(
      deriveFeeSats(undefined, [{ address: 'in', amountSats: 200 }], [
        { address: 'out', amountSats: 150 },
      ])
    ).toBe(50);
  });

  it('classifies transaction history and visibility responses', () => {
    expect(isTransactionHistoryArray([{ tx_hash: 'abc', height: 1 }])).toBe(true);
    expect(isTransactionHistoryArray([{ tx_hash: 'abc' } as never])).toBe(false);

    expect(toVisibilityFromResponse('ok')).toEqual({ seen: true, confirmed: false });
    expect(toVisibilityFromResponse({ confirmations: 0, height: 0 })).toEqual({
      seen: true,
      confirmed: false,
    });
  });
});
