import { describe, expect, it, vi } from 'vitest';
import {
  recoverAddonOperation,
  recoverAndPersistAddonOperation,
} from '../AddonOperationRecovery';
import type { AddonExecutionOperation } from '../../AddonsSDK';

const operation: AddonExecutionOperation = {
  operationId: 'op-1',
  status: 'submission_unknown',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  proposalId: 'proposal-1',
  mode: 'wallet-submit',
  sessionId: 'session-1',
  grantRevision: 1,
};

describe('recoverAddonOperation', () => {
  it('updates unknown submissions from the host resolver', async () => {
    const resolve = vi.fn().mockResolvedValue({ status: 'confirmed' });
    const recovered = await recoverAddonOperation(
      operation,
      resolve,
      '2026-01-01T00:01:00.000Z'
    );
    expect(recovered.status).toBe('confirmed');
    expect(recovered.updatedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(resolve).toHaveBeenCalledWith(operation);
  });

  it('does not query already-final operations', async () => {
    const resolve = vi.fn();
    const confirmed = { ...operation, status: 'confirmed' as const };
    expect(await recoverAddonOperation(confirmed, resolve)).toEqual(confirmed);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('persists a recovered status before returning it', async () => {
    let current = operation;
    const store = {
      async get() { return current; },
      async put(next: AddonExecutionOperation) { current = next; },
    };
    const recovered = await recoverAndPersistAddonOperation(
      store,
      operation.operationId,
      async () => ({ status: 'mempool' }),
      '2026-01-01T00:02:00.000Z'
    );
    expect(recovered?.status).toBe('mempool');
    expect(current.status).toBe('mempool');
  });

  it('rejects malformed resolver output', async () => {
    await expect(
      recoverAddonOperation(
        operation,
        async () => ({ status: 'not-a-chain-state' } as never)
      )
    ).rejects.toThrow('invalid status');
  });

  it('rejects malformed recovery timestamps', async () => {
    await expect(
      recoverAddonOperation(operation, async () => ({
        status: 'confirmed',
        updatedAt: 'not-a-timestamp',
      }))
    ).rejects.toThrow('invalid timestamp');
  });

  it('rejects recovery timestamps older than the stored observation', async () => {
    await expect(
      recoverAddonOperation(operation, async () => ({
        status: 'mempool',
        updatedAt: '2025-12-31T23:59:59.000Z',
      }))
    ).rejects.toThrow(/moved backwards/i);
  });

  it('persists a new observation time while still unknown', async () => {
    let current = operation;
    let writes = 0;
    const store = {
      async get() {
        return current;
      },
      async put(next: AddonExecutionOperation) {
        writes += 1;
        current = next;
      },
    };
    await recoverAndPersistAddonOperation(
      store,
      operation.operationId,
      async () => ({ status: 'submission_unknown' }),
      '2026-01-01T00:03:00.000Z'
    );
    expect(writes).toBe(1);
    expect(current.updatedAt).toBe('2026-01-01T00:03:00.000Z');
  });

  it('rejects an invalid reconciliation timestamp before resolving', async () => {
    const resolve = vi.fn();
    await expect(
      recoverAddonOperation(operation, resolve, 'not-a-timestamp')
    ).rejects.toThrow(/invalid timestamp/i);
    expect(resolve).not.toHaveBeenCalled();
  });
});
