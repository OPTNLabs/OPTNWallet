import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAddonDurableStores } from '../AddonDurableStorage';
import type { AddonTransactionProposal } from '../../AddonsSDK';

const { values, encryptText, decryptText } = vi.hoisted(() => ({
  values: new Map<string, string>(),
  encryptText: vi.fn(async (value: string) => `enc:${value}`),
  decryptText: vi.fn(async (value: string) => value.slice(4)),
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => values.get(key)),
  set: vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  }),
}));

vi.mock('../../SecretCryptoService', () => ({
  default: { encryptText, decryptText },
}));

const proposal: AddonTransactionProposal = {
  proposalId: 'proposal-1',
  commitmentHex: 'a'.repeat(64),
  walletId: 7,
  network: 'chipnet',
  sessionId: 'session-1',
  grantRevision: 1,
  authorityEpoch: 1,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  inputs: [],
  outputs: [{ recipientAddress: 'bitcoincash:qrecipient', amount: 123n }],
  contract: {
    contractId: 'c'.repeat(64),
    contractAddress: 'bitcoincash:qcontract',
    artifact: { contractName: 'Demo', bytecode: 'OP_TRUE' },
    constructorArgs: [{ type: 'int', value: '1' }],
    functionName: 'spend',
    functionArgs: [{ type: 'sig', signer: { address: 'bitcoincash:qsigner', purpose: 'wallet-spend' } }],
    contractInputIndexes: [0],
  },
  status: 'proposed',
};

describe('AddonDurableStorage', () => {
  beforeEach(() => values.clear());

  it('scopes encrypted proposal records by wallet, addon, and network', async () => {
    const first = createAddonDurableStores({
      walletId: 7,
      addonId: 'example.addon',
      network: 'chipnet',
    });
    await first.proposalStore.put({
      proposal,
      requestCommitmentHex: 'b'.repeat(64),
    });

    const sameScope = createAddonDurableStores({
      walletId: 7,
      addonId: 'example.addon',
      network: 'chipnet',
    });
    expect(await sameScope.proposalStore.get('proposal-1')).toMatchObject({
      proposalId: 'proposal-1',
      outputs: [{ amount: 123n }],
      contract: { contractId: 'c'.repeat(64), contractInputIndexes: [0] },
    });

    const otherAddon = createAddonDurableStores({
      walletId: 7,
      addonId: 'other.addon',
      network: 'chipnet',
    });
    expect(await otherAddon.proposalStore.get('proposal-1')).toBeUndefined();
    expect(
      [...values.values()].every((value) => value.startsWith('enc:'))
    ).toBe(true);
    expect(
      [...values.values()].every((value) => value.includes('example.addon'))
    ).toBe(true);
  });

  it('accepts a host-provided cross-context lock', async () => {
    let lockCalls = 0;
    const lock = {
      crossContext: true,
      async withLock<T>(task: () => Promise<T>) {
        lockCalls += 1;
        return task();
      },
    };
    const stores = createAddonDurableStores(
      { walletId: 7, addonId: 'locked.addon', network: 'chipnet' },
      { lock }
    );
    await stores.proposalStore.put({
      proposal,
      requestCommitmentHex: 'b'.repeat(64),
    });
    await stores.operationStore.put({
      operationId: 'operation-1',
      status: 'submission_unknown',
      createdAt: proposal.createdAt,
      updatedAt: proposal.createdAt,
      proposalId: proposal.proposalId,
      mode: 'wallet-submit',
      sessionId: proposal.sessionId,
      grantRevision: proposal.grantRevision,
    });
    expect(lockCalls).toBeGreaterThan(0);
    expect(lockCalls).toBeGreaterThanOrEqual(2);
  });

  it('fails closed when cross-context locking is required but unavailable', () => {
    expect(() =>
      createAddonDurableStores(
        { walletId: 7, addonId: 'unsafe.addon', network: 'chipnet' },
        {
          lock: { crossContext: false, withLock: async (task) => task() },
          requireCrossContextLock: true,
        }
      )
    ).toThrow('Cross-context locking is required');
  });
});
