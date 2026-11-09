import type {
  AddonExecutionOperation,
  AddonOperationStore,
} from '../AddonsSDK';
import type { AddonStorageLock } from './AddonStorageLock';

export type AddonOperationStorage = {
  read(): Promise<PersistedAddonExecutionOperation[]>;
  write(operations: PersistedAddonExecutionOperation[]): Promise<void>;
  lock?: AddonStorageLock;
};

type PersistedAddonExecutionOperation = AddonExecutionOperation & {
  idempotencyKey?: string;
};

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function assertIdempotencyKey(key: string | undefined): void {
  if (
    key !== undefined &&
    (typeof key !== 'string' ||
      key.trim().length === 0 ||
      key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    throw new Error('Idempotency key is invalid');
  }
}

const storageQueues = new WeakMap<object, Promise<void>>();

function serialized<T>(storage: object, task: () => Promise<T>): Promise<T> {
  const previous = storageQueues.get(storage) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  storageQueues.set(
    storage,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
}

function critical<T>(storage: AddonOperationStorage, task: () => Promise<T>) {
  return storage.lock ? storage.lock.withLock(task) : task();
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Runtime-owned durable operation store. The add-on never receives the
 * storage object; hosts provide an encrypted/transactional implementation.
 */
export function createPersistentAddonOperationStore(
  storage: AddonOperationStorage,
  maxOperations = 512
): AddonOperationStore {
  const load = async () => {
    const records = await storage.read();
    if (
      !Array.isArray(records) ||
      records.some(
        (record) => record === null || typeof record !== 'object'
      )
    ) {
      throw new Error('Persisted add-on operations are corrupt');
    }
    const retained = records.slice(-Math.max(1, maxOperations));
    return new Map<string, PersistedAddonExecutionOperation>(
      retained.map((record) => [record.operationId, record])
    );
  };
  return {
    async list() {
      return serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          return [...records.values()];
        })
      );
    },
    async get(operationId) {
      return serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          return records.get(operationId);
        })
      );
    },
    async getByIdempotencyKey(key) {
      assertIdempotencyKey(key);
      return serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          return [...records.values()].find(
            (record) => record.idempotencyKey === key
          );
        })
      );
    },
    async getByProposalId(proposalId) {
      return serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          return [...records.values()].find(
            (record) => record.proposalId === proposalId
          );
        })
      );
    },
    async put(operation, idempotencyKey) {
      await serialized(storage, () =>
        critical(storage, async () => {
          assertIdempotencyKey(idempotencyKey);
          if (
            typeof operation.operationId !== 'string' ||
            operation.operationId.trim().length === 0 ||
            operation.operationId.length > 256
          ) {
            throw new Error('Operation identity is invalid');
          }
          if (
            !isValidTimestamp(operation.createdAt) ||
            !isValidTimestamp(operation.updatedAt)
          ) {
            throw new Error('Operation timestamps are invalid');
          }
          if (
            operation.txid !== undefined &&
            (typeof operation.txid !== 'string' ||
              !/^[0-9a-f]{64}$/.test(operation.txid))
          ) {
            throw new Error('Operation transaction ID is invalid');
          }
          const records = await load();
          const priorForOperation = records.get(operation.operationId);
          if (
            priorForOperation &&
            (priorForOperation.status === 'confirmed' ||
              priorForOperation.status === 'rejected') &&
            priorForOperation.status !== operation.status
          ) {
            throw new Error('Terminal operation status cannot be overwritten');
          }
          if (
            priorForOperation &&
            (priorForOperation.proposalId !== operation.proposalId ||
              priorForOperation.sessionId !== operation.sessionId ||
              priorForOperation.grantRevision !== operation.grantRevision ||
              priorForOperation.mode !== operation.mode ||
              (priorForOperation.txid !== undefined &&
                operation.txid !== undefined &&
                priorForOperation.txid !== operation.txid))
          ) {
            throw new Error(
              'Operation ID was already used for a different operation'
            );
          }
          const effectiveIdempotencyKey =
            idempotencyKey ?? priorForOperation?.idempotencyKey;
          if (effectiveIdempotencyKey) {
            const prior = [...records.values()].find(
              (record) => record.idempotencyKey === effectiveIdempotencyKey
            );
            if (prior && prior.proposalId !== operation.proposalId) {
              throw new Error(
                'Idempotency key was already used for another proposal'
              );
            }
            if (prior && prior.operationId !== operation.operationId) return;
          }
          const stored = {
            ...operation,
            ...(effectiveIdempotencyKey
              ? { idempotencyKey: effectiveIdempotencyKey }
              : {}),
          } as PersistedAddonExecutionOperation;
          records.set(operation.operationId, stored);
          const bounded = [...records.values()].slice(
            -Math.max(1, maxOperations)
          );
          await storage.write(bounded);
        })
      );
    },
  };
}
