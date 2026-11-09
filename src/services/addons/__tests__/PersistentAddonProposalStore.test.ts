import { describe, expect, it } from 'vitest';
import { createPersistentAddonProposalStore } from '../PersistentAddonProposalStore';
import type { AddonTransactionProposal } from '../../AddonsSDK';

const proposal: AddonTransactionProposal = {
  proposalId: 'proposal-1',
  commitmentHex: 'a'.repeat(64),
  walletId: 1,
  network: 'chipnet',
  sessionId: 'session-1',
  grantRevision: 1,
  authorityEpoch: 1,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  inputs: [],
  outputs: [],
  status: 'proposed',
};

describe('PersistentAddonProposalStore', () => {
  it('persists and reloads immutable proposals', async () => {
    let records: AddonTransactionProposal[] = [];
    const storage = {
      async read() {
        return structuredClone(records);
      },
      async write(next: AddonTransactionProposal[]) {
        records = structuredClone(next);
      },
    };
    const first = createPersistentAddonProposalStore(storage);
    await first.put({ proposal, requestCommitmentHex: 'b'.repeat(64) });
    const second = createPersistentAddonProposalStore(storage);
    expect(await second.get('proposal-1')).toMatchObject(proposal);
  });

  it('does not reuse an expired idempotency record', async () => {
    let records: AddonTransactionProposal[] = [
      { ...proposal, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    ];
    const store = createPersistentAddonProposalStore({
      async read() {
        return records;
      },
      async write(next) {
        records = next;
      },
    });
    const replacement = { ...proposal, proposalId: 'proposal-2' };
    const result = await store.put({
      proposal: replacement,
      idempotencyKey: 'same-key',
      requestCommitmentHex: 'c'.repeat(64),
    });
    expect(result.kind).toBe('stored');
  });

  it('does not expose proposals with malformed expiry timestamps', async () => {
    const store = createPersistentAddonProposalStore({
      async read() {
        return [{ ...proposal, expiresAt: 'not-a-timestamp' }];
      },
      async write() {},
    });
    expect(await store.get(proposal.proposalId)).toBeUndefined();
  });

  it('rejects malformed or expired proposals before writing', async () => {
    let writes = 0;
    const store = createPersistentAddonProposalStore({
      async read() {
        return [];
      },
      async write() {
        writes += 1;
      },
    });
    await expect(
      store.put({
        proposal: { ...proposal, expiresAt: 'not-a-timestamp' },
        requestCommitmentHex: 'd'.repeat(64),
      })
    ).rejects.toThrow(/expiry is invalid/i);
    expect(writes).toBe(0);
  });

  it('rejects malformed proposal identity before writing', async () => {
    const store = createPersistentAddonProposalStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({
        proposal: { ...proposal, commitmentHex: 'invalid' },
        requestCommitmentHex: 'd'.repeat(64),
      })
    ).rejects.toThrow(/proposal identity is invalid/i);
  });

  it('rejects empty or oversized idempotency keys', async () => {
    const store = createPersistentAddonProposalStore({
      async read() {
        return [];
      },
      async write() {},
    });
    await expect(
      store.put({
        proposal,
        requestCommitmentHex: 'b'.repeat(64),
        idempotencyKey: ' ',
      })
    ).rejects.toThrow(/idempotency key is invalid/i);
    await expect(
      store.put({
        proposal,
        requestCommitmentHex: 'b'.repeat(64),
        idempotencyKey: 'x'.repeat(257),
      })
    ).rejects.toThrow(/idempotency key is invalid/i);
  });

  it('fails clearly when the host proposal record is not an array', async () => {
    const store = createPersistentAddonProposalStore({
      async read() {
        return { corrupt: true } as never;
      },
      async write() {},
    });
    await expect(store.get('proposal-1')).rejects.toThrow(
      /proposals are corrupt/i
    );
  });

  it('rejects primitive proposal records inside an array', async () => {
    const store = createPersistentAddonProposalStore({
      async read() {
        return [null] as never;
      },
      async write() {},
    });
    await expect(store.get('proposal-1')).rejects.toThrow(
      /proposals are corrupt/i
    );
  });

  it('bounds records loaded from an overfull host store', async () => {
    const store = createPersistentAddonProposalStore(
      {
        async read() {
          return [
            { ...proposal, proposalId: 'proposal-old' },
            { ...proposal, proposalId: 'proposal-new' },
          ];
        },
        async write() {},
      },
      1
    );
    expect(await store.get('proposal-old')).toBeUndefined();
    expect(await store.get('proposal-new')).toMatchObject({
      proposalId: 'proposal-new',
    });
  });

  it('serializes concurrent idempotency checks before writing', async () => {
    let records: AddonTransactionProposal[] = [];
    const store = createPersistentAddonProposalStore({
      async read() {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return structuredClone(records);
      },
      async write(next) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        records = structuredClone(next);
      },
    });
    const first = { ...proposal, proposalId: 'proposal-first' };
    const second = { ...proposal, proposalId: 'proposal-second' };
    const results = await Promise.allSettled([
      store.put({
        proposal: first,
        idempotencyKey: 'same-key',
        requestCommitmentHex: 'c'.repeat(64),
      }),
      store.put({
        proposal: second,
        idempotencyKey: 'same-key',
        requestCommitmentHex: 'd'.repeat(64),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it('rejects reuse of a proposal ID with different immutable context', async () => {
    let records: AddonTransactionProposal[] = [];
    const store = createPersistentAddonProposalStore({
      async read() {
        return structuredClone(records);
      },
      async write(next) {
        records = structuredClone(next);
      },
    });
    await store.put({ proposal, requestCommitmentHex: 'b'.repeat(64) });
    await expect(
      store.put({
        proposal: { ...proposal, sessionId: 'different-session' },
        requestCommitmentHex: 'c'.repeat(64),
      })
    ).rejects.toThrow(/different proposal contents/i);
  });

  it('uses the host lock for cross-context read-modify-write protection', async () => {
    let lockCalls = 0;
    let records: AddonTransactionProposal[] = [];
    const store = createPersistentAddonProposalStore({
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
    await store.put({ proposal, requestCommitmentHex: 'd'.repeat(64) });
    expect(lockCalls).toBe(1);
  });
});
