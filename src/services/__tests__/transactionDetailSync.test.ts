import { describe, expect, it } from 'vitest';
import { planTransactionDetailRefresh } from '../transactionDetailSync';

describe('planTransactionDetailRefresh', () => {
  it('returns only new txids when there is no reorg', () => {
    const result = planTransactionDetailRefresh({
      previous: [
        { tx_hash: 'a', height: 10 },
        { tx_hash: 'b', height: 0 },
      ],
      next: [
        { tx_hash: 'a', height: 10 },
        { tx_hash: 'b', height: 0 },
        { tx_hash: 'c', height: 12 },
      ],
    });

    expect(result).toEqual({
      txidsToRefresh: ['c'],
      reorgDetected: false,
    });
  });

  it('flags reorg when a confirmed tx changes block height', () => {
    const result = planTransactionDetailRefresh({
      previous: [
        { tx_hash: 'a', height: 100 },
        { tx_hash: 'b', height: 0 },
      ],
      next: [
        { tx_hash: 'a', height: 99 },
        { tx_hash: 'b', height: 1 },
      ],
    });

    expect(result.reorgDetected).toBe(true);
    expect(result.txidsToRefresh).toEqual(['a', 'b']);
  });
});
