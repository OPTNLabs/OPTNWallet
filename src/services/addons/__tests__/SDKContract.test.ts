import { describe, expect, it, vi } from 'vitest';
import {
  ADDON_SDK_VERSION,
  ADDON_SDK_PROTOCOL_VERSION,
  getAddonSDKInfo,
  ADDON_SDK_FEATURES,
  ADDON_SDK_CASHTOKEN_INTENTS,
  ADDON_SDK_CASHTOKEN_LIMITS,
} from '../SDKContract';
import {
  createPublicAddonSDK,
  sanitizeAddonAuditEvent,
  sanitizeAddonOperation,
  sanitizeAddonUTXO,
} from '../../AddonsSDK';
import { createPublicAddonSDK as publicEntrypointFactory } from '../PublicSDK';
import { bindAddonExecutionAuthority } from '../AddonExecutionAuthority';
import { createMockPublicAddonSDK } from '../MockAddonHost';

describe('SDKContract', () => {
  it('projects operation results without host-only fields', () => {
    const projected = sanitizeAddonOperation({
      operationId: 'operation-1',
      status: 'submission_unknown',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      proposalId: 'proposal-1',
      mode: 'wallet-submit',
      sessionId: 'session-1',
      grantRevision: 1,
      privateKey: 'must-not-cross-boundary',
      internalSigner: { secret: 'must-not-cross-boundary' },
    } as never);
    expect(projected).toMatchObject({
      operationId: 'operation-1',
      status: 'submission_unknown',
    });
    expect(projected).not.toHaveProperty('privateKey');
    expect(projected).not.toHaveProperty('internalSigner');
  });

  it('returns consistent SDK metadata', () => {
    const info = getAddonSDKInfo(['tx:build']);
    expect(info.version).toBe(ADDON_SDK_VERSION);
    expect(ADDON_SDK_PROTOCOL_VERSION).toBe(1);
    expect(info.protocolVersion).toBe(ADDON_SDK_PROTOCOL_VERSION);
    expect(info.methods).toBe(ADDON_SDK_FEATURES);
    expect(info.modules.length).toBeGreaterThan(0);
    expect(info.methods.meta).toEqual(['getInfo', 'getAuditTrail']);
    expect(info.methods).not.toHaveProperty('contracts');
    expect(info.methods.wallet).toEqual([
      'getContext',
      'listAddresses',
      'getPrimaryAddress',
      'toTokenAddress',
    ]);
    expect(info.capabilities).toEqual(['tx:build']);
    expect(info.methods.signing).toContain('signMessage');
    expect(info.methods.bcmr).toContain('getTokenMetadataState');
    expect(info.cashTokenIntents).toBe(ADDON_SDK_CASHTOKEN_INTENTS);
    expect(info.cashTokenLimits).toBe(ADDON_SDK_CASHTOKEN_LIMITS);
  });

  it('public SDK facade removes internal transaction and key-bearing methods', () => {
    const sdk = createPublicAddonSDK(
      {
        id: 'test.public-facade',
        name: 'Public Facade',
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
        walletId: 1,
        network: 'chipnet',
        requireAddressAllowlist: false,
        allowLegacyKeyBearingSigning: true,
        allowLegacyTransactionExecution: true,
        allowSignedExport: true,
      }
    );
    expect('build' in sdk.tx).toBe(false);
    expect('broadcast' in sdk.tx).toBe(false);
    expect('addOutput' in sdk.tx).toBe(false);
    expect('signatureTemplateForAddress' in sdk.signing).toBe(false);
    expect('contracts' in sdk).toBe(true);
    expect(typeof sdk.contracts.instantiate).toBe('function');
    expect('logging' in sdk).toBe(false);
    expect(typeof sdk.tx.propose).toBe('function');
    expect(typeof sdk.tx.requestExecution).toBe('function');
    expect(sdk.meta.getInfo().capabilities).not.toContain('tx:build');
    expect(sdk.meta.getInfo().capabilities).not.toContain(
      'signing:signature_template'
    );
    expect(sdk.meta.getInfo().methods.tx).not.toContain('addOutput');
    expect(sdk.meta.getInfo().limits).toEqual({
      maxProposalInputs: 200,
      maxProposalOutputs: 100,
      maxMessageLength: 8192,
      maxIdempotencyKeyLength: 256,
    });
    expect(Object.keys(sdk.tx)).not.toEqual(
      expect.arrayContaining(['build', 'broadcast', 'addOutput'])
    );
    expect(Object.keys(sdk.signing)).not.toContain(
      'signatureTemplateForAddress'
    );
  });

  it('rejects public add-ons that request internal-only capabilities', () => {
    expect(() =>
      createPublicAddonSDK(
        {
          id: 'test.public-forbidden',
          name: 'Forbidden Public Addon',
          version: '1.0.0',
          permissions: [{ kind: 'capabilities', capabilities: ['tx:build'] }],
          contracts: [],
        },
        { walletId: 1, network: 'chipnet' }
      )
    ).toThrow(/internal-only capabilities/i);

    expect(() =>
      createPublicAddonSDK(
        {
          id: 'test.key-template',
          name: 'Key Template',
          version: '1.0.0',
          permissions: [
            { kind: 'capabilities', capabilities: ['signing:signature_template'] },
          ],
          contracts: [],
        },
        { walletId: 1, network: 'chipnet' }
      )
    ).toThrow(/internal-only capabilities/i);
  });

  it('rejects internal trust metadata at the public factory boundary', () => {
    expect(() =>
      createPublicAddonSDK(
        {
          id: 'test.internal-tier',
          name: 'Internal Tier',
          version: '1.0.0',
          trustTier: 'internal',
          permissions: [],
          contracts: [],
        },
        { walletId: 1, network: 'chipnet' }
      )
    ).toThrow(/host-private/i);
  });

  it('exposes the public factory through the stable entrypoint', () => {
    expect(publicEntrypointFactory).toBe(createPublicAddonSDK);
  });

  it('provides a secret-free mock host with explicit unknown submission state', async () => {
    const sdk = createMockPublicAddonSDK(
      {
        id: 'test.mock-host',
        name: 'Mock Host',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute', 'tx:operation:read'],
          },
        ],
        contracts: [],
      },
      { addresses: ['bitcoincash:qqtest'] }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          address: 'bitcoincash:qqtest',
          value: 1000,
          height: 0,
        },
      ],
      outputs: [{ recipientAddress: 'bitcoincash:qqtest', amount: 900 }],
    });
    const result = await sdk.tx.requestExecution({
      proposalId: proposal.proposalId,
      idempotencyKey: 'mock-execution-1',
    });
    expect(result.status).toBe('submission_unknown');
    const operation = await sdk.tx.getOperation(result.operationId);
    expect(operation.operationId).toBe(result.operationId);
  });

  it('models wallet approval denial without creating an operation', async () => {
    const sdk = createMockPublicAddonSDK(
      {
        id: 'test.mock-denial',
        name: 'Mock Denial',
        version: '1.0.0',
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:propose', 'tx:execute'],
          },
        ],
        contracts: [],
      },
      { addresses: ['bitcoincash:qqtest'], approveExecution: false }
    );
    const proposal = await sdk.tx.propose({
      inputs: [
        {
          tx_hash: '2'.repeat(64),
          tx_pos: 0,
          address: 'bitcoincash:qqtest',
          value: 1000,
          height: 0,
        },
      ],
      outputs: [{ recipientAddress: 'bitcoincash:qqtest', amount: 900 }],
    });
    await expect(
      sdk.tx.requestExecution({ proposalId: proposal.proposalId })
    ).rejects.toThrow(/user rejected/i);
  });

  it('gives each mock execution a unique deterministic operation ID', async () => {
    const sdk = createMockPublicAddonSDK(
      {
        id: 'test.mock-sequence',
        name: 'Mock Sequence',
        version: '1.0.0',
        permissions: [
          { kind: 'capabilities', capabilities: ['tx:propose', 'tx:execute'] },
        ],
        contracts: [],
      },
      { addresses: ['bitcoincash:qqtest'] }
    );
    const makeProposal = (id: string) =>
      sdk.tx.propose({
        inputs: [
          {
            tx_hash: id.repeat(64),
            tx_pos: 0,
            address: 'bitcoincash:qqtest',
            value: 1000,
            height: 0,
          },
        ],
        outputs: [{ recipientAddress: 'bitcoincash:qqtest', amount: 900 }],
      });
    const first = await makeProposal('a');
    const second = await makeProposal('b');
    const firstOperation = await sdk.tx.requestExecution({
      proposalId: first.proposalId,
    });
    const secondOperation = await sdk.tx.requestExecution({
      proposalId: second.proposalId,
    });
    expect(firstOperation.operationId).toBe('mock-operation-1');
    expect(secondOperation.operationId).toBe('mock-operation-2');
  });

  it('sanitizes executable contract metadata from public UTXO views', () => {
    const safe = sanitizeAddonUTXO({
      address: 'bitcoincash:qqtest',
      tx_hash: 'a'.repeat(64),
      tx_pos: 0,
      value: 1000,
      height: 0,
      unlocker: { secret: 'should-not-cross-boundary' },
      abi: [{ name: 'spend' }],
      contractFunction: 'spend',
      contractFunctionInputs: { secret: 'private' },
      contractConstructorArgs: ['private'],
      wallet_id: 42,
      contractName: 'secret-contract',
      token: {
        amount: 2n,
        category: 'a'.repeat(64),
        nft: { capability: 'none', commitment: '01' },
        BcmrTokenMetadata: { internalProviderPath: '/private/provider' },
      },
      rpaOrigin: {
        prevoutTxid: 'b'.repeat(64),
        prevoutIndex: 0,
        senderPubkey: '02'.padEnd(66, '0'),
      },
    });
    expect(safe).toMatchObject({ address: 'bitcoincash:qqtest', value: 1000 });
    expect(safe).not.toHaveProperty('unlocker');
    expect(safe).not.toHaveProperty('abi');
    expect(safe).not.toHaveProperty('contractFunctionInputs');
    expect(safe).not.toHaveProperty('wallet_id');
    expect(safe).not.toHaveProperty('contractName');
    expect(safe).not.toHaveProperty('rpaOrigin');
    expect(safe.token).toEqual({
      amount: 2n,
      category: 'a'.repeat(64),
      nft: { capability: 'none', commitment: '01' },
    });

    expect(
      sanitizeAddonUTXO({
        address: 'bitcoincash:qqtest',
        tx_hash: 'c'.repeat(64),
        tx_pos: 1,
        value: 1000,
        height: 0,
        token: null,
      }).token
    ).toBeNull();
  });

  it('redacts host details from public policy audit events', () => {
    expect(
      sanitizeAddonAuditEvent({
        at: new Date().toISOString(),
        addonId: 'test.addon',
        appId: 'internal-app-instance',
        capability: 'tx:execute',
        action: 'deny',
        reason: '/private/path and provider details',
      })
    ).toEqual({
      at: expect.any(String),
      addonId: 'test.addon',
      capability: 'tx:execute',
      action: 'deny',
    });
  });

  it('binds internal authority callbacks without exposing authority objects', async () => {
    const authority = {
      supportedSchemes: new Set(['p2pkh-bch' as const]),
      validate: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({
        operationId: 'op-1',
        status: 'awaiting_approval' as const,
      }),
    };
    const callbacks = bindAddonExecutionAuthority(authority);
    const proposal = { proposalId: 'proposal-1' } as never;
    await expect(callbacks.validateProposalAuthority!(proposal)).resolves.toBe(
      true
    );
    await expect(
      callbacks.approveExecution!({ proposal, mode: 'wallet-submit' })
    ).resolves.toBe(true);
    await expect(
      callbacks.executeProposal!({ proposal, mode: 'wallet-submit' })
    ).resolves.toMatchObject({ operationId: 'op-1' });
  });
});
