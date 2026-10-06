import { describe, expect, it, vi } from 'vitest';
import type { AddonExecutionOperation } from '../../AddonsSDK';
import { recoverPersistedAddonOperations } from '../AddonOperationRecoveryCoordinator';

const unknown: AddonExecutionOperation = {
  operationId: 'op-unknown',
  txid: 'a'.repeat(64),
  status: 'submission_unknown',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  proposalId: 'proposal-1',
  mode: 'wallet-submit',
  sessionId: 'session-1',
  grantRevision: 1,
};

describe('AddonOperationRecoveryCoordinator', () => {
  it('reconciles all persisted unknown submissions and leaves final records untouched', async () => {
    const final: AddonExecutionOperation = {
      ...unknown,
      operationId: 'op-final',
      status: 'confirmed',
    };
    const records = [unknown, final];
    const put = vi.fn(async (next: AddonExecutionOperation) => {
      records.splice(
        records.findIndex((item) => item.operationId === next.operationId),
        1,
        next
      );
    });
    const store = {
      async list() {
        return records;
      },
      async get() {
        return undefined;
      },
      put,
    };
    const resolve = vi.fn(async (operation: AddonExecutionOperation) => {
      expect(operation.txid).toBe('a'.repeat(64));
      return { status: 'mempool' as const };
    });
    const result = await recoverPersistedAddonOperations(
      store,
      resolve,
      '2026-01-01T00:02:00.000Z'
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      operationId: 'op-unknown',
      status: 'mempool',
    });
    expect(put).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('isolates provider failures and continues with later unknown records', async () => {
    const second = { ...unknown, operationId: 'op-second' };
    const records = [unknown, second];
    const put = vi.fn(async (next: AddonExecutionOperation) => {
      records.splice(
        records.findIndex((item) => item.operationId === next.operationId),
        1,
        next
      );
    });
    const store = {
      async list() {
        return records;
      },
      async get() {
        return undefined;
      },
      put,
    };
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ status: 'mempool' as const });
    const onError = vi.fn(() => {
      throw new Error('telemetry unavailable');
    });

    const result = await recoverPersistedAddonOperations(
      store,
      resolve,
      new Date().toISOString(),
      onError
    );

    expect(result).toEqual([
      expect.objectContaining({
        operationId: 'op-unknown',
        status: 'submission_unknown',
      }),
      expect.objectContaining({ operationId: 'op-second', status: 'mempool' }),
    ]);
    expect(put).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op-unknown' }),
      expect.any(Error)
    );
  });
});
