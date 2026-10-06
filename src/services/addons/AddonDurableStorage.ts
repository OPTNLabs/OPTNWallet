import { get, set } from 'idb-keyval';
import type {
  AddonExecutionOperation,
  AddonProposalStore,
  AddonTransactionProposal,
  AddonOperationStore,
} from '../AddonsSDK';
import { createEncryptedAddonStorage } from './EncryptedAddonStorage';
import {
  createPersistentAddonOperationStore,
  type AddonOperationStorage,
} from './PersistentAddonOperationStore';
import {
  createPersistentAddonProposalStore,
  type AddonProposalStorage,
} from './PersistentAddonProposalStore';
import {
  createAddonStorageLock,
  type AddonStorageLock,
} from './AddonStorageLock';

const STORAGE_PREFIX = 'optn-addon-sdk-v1';

export type AddonDurableStorageScope = {
  walletId: number;
  addonId: string;
  network: string | null | undefined;
};

function storageKey(
  scope: AddonDurableStorageScope,
  kind: 'proposals' | 'operations'
): string {
  const network = scope.network ?? 'unknown';
  return [
    STORAGE_PREFIX,
    scope.walletId,
    encodeURIComponent(scope.addonId),
    encodeURIComponent(network),
    kind,
  ].join(':');
}

function scopeId(scope: AddonDurableStorageScope): string {
  return [scope.walletId, scope.addonId, scope.network ?? 'unknown'].join('|');
}

function encryptedStorage<T>(
  key: string,
  scope: string,
  lock: AddonStorageLock
) {
  return createEncryptedAddonStorage<T>(
    {
      lock,
      async read() {
        const value = await get<unknown>(key);
        return typeof value === 'string' ? value : null;
      },
      async write(value) {
        await set(key, value);
      },
    },
    { scope }
  );
}

/**
 * Creates wallet-owned durable SDK stores. The returned stores contain only
 * encrypted records; the backing IndexedDB keys and crypto service never cross
 * the add-on boundary.
 */
export function createAddonDurableStores(
  scope: AddonDurableStorageScope,
  limits?: {
    maxProposals?: number;
    maxOperations?: number;
    /** Native hosts may provide an atomic cross-context transaction lock. */
    lock?: AddonStorageLock;
    /** Reject process-local fallback locks when atomic cross-context storage is required. */
    requireCrossContextLock?: boolean;
  }
): {
  proposalStore: AddonProposalStore;
  operationStore: AddonOperationStore;
} {
  const proposalLock =
    limits?.lock ??
    createAddonStorageLock(`optn-addon-sdk:${storageKey(scope, 'proposals')}`);
  const operationLock =
    limits?.lock ??
    createAddonStorageLock(
      `optn-addon-sdk:${storageKey(scope, 'operations')}`
    );
  if (limits?.requireCrossContextLock) {
    if (!proposalLock.crossContext || !operationLock.crossContext) {
      throw new Error(
        'Cross-context locking is required for durable add-on storage'
      );
    }
  }
  const proposalStorage = encryptedStorage<AddonTransactionProposal>(
    storageKey(scope, 'proposals'),
    scopeId(scope),
    proposalLock
  ) as AddonProposalStorage;
  const operationStorage = encryptedStorage<AddonExecutionOperation>(
    storageKey(scope, 'operations'),
    scopeId(scope),
    operationLock
  ) as AddonOperationStorage;
  return {
    proposalStore: createPersistentAddonProposalStore(
      proposalStorage,
      limits?.maxProposals
    ),
    operationStore: createPersistentAddonOperationStore(
      operationStorage,
      limits?.maxOperations
    ),
  };
}
