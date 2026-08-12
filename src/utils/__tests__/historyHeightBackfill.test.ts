import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTransactionDetailsMock = vi.fn();
const getLatestBlockMock = vi.fn();
const applyConfirmedHeightMock = vi.fn();

vi.mock('../../services/ElectrumService', () => ({
  default: {
    getTransactionDetails: (...args: unknown[]) =>
      getTransactionDetailsMock(...args),
    getLatestBlock: (...args: unknown[]) => getLatestBlockMock(...args),
  },
}));

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    applyConfirmedHeight: (...args: unknown[]) =>
      applyConfirmedHeightMock(...args),
  }),
}));

import {
  backfillConfirmedHistoryHeights,
  resolveConfirmedBlockHeight,
} from '../../services/historyHeightBackfill';

describe('historyHeightBackfill', () => {
  beforeEach(() => {
    getTransactionDetailsMock.mockReset();
    getLatestBlockMock.mockReset();
    applyConfirmedHeightMock.mockReset();
    applyConfirmedHeightMock.mockResolvedValue(undefined);
  });

  it('resolveConfirmedBlockHeight derives tip - confs + 1', async () => {
    getLatestBlockMock.mockResolvedValue({ height: 1000 });
    await expect(
      resolveConfirmedBlockHeight({ confirmations: 10, height: undefined })
    ).resolves.toBe(991);
  });

  it('backfill writes height when Electrum only returns confirmations', async () => {
    const hash = 'a'.repeat(64);
    getTransactionDetailsMock.mockResolvedValue({
      txid: hash,
      confirmations: 50,
      height: undefined,
      timestamp: '2026-01-01T00:00:00.000Z',
      inputs: [],
      outputs: [],
    });
    getLatestBlockMock.mockResolvedValue({ height: 900_000 });

    const out = await backfillConfirmedHistoryHeights({
      walletId: 6,
      transactions: [{ tx_hash: hash, height: 0 }],
      forceRefresh: true,
    });

    expect(out[0]?.height).toBe(899_951);
    expect(applyConfirmedHeightMock).toHaveBeenCalledWith(
      6,
      hash,
      899_951,
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('skips rows that already have a positive height', async () => {
    const hash = 'b'.repeat(64);
    const out = await backfillConfirmedHistoryHeights({
      walletId: 6,
      transactions: [{ tx_hash: hash, height: 317_704 }],
    });
    expect(out[0]?.height).toBe(317_704);
    expect(getTransactionDetailsMock).not.toHaveBeenCalled();
  });
});
