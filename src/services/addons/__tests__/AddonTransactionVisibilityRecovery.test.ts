import { describe, expect, it, vi } from 'vitest';
import type { AddonExecutionOperation } from '../../AddonsSDK';
import { createAddonTransactionVisibilityRecoveryResolver } from '../AddonTransactionVisibilityRecovery';

const operation: AddonExecutionOperation = {
  operationId: 'operation-1',
  txid: 'a'.repeat(64),
  status: 'submission_unknown',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  proposalId: 'proposal-1',
  mode: 'wallet-submit',
  sessionId: 'session-1',
  grantRevision: 1,
};

describe('AddonTransactionVisibilityRecovery', () => {
  it('maps observed confirmed and mempool visibility', async () => {
    const getVisibility = vi
      .fn()
      .mockResolvedValueOnce({ seen: true, confirmed: true })
      .mockResolvedValueOnce({ seen: true, confirmed: false });
    const resolve =
      createAddonTransactionVisibilityRecoveryResolver(getVisibility);

    await expect(resolve(operation)).resolves.toEqual({ status: 'confirmed' });
    await expect(resolve(operation)).resolves.toEqual({ status: 'mempool' });
    expect(getVisibility).toHaveBeenNthCalledWith(1, 'a'.repeat(64));
  });

  it('keeps missing visibility unknown and does not infer rejection', async () => {
    const getVisibility = vi.fn().mockResolvedValue({
      seen: false,
      confirmed: false,
    });
    const resolve =
      createAddonTransactionVisibilityRecoveryResolver(getVisibility);

    await expect(resolve(operation)).resolves.toEqual({
      status: 'submission_unknown',
    });
  });

  it('keeps operations without a transaction id unknown', async () => {
    const getVisibility = vi.fn();
    const resolve =
      createAddonTransactionVisibilityRecoveryResolver(getVisibility);

    await expect(resolve({ ...operation, txid: undefined })).resolves.toEqual({
      status: 'submission_unknown',
    });
    expect(getVisibility).not.toHaveBeenCalled();
  });

  it('rejects malformed transaction ids before provider lookup', async () => {
    const getVisibility = vi.fn();
    const resolve = createAddonTransactionVisibilityRecoveryResolver(getVisibility);
    await expect(
      resolve({ ...operation, txid: 'not-a-txid' })
    ).rejects.toThrow(/invalid transaction id/i);
    expect(getVisibility).not.toHaveBeenCalled();
  });

  it('rejects malformed visibility responses', async () => {
    const resolve = createAddonTransactionVisibilityRecoveryResolver(
      async () => ({ seen: 'yes', confirmed: false } as never)
    );
    await expect(resolve(operation)).rejects.toThrow(/visibility response/i);
  });
});
