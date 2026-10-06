import { describe, expect, it } from 'vitest';
import { createPersistentAddonOperationStore } from '../PersistentAddonOperationStore';
import type { AddonExecutionOperation } from '../../AddonsSDK';

const operation: AddonExecutionOperation = {
  operationId: 'op-1',
  status: 'submission_unknown',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  proposalId: 'proposal-1',
  mode: 'wallet-submit',
  sessionId: 'session-1',
  grantRevision: 1,
};

describe('PersistentAddonOperationStore', () => {
  it('round-trips operations and idempotency keys through host storage', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put(operation, 'request-1');
    expect(await store.list?.()).toHaveLength(1);
    expect(await store.get('op-1')).toMatchObject(operation);
    expect(await store.getByIdempotencyKey?.('request-1')).toMatchObject(
      operation
    );
  });

  it('bounds persisted operation history', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore(
      {
        async read() {
          return records;
        },
        async write(next) {
          records = next;
        },
      },
      1
    );
    await store.put(operation);
    await store.put({ ...operation, operationId: 'op-2' });
    expect(records.map((record) => record.operationId)).toEqual(['op-2']);
  });

  it('bounds records loaded from an overfull host store', async () => {
    const store = createPersistentAddonOperationStore(
      {
        async read() {
          return [
            { ...operation, operationId: 'op-old' },
            { ...operation, operationId: 'op-new' },
          ];
        },
        async write() {},
      },
      1
    );
    expect(await store.list?.()).toEqual([
      expect.objectContaining({ operationId: 'op-new' }),
    ]);
  });

  it('serializes concurrent writes against the same host storage', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return structuredClone(records);
      },
      async write(next) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        records = structuredClone(next);
      },
    });
    await Promise.all([
      store.put(operation, 'request-1'),
      store.put({ ...operation, operationId: 'op-2' }, 'request-2'),
    ]);
    expect(records.map((record) => record.operationId)).toEqual([
      'op-1',
      'op-2',
    ]);
  });

  it('preserves idempotency across recovery status updates', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put(operation, 'request-1');
    await store.put({ ...operation, status: 'mempool' });
    expect(await store.getByIdempotencyKey?.('request-1')).toMatchObject({
      status: 'mempool',
    });
  });

  it('rejects reuse of an operation ID with different immutable fields', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put(operation);
    await expect(
      store.put({ ...operation, proposalId: 'different-proposal' })
    ).rejects.toThrow(/different operation/i);
  });

  it('preserves terminal status across later recovery writes', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put({ ...operation, status: 'confirmed' });
    await expect(
      store.put({ ...operation, status: 'mempool' })
    ).rejects.toThrow(/terminal operation status/i);
  });

  it('does not replace an established transaction correlation', async () => {
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put({ ...operation, txid: 'a'.repeat(64) });
    await expect(
      store.put({ ...operation, txid: 'b'.repeat(64) })
    ).rejects.toThrow(/different operation/i);
  });

  it('rejects malformed transaction correlations', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({ ...operation, txid: 'not-a-txid' })
    ).rejects.toThrow(/transaction ID is invalid/i);
  });

  it('rejects a non-string transaction correlation from the host boundary', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({ ...operation, txid: Symbol('corrupt') as never })
    ).rejects.toThrow(/transaction ID is invalid/i);
  });

  it('rejects malformed operation timestamps before writing', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({ ...operation, updatedAt: 'not-a-timestamp' })
    ).rejects.toThrow(/timestamps are invalid/i);
  });

  it('rejects empty or oversized operation identities', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({ ...operation, operationId: ' '.repeat(1) })
    ).rejects.toThrow(/operation identity is invalid/i);
    await expect(
      store.put({ ...operation, operationId: 'x'.repeat(257) })
    ).rejects.toThrow(/operation identity is invalid/i);
  });

  it('rejects empty or oversized idempotency keys', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(store.put(operation, ' ')).rejects.toThrow(
      /idempotency key is invalid/i
    );
    await expect(store.put(operation, 'x'.repeat(257))).rejects.toThrow(
      /idempotency key is invalid/i
    );
    await expect(store.getByIdempotencyKey?.('')).rejects.toThrow(
      /idempotency key is invalid/i
    );
  });

  it('fails clearly when the host operation record is not an array', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return { corrupt: true } as never;
      },
      async write() {},
    });
    await expect(store.list?.()).rejects.toThrow(/operations are corrupt/i);
  });

  it('rejects primitive operation records inside an array', async () => {
    const store = createPersistentAddonOperationStore({
      async read() {
        return [null] as never;
      },
      async write() {},
    });
    await expect(store.list?.()).rejects.toThrow(/operations are corrupt/i);
  });

  it('uses the host lock around operation writes', async () => {
    let lockCalls = 0;
    let records: AddonExecutionOperation[] = [];
    const store = createPersistentAddonOperationStore({
      lock: {
        async withLock<T>(task: () => Promise<T>) {
          lockCalls += 1;
          return task();
        },
      },
      async read() {
        return records;
      },
      async write(next) {
        records = next;
      },
    });
    await store.put(operation, 'request-locked');
    expect(lockCalls).toBe(1);
  });
});
