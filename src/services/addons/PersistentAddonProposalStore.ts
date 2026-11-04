import type {
  AddonProposalStore,
  AddonTransactionProposal,
} from '../AddonsSDK';
import type { AddonStorageLock } from './AddonStorageLock';

export type AddonProposalStorage = {
  read(): Promise<AddonTransactionProposal[]>;
  write(proposals: AddonTransactionProposal[]): Promise<void>;
  lock?: AddonStorageLock;
};

const storageQueues = new WeakMap<object, Promise<void>>();
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

function critical<T>(storage: AddonProposalStorage, task: () => Promise<T>) {
  return storage.lock ? storage.lock.withLock(task) : task();
}

function isActiveExpiry(value: unknown, now = Date.now()): boolean {
  if (typeof value !== 'string') return false;
  const expiry = Date.parse(value);
  return Number.isFinite(expiry) && expiry > now;
}

/** Runtime-owned durable proposal storage with expiry and bounded retention. */
export function createPersistentAddonProposalStore(
  storage: AddonProposalStorage,
  maxProposals = 512
): AddonProposalStore {
  const load = async () => {
    const records = await storage.read();
    if (
      !Array.isArray(records) ||
      records.some(
        (record) => record === null || typeof record !== 'object'
      )
    ) {
      throw new Error('Persisted add-on proposals are corrupt');
    }
    const retained = records.slice(-Math.max(1, maxProposals));
    return new Map(retained.map((proposal) => [proposal.proposalId, proposal]));
  };
  return {
    async get(proposalId) {
      return serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          const proposal = records.get(proposalId);
          if (!proposal || !isActiveExpiry(proposal.expiresAt)) {
            return undefined;
          }
          return proposal;
        })
      );
    },
    async put({ proposal, idempotencyKey, requestCommitmentHex }) {
      return serialized(storage, () =>
        critical(storage, async () => {
          assertIdempotencyKey(idempotencyKey);
          if (
            typeof proposal.proposalId !== 'string' ||
            proposal.proposalId.trim().length === 0 ||
            proposal.proposalId.length > 256 ||
            typeof proposal.commitmentHex !== 'string' ||
            !/^[0-9a-f]{64}$/.test(proposal.commitmentHex) ||
            typeof requestCommitmentHex !== 'string' ||
            !/^[0-9a-f]{64}$/.test(requestCommitmentHex)
          ) {
            throw new Error('Addon proposal identity is invalid');
          }
          if (!isActiveExpiry(proposal.expiresAt)) {
            throw new Error('Addon proposal expiry is invalid or expired');
          }
          const records = await load();
          for (const [proposalId, existing] of records) {
            if (!isActiveExpiry(existing.expiresAt)) {
              records.delete(proposalId);
            }
          }
          const prior = records.get(proposal.proposalId);
          if (
            prior &&
            (prior.commitmentHex !== proposal.commitmentHex ||
              prior.walletId !== proposal.walletId ||
              prior.network !== proposal.network ||
              prior.sessionId !== proposal.sessionId ||
              prior.grantRevision !== proposal.grantRevision ||
              prior.authorityEpoch !== proposal.authorityEpoch)
          ) {
            throw new Error(
              'Proposal ID was already used for different proposal contents'
            );
          }
          if (idempotencyKey) {
            for (const existing of records.values()) {
              if (existing.proposalId === proposal.proposalId) continue;
              const marker = existing as AddonTransactionProposal & {
                idempotencyKey?: string;
                requestCommitmentHex?: string;
              };
              if (marker.idempotencyKey === idempotencyKey) {
                if (marker.requestCommitmentHex !== requestCommitmentHex) {
                  throw new Error(
                    'Idempotency key was already used for different proposal contents'
                  );
                }
                return { kind: 'existing', proposal: existing };
              }
            }
          }
          const stored = {
            ...proposal,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            requestCommitmentHex,
          } as AddonTransactionProposal & {
            idempotencyKey?: string;
            requestCommitmentHex: string;
          };
          records.set(proposal.proposalId, stored);
          const active = [...records.values()].filter(
            (item) => isActiveExpiry(item.expiresAt)
          );
          await storage.write(active.slice(-Math.max(1, maxProposals)));
          return { kind: 'stored', proposal };
        })
      );
    },
    async delete(proposalId) {
      await serialized(storage, () =>
        critical(storage, async () => {
          const records = await load();
          records.delete(proposalId);
          await storage.write([...records.values()]);
        })
      );
    },
  };
}
