import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createAddonSDK,
  type AddonExecutionOperation,
  type AddonTransactionProposal,
} from '../AddonsSDK';
import {
  createP2pkhExecutionAuthority,
  isP2pkhCashAddress,
  prepareP2pkhExecution,
} from '../addons/P2pkhExecutionAdapter';
import { prepareCashTokenExecution } from '../addons/CashTokenExecutionAdapter';
import type { AddonManifest } from '../../types/addons';
import KeyService from '../KeyService';
import BcmrService from '../BcmrService';

const {
  capacitorGetPlatformMock,
  capacitorIsNativePlatformMock,
  capacitorHttpGetMock,
} = vi.hoisted(() => ({
  capacitorGetPlatformMock: vi.fn(() => 'web'),
  capacitorIsNativePlatformMock: vi.fn(() => false),
  capacitorHttpGetMock: vi.fn(),
}));

vi.mock('../KeyService', () => ({
  default: {
    signMessageForAddress: vi.fn(),
    fetchAddressPrivateKey: vi.fn(),
  },
}));

vi.mock('../BcmrService', () => ({
  // `new BcmrService()` in the SDK: the implementation must be constructible.
  default: vi.fn().mockImplementation(function () {
    return {
      getSnapshot: vi.fn(),
      resolveIdentityRegistry: vi.fn(),
    };
  }),
}));

vi.mock(import('@capacitor/core'), async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@capacitor/core');
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: capacitorGetPlatformMock,
      isNativePlatform: capacitorIsNativePlatformMock,
    },
    CapacitorHttp: {
      ...actual.CapacitorHttp,
      get: capacitorHttpGetMock,
    },
  };
});

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: function () {
    return {
      addOutput: vi.fn(),
      buildTransaction: vi.fn(),
    };
  },
}));

const manifest: AddonManifest = {
  id: 'test.signing',
  name: 'Test Signing Addon',
  version: '1.0.0',
  permissions: [
    {
      kind: 'capabilities',
      capabilities: ['signing:message_sign'],
    },
  ],
  contracts: [],
};

describe('AddonsSDK signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs messages through the wallet key path', async () => {
    const signMessage = vi.fn().mockResolvedValue({
      signature: 'signed-message',
      raw: {
        ecdsa: 'ecdsa',
        schnorr: 'schnorr',
        der: 'der',
      },
      details: {
        recoveryId: 1,
        compressed: true,
        messageHash: 'hash',
      },
      privateKey: 'must-not-cross-boundary',
    });

    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qtestaddress']),
      appId: 'signing-app',
      signMessage,
      approveMessageSigning: vi.fn().mockResolvedValue(true),
    });

    const result = await sdk.signing.signMessage({
      address: 'bitcoincash:qtestaddress',
      message: 'hello world',
    });

    expect(signMessage).toHaveBeenCalledWith({
      address: 'bitcoincash:qtestaddress',
      message: 'hello world',
    });
    expect(result.address).toBe('bitcoincash:qtestaddress');
    expect(result.encoding).toBe('bch-signed-message');
    expect(result.signature).toBe('signed-message');
    expect(result).not.toHaveProperty('privateKey');
  });

  it('bounds a stalled wallet signer', async () => {
    vi.useFakeTimers();
    try {
      const signMessage = vi.fn(() => new Promise<never>(() => {}));
      const sdk = createAddonSDK(manifest, {
        walletId: 1,
        network: 'mainnet',
        walletAddresses: new Set(['bitcoincash:qtestaddress']),
        signMessage,
        approveMessageSigning: vi.fn().mockResolvedValue(true),
      });
      const pending = sdk.signing.signMessage({
        address: 'bitcoincash:qtestaddress',
        message: 'hello world',
      });
      const rejection = expect(pending).rejects.toThrow(
        /signing\.signMessage.*timed out|operation timed out.*signing\.signMessage/i
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(signMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses message signing for non-wallet addresses', async () => {
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
      appId: 'signing-app',
    });

    await expect(
      sdk.signing.signMessage({
        address: 'bitcoincash:qblocked',
        message: 'hello world',
      })
    ).rejects.toThrow('Addon attempted access to non-wallet address');
  });

  it('rejects oversized signing addresses before approval or signing', async () => {
    const signMessage = vi.fn();
    const approveMessageSigning = vi.fn().mockResolvedValue(true);
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
      signMessage,
      approveMessageSigning,
    });
    await expect(
      sdk.signing.signMessage({
        address: 'a'.repeat(257),
        message: 'hello world',
      })
    ).rejects.toThrow('Invalid address');
    expect(approveMessageSigning).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('refuses message signing when runtime authority is absent', async () => {
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
    });
    await expect(
      sdk.signing.signMessage({
        address: 'bitcoincash:qallowed',
        message: 'hello world',
      })
    ).rejects.toThrow(/message-signing authority is unavailable/i);
    expect(KeyService.signMessageForAddress).not.toHaveBeenCalled();
  });

  it('does not invoke the signer when message approval is denied', async () => {
    const signMessage = vi.fn();
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
      signMessage,
      approveMessageSigning: vi.fn().mockResolvedValue(false),
    });
    await expect(
      sdk.signing.signMessage({
        address: 'bitcoincash:qallowed',
        message: 'hello world',
      })
    ).rejects.toThrow(/rejected/i);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized messages before approval or signing', async () => {
    const signMessage = vi.fn();
    const approveMessageSigning = vi.fn().mockResolvedValue(true);
    const sdk = createAddonSDK(manifest, {
      walletId: 1,
      network: 'mainnet',
      walletAddresses: new Set(['bitcoincash:qallowed']),
      signMessage,
      approveMessageSigning,
    });

    await expect(
      sdk.signing.signMessage({ address: 'bitcoincash:qallowed', message: '' })
    ).rejects.toThrow(/between 1 and 8192/i);
    await expect(
      sdk.signing.signMessage({
        address: 'bitcoincash:qallowed',
        message: 'x'.repeat(8193),
      })
    ).rejects.toThrow(/between 1 and 8192/i);
    expect(approveMessageSigning).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('does not expose legacy key-bearing signing to third-party contexts', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.legacy-signing',
        name: 'Test Legacy Signing Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['signing:signature_template'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        walletAddresses: new Set(['bitcoincash:qallowed']),
      }
    );

    const legacySigning = sdk.signing as unknown as {
      signatureTemplateForAddress(address: string): Promise<unknown>;
    };
    await expect(
      legacySigning.signatureTemplateForAddress('bitcoincash:qallowed')
    ).rejects.toThrow(/key-bearing signing is unavailable/i);
    expect(KeyService.fetchAddressPrivateKey).not.toHaveBeenCalled();
  });
});

describe('AddonsSDK transaction proposals', () => {
  it('creates a public unsigned proposal without invoking wallet signing', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal',
        name: 'Test Proposal Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose'],
          },
        ],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );

    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 10000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 9000 } as never],
    });

    expect(proposal.status).toBe('proposed');
    expect(proposal.proposalId).toBe(
      `optn-proposal-v1:${proposal.commitmentHex}`
    );
    expect(proposal.commitmentHex).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.walletId).toBe(4);
    expect(proposal.network).toBe('chipnet');
    expect(proposal.inputs[0]?.valueSats).toBe('10000');
    expect(KeyService.fetchAddressPrivateKey).not.toHaveBeenCalled();

    const fetched = await sdk.tx.getProposal(proposal.proposalId);
    expect(fetched.commitmentHex).toBe(proposal.commitmentHex);
    fetched.inputs[0]!.address = 'bitcoincash:qmutated-copy';
    const fetchedAgain = await sdk.tx.getProposal(proposal.proposalId);
    expect(fetchedAgain.inputs[0]!.address).toBe('bitcoincash:qinput');
  });

  it('rejects duplicate proposal inputs and executable unlockers', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.validation',
        name: 'Test Proposal Validation Addon',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    const input = {
      address: 'bitcoincash:qinput',
      tx_hash: 'b'.repeat(64),
      tx_pos: 1,
      value: 10000,
      height: 1,
    };
    await expect(
      sdk.tx.propose({
        inputs: [input, input],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      })
    ).rejects.toThrow(/duplicate input/i);
    await expect(
      sdk.tx.propose({
        inputs: [{ ...input, unlocker: () => undefined }],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      })
    ).rejects.toThrow(/unlockers|callbacks/i);
    const nftProposal = await sdk.tx.propose({
      inputs: [input],
      outputs: [
        {
          recipientAddress: 'bitcoincash:qoutput',
          amount: 1,
          token: {
            category: 'c'.repeat(64),
            amount: 1,
            nft: { capability: 'none', commitment: '00' },
          },
        } as never,
      ],
    });
    expect(nftProposal.outputs[0]).toMatchObject({
      token: { nft: { capability: 'none', commitment: '00' } },
    });
    await expect(
      sdk.tx.propose({
        inputs: [
          {
            ...input,
            token: {
              category: 'c'.repeat(64),
              amount: 1,
              nft: { capability: 'none', commitment: '00' },
            },
          },
        ],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      })
    ).resolves.toMatchObject({
      inputs: [{ tokenNft: { capability: 'none', commitment: '00' } }],
    });
    const tokenIntentProposal = await sdk.tx.propose({
      inputs: [
        {
          ...input,
          token: {
            category: 'd'.repeat(64),
            amount: 0,
            nft: { capability: 'minting', commitment: '' },
          },
        },
      ],
      outputs: [
        {
          recipientAddress: 'bitcoincash:qoutput',
          amount: 9000,
          token: {
            category: 'd'.repeat(64),
            amount: 0,
            nft: { capability: 'minting', commitment: '' },
          },
        } as never,
        {
          recipientAddress: 'bitcoincash:qoutput',
          amount: 900,
          token: {
            category: 'd'.repeat(64),
            amount: 0,
            nft: { capability: 'none', commitment: 'aa' },
          },
        } as never,
      ],
      tokenIntent: {
        kind: 'mint-nft',
        category: 'd'.repeat(64),
        capability: 'none',
        commitment: 'aa',
      },
    });
    expect(tokenIntentProposal.tokenIntent).toEqual({
      kind: 'mint-nft',
      category: 'd'.repeat(64),
      capability: 'none',
      commitment: 'aa',
    });
  });

  it('does not expose proposals across SDK instances', async () => {
    const manifest = {
      id: 'test.proposal.scope',
      name: 'Test Proposal Scope',
      version: '1.0.0',
      permissions: [
        {
          kind: 'capabilities' as const,
          capabilities: ['tx:propose' as const],
        },
      ],
      contracts: [],
    };
    const first = createAddonSDK(manifest, { walletId: 4, network: 'chipnet' });
    const second = createAddonSDK(manifest, {
      walletId: 4,
      network: 'chipnet',
    });
    const proposal = await first.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'c'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(second.tx.getProposal(proposal.proposalId)).rejects.toThrow(
      /not found/i
    );
  });

  it('rejects malformed output amounts and token categories', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.output-validation',
        name: 'Test Proposal Output Validation',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
      }
    );
    const input = {
      address: 'bitcoincash:qinput',
      tx_hash: 'c'.repeat(64),
      tx_pos: 0,
      value: 10000,
      height: 1,
    };
    await expect(
      sdk.tx.propose({
        inputs: [input],
        outputs: [{ address: 'bitcoincash:qoutput', value: -1 } as never],
      })
    ).rejects.toThrow(/invalid BCH amount/i);
    await expect(
      sdk.tx.propose({
        inputs: [input],
        outputs: [
          {
            recipientAddress: 'bitcoincash:qoutput',
            amount: 1,
            token: { category: 'bad', amount: 1 },
          } as never,
        ],
      })
    ).rejects.toThrow(/invalid category/i);
  });

  it('rejects oversized proposal collections', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.bounds',
        name: 'Proposal Bounds',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    const inputs = Array.from({ length: 201 }, (_, index) => ({
      address: 'bitcoincash:qinput',
      tx_hash: index.toString(16).padStart(64, '0'),
      tx_pos: 0,
      value: 1,
      height: 1,
    }));
    await expect(
      sdk.tx.propose({
        inputs,
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      })
    ).rejects.toThrow(/exceeds 200 inputs/i);
  });

  it('rejects proposal inputs outside the host wallet allowlist', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.input-scope',
        name: 'Input Scope',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        walletAddresses: new Set(['bitcoincash:qowned']),
      }
    );
    await expect(
      sdk.tx.propose({
        inputs: [
          {
            address: 'bitcoincash:qother',
            tx_hash: '4'.repeat(64),
            tx_pos: 0,
            value: 1000,
            height: 1,
          },
        ],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      })
    ).rejects.toThrow(/outside the wallet address allowlist/i);
  });

  it('reuses an idempotent proposal and rejects changed contents', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.idempotency',
        name: 'Test Proposal Idempotency',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    const base = {
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'd'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      idempotencyKey: 'order-123',
    };
    const first = await sdk.tx.propose(base);
    const second = await sdk.tx.propose(base);
    expect(second.proposalId).toBe(first.proposalId);
    await expect(
      sdk.tx.propose({
        ...base,
        inputs: [{ ...base.inputs[0], value: 999 }],
      })
    ).rejects.toThrow(/different proposal contents/i);
  });

  it('bounds idempotency keys before persisting them', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.idempotency-limit',
        name: 'Idempotency Limit',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );

    await expect(
      sdk.tx.propose({
        inputs: [
          {
            address: 'bitcoincash:qinput',
            tx_hash: 'e'.repeat(64),
            tx_pos: 0,
            value: 1000,
            height: 1,
          },
        ],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
        idempotencyKey: 'k'.repeat(257),
      })
    ).rejects.toThrow(/between 1 and 256 characters/i);
  });

  it('blocks legacy build and broadcast for third-party contexts', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.legacy-execution',
        name: 'Test Legacy Execution Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:build', 'tx:broadcast'],
          },
        ],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    await expect(
      sdk.tx.build({ inputs: [], outputs: [], changeAddress: '' })
    ).rejects.toThrow(/legacy transaction execution is unavailable/i);
    await expect(sdk.tx.broadcast('00')).rejects.toThrow(
      /legacy transaction broadcast is unavailable/i
    );
  });

  it('delegates proposal execution to wallet authority without exposing builders', async () => {
    const lockRequest = vi.fn(
      async (_name: string, _options: unknown, task: () => Promise<unknown>) =>
        await task()
    );
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    const executeProposal = vi.fn().mockResolvedValue({
      operationId: 'op-1',
      status: 'awaiting_approval',
      privateKey: 'must-not-cross-boundary',
      internalSigner: { secret: 'must-not-cross-boundary' },
    });
    const approveExecution = vi.fn().mockResolvedValue(true);
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.execute',
        name: 'Test Proposal Execute',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
          },
        ],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet', executeProposal, approveExecution }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'e'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    const firstExecution = sdk.tx.requestExecution({
      proposalId: proposal.proposalId,
      mode: 'wallet-submit',
      idempotencyKey: 'execute-1',
    });
    const concurrentExecution = sdk.tx.requestExecution({
      proposalId: proposal.proposalId,
      mode: 'wallet-submit',
      idempotencyKey: 'execute-2',
    });
    const [operation, concurrentOperation] = await Promise.all([
      firstExecution,
      concurrentExecution,
    ]);
    expect(operation).toMatchObject({
      operationId: 'op-1',
      status: 'awaiting_approval',
      proposalId: proposal.proposalId,
      mode: 'wallet-submit',
    });
    expect(operation).not.toHaveProperty('privateKey');
    expect(operation).not.toHaveProperty('internalSigner');
    await expect(sdk.tx.getOperation('op-1')).resolves.toMatchObject({
      operationId: 'op-1',
      proposalId: proposal.proposalId,
    });
    expect(concurrentOperation).toMatchObject({ operationId: 'op-1' });
    expect(executeProposal).toHaveBeenCalledTimes(1);
    expect(executeProposal).toHaveBeenCalledWith({
      proposal,
      mode: 'wallet-submit',
      idempotencyKey: 'execute-1',
    });
    expect(approveExecution).toHaveBeenCalledWith({
      proposal,
      mode: 'wallet-submit',
    });
    expect(lockRequest).toHaveBeenCalledWith(
      expect.stringContaining(`optn-addon-execution:${proposal.proposalId}`),
      { mode: 'exclusive' },
      expect.any(Function)
    );
    vi.unstubAllGlobals();
  });

  it('rejects an invalid operation status from the wallet authority', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.invalid-operation',
        name: 'Invalid Operation',
        version: '1.0.0',
        permissions: [
          { kind: 'capabilities', capabilities: ['tx:propose', 'tx:execute'] },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        approveExecution: vi.fn().mockResolvedValue(true),
        executeProposal: vi.fn().mockResolvedValue({
          operationId: 'op-invalid',
          status: 'not-a-valid-status',
        }),
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'f'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/invalid operation/i);
  });

  it('rejects an oversized operation id from the wallet authority', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.oversized-operation',
        name: 'Oversized Operation',
        version: '1.0.0',
        permissions: [
          { kind: 'capabilities', capabilities: ['tx:propose', 'tx:execute'] },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        approveExecution: vi.fn().mockResolvedValue(true),
        executeProposal: vi.fn().mockResolvedValue({
          operationId: 'x'.repeat(257),
          status: 'mempool',
        }),
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/invalid operation/i);
  });

  it('journals submission unknown when authority execution times out', async () => {
    vi.useFakeTimers();
    try {
      const executeProposal = vi.fn(() => new Promise<never>(() => {}));
      const sdk = createAddonSDK(
        {
          id: 'test.proposal.timeout',
          name: 'Timeout Proposal',
          version: '1.0.0',
          permissions: [
            {
              kind: 'capabilities',
              capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
            },
          ],
          contracts: [],
        },
        {
          walletId: 5,
          network: 'chipnet',
          executeProposal,
          approveExecution: vi.fn().mockResolvedValue(true),
        }
      );
      const proposal = await sdk.tx.propose({
        inputs: [
          {
            address: 'bitcoincash:qinput',
            tx_hash: 'f'.repeat(64),
            tx_pos: 0,
            value: 1000,
            height: 1,
          },
        ],
        outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
      });
      const pending = sdk.tx.requestExecution({
        proposalId: proposal.proposalId,
        idempotencyKey: 'timeout-1',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({
        operationId: `optn-operation-v1:${proposal.commitmentHex}`,
        status: 'submission_unknown',
      });
      await expect(
        sdk.tx.requestExecution({
          proposalId: proposal.proposalId,
          idempotencyKey: 'timeout-2',
        })
      ).resolves.toMatchObject({ status: 'submission_unknown' });
      expect(executeProposal).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke wallet execution when approval is denied', async () => {
    const executeProposal = vi.fn();
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.denied',
        name: 'Denied Proposal',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        approveExecution: vi.fn().mockResolvedValue(false),
        executeProposal,
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: 'f'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/rejected/i);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('rejects execution when the wallet authority context is stale', async () => {
    const executeProposal = vi.fn();
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.stale',
        name: 'Stale Proposal',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        sessionId: 'current-session',
        grantRevision: 2,
        approveExecution: vi.fn().mockResolvedValue(true),
        validateProposalAuthority: vi.fn().mockResolvedValue(false),
        executeProposal,
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '1'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/stale/i);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('requires explicit host opt-in for signed transaction export', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.proposal.export',
        name: 'Signed Export',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        approveExecution: vi.fn().mockResolvedValue(true),
        executeProposal: vi.fn(),
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '2'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({
        proposalId: proposal.proposalId,
        mode: 'signed-export',
      })
    ).rejects.toThrow(/signed transaction export is unavailable/i);
  });

  it('does not expose operations across SDK authority sessions', async () => {
    const operationRecords = new Map<string, AddonExecutionOperation>();
    const operationStore = {
      async get(operationId: string) {
        return operationRecords.get(operationId);
      },
      async put(operation: AddonExecutionOperation) {
        operationRecords.set(operation.operationId, operation);
      },
    };
    const manifest = {
      id: 'test.operation.scope',
      name: 'Operation Scope',
      version: '1.0.0',
      permissions: [
        {
          kind: 'capabilities' as const,
          capabilities: [
            'tx:propose' as const,
            'tx:execute' as const,
            'tx:operation:read' as const,
          ],
        },
      ],
      contracts: [],
    };
    const first = createAddonSDK(manifest, {
      walletId: 4,
      network: 'chipnet',
      sessionId: 'session-a',
      operationStore,
      approveExecution: vi.fn().mockResolvedValue(true),
      executeProposal: vi.fn().mockResolvedValue({
        operationId: 'scoped-op',
        status: 'awaiting_approval',
      }),
    });
    const proposal = await first.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '3'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await first.tx.requestExecution({ proposalId: proposal.proposalId });
    const second = createAddonSDK(manifest, {
      walletId: 4,
      network: 'chipnet',
      sessionId: 'session-b',
      operationStore,
    });
    await expect(second.tx.getOperation('scoped-op')).rejects.toThrow(
      /outside the current authority context/i
    );
  });

  it('does not expose proposals across SDK authority sessions', async () => {
    const proposalRecords = new Map<string, AddonTransactionProposal>();
    const proposalStore = {
      async get(proposalId: string) {
        return proposalRecords.get(proposalId);
      },
      async put({ proposal }: { proposal: AddonTransactionProposal }) {
        proposalRecords.set(proposal.proposalId, proposal);
        return { kind: 'stored' as const, proposal };
      },
      async delete(proposalId: string) {
        proposalRecords.delete(proposalId);
      },
    };
    const manifest = {
      id: 'test.proposal.scope',
      name: 'Proposal Scope',
      version: '1.0.0',
      permissions: [
        {
          kind: 'capabilities' as const,
          capabilities: ['tx:propose' as const],
        },
      ],
      contracts: [],
    };
    const first = createAddonSDK(manifest, {
      walletId: 4,
      network: 'chipnet',
      sessionId: 'session-a',
      grantRevision: 1,
      proposalStore,
    });
    const proposal = await first.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '4'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    const second = createAddonSDK(manifest, {
      walletId: 4,
      network: 'chipnet',
      sessionId: 'session-b',
      grantRevision: 1,
      proposalStore,
    });
    await expect(second.tx.getProposal(proposal.proposalId)).rejects.toThrow(
      /outside the current authority context/i
    );
  });

  it('requires operation-read capability to inspect operation status', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.operation.capability',
        name: 'Operation Capability',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:execute'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    await expect(sdk.tx.getOperation('unknown')).rejects.toThrow(/capability/i);
  });

  it('prepares only P2PKH BCH proposals for the internal builder boundary', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.p2pkh.adapter',
        name: 'P2PKH Adapter',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '6'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    const prepared = prepareP2pkhExecution(
      proposal,
      (address) => address === 'bitcoincash:qinput'
    );
    expect(prepared.inputs[0]?.tx_hash).toBe('6'.repeat(64));
    expect(prepared.outputs[0]).toMatchObject({
      recipientAddress: 'bitcoincash:qoutput',
      amount: 1n,
    });
  });

  it('classifies P2PKH separately from contract address formats', () => {
    expect(isP2pkhCashAddress('bitcoincash:qinput')).toBe(false);
    expect(isP2pkhCashAddress('not-an-address')).toBe(false);
  });

  it('executes P2PKH proposals only through injected wallet services', async () => {
    const sdk = createAddonSDK(
      {
        id: 'test.p2pkh.authority',
        name: 'P2PKH Authority',
        version: '1.0.0',
        permissions: [{ kind: 'capabilities', capabilities: ['tx:propose'] }],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet' }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '7'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    const buildTransaction = vi
      .fn()
      .mockResolvedValue({ finalTransaction: 'raw-tx', errorMsg: '' });
    const sendTransaction = vi.fn().mockResolvedValue({
      txid: 'a'.repeat(64),
      errorMessage: null,
      broadcastState: 'broadcasted',
    });
    const authority = createP2pkhExecutionAuthority({
      isP2pkhAddress: (address) => address === 'bitcoincash:qinput',
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue('bitcoincash:qinput'),
      buildTransaction,
      sendTransaction,
    });
    const result = await authority.execute({ proposal, mode: 'wallet-submit' });
    expect(result).toEqual({
      operationId: `optn-operation-v1:${proposal.commitmentHex}`,
      txid: 'a'.repeat(64),
      status: 'mempool',
    });
    expect(buildTransaction).toHaveBeenCalledOnce();
    expect(sendTransaction).toHaveBeenCalledWith('raw-tx', expect.any(Array));
  });

  it('rejects a non-P2PKH wallet change address before building', async () => {
    const buildTransaction = vi.fn();
    const authority = createP2pkhExecutionAuthority({
      isP2pkhAddress: (address) => address === 'bitcoincash:qinput',
      verifyInputs: vi.fn().mockResolvedValue(undefined),
      resolveChangeAddress: vi.fn().mockResolvedValue('bitcoincash:qcontract'),
      buildTransaction,
      sendTransaction: vi.fn(),
    });
    const proposal = {
      proposalId: 'p2pkh-change',
      commitmentHex: '9'.repeat(64),
      walletId: 4,
      network: 'chipnet',
      sessionId: null,
      grantRevision: null,
      authorityEpoch: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      inputs: [
        {
          txid: '7'.repeat(64),
          vout: 0,
          address: 'bitcoincash:qinput',
          valueSats: '1000',
        },
      ],
      outputs: [{ recipientAddress: 'bitcoincash:qoutput', amount: 1n }],
      status: 'proposed' as const,
    };
    await expect(
      authority.execute({ proposal, mode: 'wallet-submit' })
    ).rejects.toThrow(/unsupported change address/i);
    expect(buildTransaction).not.toHaveBeenCalled();
  });

  it('routes SDK execution through an internal authority object', async () => {
    const authority = {
      supportedSchemes: new Set(['p2pkh-bch' as const]),
      validate: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({
        operationId: 'authority-op',
        status: 'mempool' as const,
      }),
    };
    const sdk = createAddonSDK(
      {
        id: 'test.authority.context',
        name: 'Authority Context',
        version: '1.0.0',
        permissions: [
          { kind: 'capabilities', capabilities: ['tx:propose', 'tx:execute'] },
        ],
        contracts: [],
      },
      { walletId: 4, network: 'chipnet', executionAuthority: authority }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '8'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).resolves.toMatchObject({
      operationId: 'authority-op',
      status: 'mempool',
    });
    expect(authority.validate).toHaveBeenCalledOnce();
    expect(authority.approve).toHaveBeenCalledOnce();
    expect(authority.execute).toHaveBeenCalledOnce();
  });

  it('preflights BCH conservation before wallet execution', async () => {
    const executeProposal = vi.fn();
    const sdk = createAddonSDK(
      {
        id: 'test.execution.conservation',
        name: 'Execution Conservation',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 4,
        network: 'chipnet',
        approveExecution: vi.fn().mockResolvedValue(true),
        executeProposal,
      }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qinput',
          tx_hash: '5'.repeat(64),
          tx_pos: 0,
          value: 1000,
          height: 1,
        },
      ],
      outputs: [{ address: 'bitcoincash:qoutput', value: 1001 } as never],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/outputs exceed input BCH/i);
    expect(executeProposal).not.toHaveBeenCalled();
  });
});

describe('AddonsSDK bcmr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads token metadata through the wallet BCMR service', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi
        .fn()
        .mockResolvedValue(
          '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
        ),
      resolveIcon: vi.fn().mockResolvedValue(null),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(function () {
      return bcmrInstance as unknown as BcmrService;
    });

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr',
        name: 'Test BCMR Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadata(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(bcmrInstance.getSnapshot).toHaveBeenCalledWith(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );
    expect(result?.name).toBe('Alpha Token');
    expect(result?.token.symbol).toBe('ALPHA');
  });

  it('returns BCMR metadata state with freshness information', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi
        .fn()
        .mockResolvedValue(
          '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
        ),
      resolveIcon: vi.fn().mockResolvedValue(null),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(function () {
      return bcmrInstance as unknown as BcmrService;
    });

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr.state',
        name: 'Test BCMR Addon State',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadataState(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(result?.freshness).toBe('cached');
    expect(result?.status).toBe('ready');
    expect(result?.snapshot?.token.symbol).toBe('ALPHA');
  });

  it('preserves cached BCMR metadata when icon hydration fails', async () => {
    const bcmrInstance = {
      getSnapshot: vi.fn().mockResolvedValue({
        name: 'Alpha Token',
        description: '',
        token: {
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          symbol: 'ALPHA',
          decimals: 0,
        },
        is_nft: false,
        uris: {},
        extensions: {},
      }),
      getCategoryAuthbase: vi
        .fn()
        .mockResolvedValue(
          '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
        ),
      resolveIcon: vi.fn().mockRejectedValue(new Error('gateway offline')),
      resolveIdentityRegistry: vi.fn(),
    };

    vi.mocked(BcmrService).mockImplementation(function () {
      return bcmrInstance as unknown as BcmrService;
    });

    const sdk = createAddonSDK(
      {
        id: 'test.bcmr.icon',
        name: 'Test BCMR Addon Icon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['bcmr:token:read'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'bcmr-app',
      }
    );

    const result = await sdk.bcmr.getTokenMetadataState(
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22'
    );

    expect(result?.freshness).toBe('cached');
    expect(result?.snapshot?.token.symbol).toBe('ALPHA');
    expect(result?.iconUri).toBeNull();
  });
});

describe('AddonsSDK tokenIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorGetPlatformMock.mockReturnValue('web');
  });

  it('reads holder lists through the TokenIndex SDK module', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        holders: [
          {
            locking_bytecode: '76a914abc123',
            locking_address: 'bitcoincash:qtestholder',
            ft_balance: '42',
            utxo_count: 1,
            updated_height: 900000,
          },
        ],
        next_cursor: null,
      }),
      text: async () =>
        JSON.stringify({
          holders: [
            {
              locking_bytecode: '76a914abc123',
              locking_address: 'bitcoincash:qtestholder',
              ft_balance: '42',
              utxo_count: 1,
              updated_height: 900000,
            },
          ],
          next_cursor: null,
        }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const sdk = createAddonSDK(
      {
        id: 'test.tokenindex',
        name: 'Test TokenIndex Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tokenindex:holders:read'],
          },
          {
            kind: 'http',
            domains: ['tokenindex.optnlabs.com'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'tokenindex-app',
      }
    );

    const result = await sdk.tokenIndex.listTokenHolders({
      category:
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      limit: 25,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0].locking_address).toBe('bitcoincash:qtestholder');

    vi.unstubAllGlobals();
  });

  it('uses CapacitorHttp for token index requests on native platforms', async () => {
    capacitorGetPlatformMock.mockReturnValue('android');
    capacitorIsNativePlatformMock.mockReturnValue(true);
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    capacitorHttpGetMock.mockResolvedValue({
      data: {
        holders: [
          {
            locking_bytecode: '76a914abc123',
            locking_address: 'bitcoincash:qnativeholder',
            ft_balance: '99',
            utxo_count: 1,
            updated_height: 900001,
          },
        ],
        next_cursor: null,
      },
    });

    const sdk = createAddonSDK(
      {
        id: 'test.tokenindex.native',
        name: 'Test TokenIndex Native Addon',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tokenindex:holders:read'],
          },
          {
            kind: 'http',
            domains: ['tokenindex.optnlabs.com'],
          },
        ],
        contracts: [],
      },
      {
        walletId: 1,
        network: 'mainnet',
        appId: 'tokenindex-app',
      }
    );

    const result = await sdk.tokenIndex.listTokenHolders({
      category:
        '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      limit: 25,
    });

    expect(capacitorHttpGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokenindex.optnlabs.com/v1/token/8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22/holders?limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      })
    );
    expect(result.holders[0].locking_address).toBe('bitcoincash:qnativeholder');
    vi.unstubAllGlobals();
  });
});

describe('CashToken execution preparation', () => {
  it('maps token inputs and outputs without invoking wallet capabilities', () => {
    const prepared = prepareCashTokenExecution({
      proposalId: 'proposal-1',
      commitmentHex: 'a'.repeat(64),
      walletId: 1,
      network: 'chipnet',
      sessionId: 'session-1',
      grantRevision: 1,
      authorityEpoch: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      inputs: [
        {
          txid: 'b'.repeat(64),
          vout: 0,
          address: 'bitcoincash:qqtest',
          valueSats: '1000',
          tokenCategory: 'c'.repeat(64),
          tokenAmount: '7',
          tokenNft: { capability: 'none', commitment: '01' },
        },
      ],
      outputs: [
        {
          recipientAddress: 'bitcoincash:qqrecipient',
          amount: 1000n,
          token: {
            category: 'c'.repeat(64),
            amount: 7n,
            nft: { capability: 'none', commitment: '01' },
          },
        },
      ],
      status: 'proposed',
    });
    expect(prepared.inputs[0].token).toEqual({
      category: 'c'.repeat(64),
      amount: 7n,
      nft: { capability: 'none', commitment: '01' },
    });
    expect(prepared.outputs[0]).toMatchObject({
      token: {
        category: 'c'.repeat(64),
        amount: 7n,
        nft: { capability: 'none', commitment: '01' },
      },
    });
  });
});

describe('AddonsSDK manifest validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed when created with an invalid manifest', () => {
    expect(() =>
      createAddonSDK(
        {
          id: 'bad.addon',
          name: 'Bad Addon',
          version: '1.0.0',
          permissions: [
            {
              kind: 'http',
              domains: ['example.com'],
            },
          ],
          contracts: [],
        },
        {
          walletId: 1,
          network: 'mainnet',
          appId: 'bad-addon-app',
        }
      )
    ).toThrow('non-allowlisted domain');
  });

  it('rejects capability use after the host session expires', async () => {
    const sdk = createAddonSDK(
      {
        ...manifest,
        permissions: [
          { kind: 'capabilities', capabilities: ['utxo:wallet:read'] },
        ],
      },
      {
        walletId: 1,
        network: 'mainnet',
        sessionId: 'expired-session',
        sessionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        allowedCapabilities: new Set(['utxo:wallet:read']),
      }
    );
    await expect(sdk.utxos.listForWallet()).rejects.toThrow(
      /session has expired/i
    );
  });
});
