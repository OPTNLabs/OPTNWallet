import { describe, expect, it, vi } from 'vitest';
import { createAddonWalletClient } from '../src/client';
import {
  AddonSDKError,
  connectAddonPostMessage,
  createAddonPostMessageTransport,
  type AddonTransport,
} from '../src/transport';

const proposal = {
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
      address: 'bitcoincash:qqinput',
      tx_hash: 'b'.repeat(64),
      tx_pos: 0,
      value: 1000,
      height: 0,
      unlocker: { privateKey: 'must-not-cross-client' },
    },
  ],
  outputs: [
    {
      recipientAddress: 'bitcoincash:qqoutput',
      amount: 900,
      secretInternalField: 'must-not-cross-client',
    },
  ],
  status: 'proposed',
};

describe('addon SDK client', () => {
  it('rejects oversized connection capability requests locally', async () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    await expect(
      connectAddonPostMessage({
        target,
        targetOrigin: 'https://wallet.example',
        addonId: 'example.addon',
        requestedCapabilities: Array.from(
          { length: 65 },
          () => 'wallet:context:read'
        ),
      })
    ).rejects.toThrow(/capabilities are invalid/i);
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('bounds serialized request parameters while preserving bigint values', async () => {
    const request = vi.fn(async () => ({ holders: [] }));
    const sdk = createAddonWalletClient({ request });
    await expect(
      sdk.tokenIndex.listTokenHolders({ category: 'a'.repeat(70_000) })
    ).rejects.toThrow(/exceed the SDK limit/i);
    const circular = {} as { category: string; self?: unknown };
    circular.category = 'a'.repeat(64);
    circular.self = circular;
    await expect(
      sdk.tokenIndex.listTokenHolders(circular as never)
    ).rejects.toThrow(/not serializable/i);
    await sdk.tx.propose({
      inputs: [],
      outputs: [{ recipientAddress: 'bitcoincash:qrecipient', amount: 1000n }],
    }).catch(() => undefined);
    expect(request).toHaveBeenCalled();
  });

  it('rejects duplicate connection capabilities locally', async () => {
    await expect(
      connectAddonPostMessage({
        target: { postMessage: vi.fn() } as unknown as Window,
        targetOrigin: 'https://wallet.example',
        addonId: 'example.addon',
        requestedCapabilities: ['wallet:context:read', 'wallet:context:read'],
      })
    ).rejects.toThrow(/must be unique/i);
  });

  it('cancels a pending connection handshake', async () => {
    const controller = new AbortController();
    const listeners = new Set<(event: MessageEvent) => void>();
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.add(listener as (event: MessageEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.delete(listener as (event: MessageEvent) => void),
    } as unknown as Window;
    const pending = connectAddonPostMessage({
      target: { postMessage: vi.fn() } as unknown as Window,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: 'example.addon',
      requestedCapabilities: [],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(listeners).toHaveLength(0);
  });

  it('establishes a scoped session before creating the request transport', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted: Record<string, unknown> | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.add(listener as (event: MessageEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.delete(listener as (event: MessageEvent) => void),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
    } as unknown as Window;
    const connectionPromise = connectAddonPostMessage({
      target,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: 'example.addon',
      requestedCapabilities: ['wallet:context:read', 'tx:propose'],
    });
    const requestId = posted?.requestId;
    for (const listener of listeners) {
      listener({
        source: target,
        data: {
          type: 'optn-addon-sdk-connect-response',
          requestId,
          ok: true,
          session: {
            sessionId: 'session-1',
            protocolVersion: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            capabilities: ['wallet:context:read'],
          },
        },
      } as MessageEvent);
    }
    const connection = await connectionPromise;
    expect(connection.session.sessionId).toBe('session-1');
    expect(connection.session.capabilities).toEqual(['wallet:context:read']);
    expect(connection.hasCapability('wallet:context:read')).toBe(true);
    expect(connection.hasCapability('tx:propose')).toBe(false);
    connection.transport.dispose();
  });

  it('rejects an expired session descriptor during connection', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted: Record<string, unknown> | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.add(listener as (event: MessageEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.delete(listener as (event: MessageEvent) => void),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
    } as unknown as Window;
    const connectionPromise = connectAddonPostMessage({
      target,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: 'example.addon',
      requestedCapabilities: [],
    });
    for (const listener of listeners) {
      listener({
        source: target,
        data: {
          type: 'optn-addon-sdk-connect-response',
          requestId: posted?.requestId,
          ok: true,
          session: {
            sessionId: 'expired-session',
            protocolVersion: 1,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
            capabilities: [],
          },
        },
      } as MessageEvent);
    }
    await expect(connectionPromise).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects malformed granted capability lists during connection', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted: Record<string, unknown> | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.add(listener as (event: MessageEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.delete(listener as (event: MessageEvent) => void),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
    } as unknown as Window;
    const connectionPromise = connectAddonPostMessage({
      target,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: 'example.addon',
      requestedCapabilities: [],
    });
    for (const listener of listeners) {
      listener({
        source: target,
        data: {
          type: 'optn-addon-sdk-connect-response',
          requestId: posted?.requestId,
          ok: true,
          session: {
            sessionId: 'session-1',
            protocolVersion: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            capabilities: ['wallet:context:read', 'wallet:context:read'],
          },
        },
      } as MessageEvent);
    }
    await expect(connectionPromise).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects unknown granted capabilities during connection', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted: Record<string, unknown> | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.add(listener as (event: MessageEvent) => void),
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => listeners.delete(listener as (event: MessageEvent) => void),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
    } as unknown as Window;
    const connectionPromise = connectAddonPostMessage({
      target,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: 'example.addon',
      requestedCapabilities: [],
    });
    for (const listener of listeners) {
      listener({
        source: target,
        data: {
          type: 'optn-addon-sdk-connect-response',
          requestId: posted?.requestId,
          ok: true,
          session: {
            sessionId: 'session-1',
            protocolVersion: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            capabilities: ['future:unknown'],
          },
        },
      } as MessageEvent);
    }
    await expect(connectionPromise).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('uses a closed typed method surface and projects responses', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'tx.propose') return proposal;
      if (method === 'wallet.getContext') {
        return { walletId: 1, network: 'chipnet', privateKey: 'secret' };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const transport: AddonTransport = { request };
    const sdk = createAddonWalletClient(transport);

    const context = await sdk.wallet.getContext();
    expect(context).toEqual({ walletId: 1, network: 'chipnet' });

    const result = await sdk.tx.propose({
      inputs: proposal.inputs,
      outputs: proposal.outputs,
    });
    expect(result.inputs[0]).not.toHaveProperty('unlocker');
    expect(result.outputs[0]).not.toHaveProperty('secretInternalField');
    expect(Object.keys(sdk.tx)).toEqual([
      'propose',
      'getProposal',
      'requestExecution',
      'getOperation',
      'waitForOperation',
    ]);
    expect('contracts' in sdk).toBe(true);
    expect(typeof sdk.contracts.instantiate).toBe('function');
    expect(request).toHaveBeenNthCalledWith(
      2,
      'tx.propose',
      expect.objectContaining({ inputs: proposal.inputs }),
      undefined
    );
  });

  it('rejects invalid idempotency keys before transport dispatch', async () => {
    const request = vi.fn();
    const sdk = createAddonWalletClient({ request });

    expect(() =>
      sdk.tx.propose({
        inputs: proposal.inputs,
        outputs: proposal.outputs,
        idempotencyKey: ' '.repeat(1),
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() =>
      sdk.tx.requestExecution({
        proposalId: proposal.proposalId,
        idempotencyKey: 'k'.repeat(257),
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('forwards cancellation signals to the host transport', async () => {
    const request = vi.fn(async () => 'bitcoincash:qqtoken');
    const transport: AddonTransport = { request };
    const sdk = createAddonWalletClient(transport);
    const controller = new AbortController();

    await sdk.wallet.toTokenAddress('bitcoincash:qqaddress', {
      signal: controller.signal,
    });
    expect(request).toHaveBeenCalledWith(
      'wallet.toTokenAddress',
      { address: 'bitcoincash:qqaddress' },
      { signal: controller.signal }
    );
  });

  it('projects the advertised CashToken capabilities and limits', async () => {
    const sdk = createAddonWalletClient({
      request: vi.fn(async () => ({
        version: '1.6.0',
        protocolVersion: 1,
        modules: ['meta', 'tx'],
        methods: {
          meta: ['getInfo'],
          tx: ['propose'],
        },
        cashTokenIntents: [
          'transfer',
          'mint-fungible',
          'mint-nft',
          'mutate-nft',
          'burn',
        ],
        cashTokenLimits: {
          maxFungibleAmount: '9223372036854775807',
          maxNftCommitmentBytes: 40,
          tokenOutputMinimumSats: 1000,
        },
        limits: {
          maxProposalInputs: 200,
          maxProposalOutputs: 100,
          maxMessageLength: 8192,
          maxIdempotencyKeyLength: 256,
        },
        capabilities: ['tx:propose'],
      })),
    });
    await expect(sdk.meta.getInfo()).resolves.toMatchObject({
      cashTokenIntents: expect.arrayContaining(['mutate-nft', 'burn']),
      cashTokenLimits: {
        maxFungibleAmount: '9223372036854775807',
        maxNftCommitmentBytes: 40,
        tokenOutputMinimumSats: 1000,
      },
      limits: {
        maxMessageLength: 8192,
        maxIdempotencyKeyLength: 256,
      },
    });
  });

  it('rejects incomplete limit metadata instead of silently downgrading it', async () => {
    const sdk = createAddonWalletClient({
      request: vi.fn(async () => ({
        version: '1.6.0',
        protocolVersion: 1,
        modules: ['meta'],
        methods: { meta: ['getInfo'] },
        cashTokenIntents: ['transfer'],
        cashTokenLimits: {
          maxFungibleAmount: '9223372036854775807',
          maxNftCommitmentBytes: 40,
          tokenOutputMinimumSats: 1000,
        },
        limits: { maxProposalInputs: 200, maxProposalOutputs: 100 },
        capabilities: [],
      })),
    });
    await expect(sdk.meta.getInfo()).rejects.toThrow(/maximum message length/i);
  });

  it('rejects unknown modules and methods in SDK metadata', async () => {
    const sdk = createAddonWalletClient({
      request: vi.fn(async () => ({
        version: '1.6.0',
        protocolVersion: 1,
        modules: ['wallet', 'contracts'],
        methods: {
          wallet: ['getContext'],
          contracts: ['unknownMethod'],
        },
        cashTokenIntents: ['transfer'],
        cashTokenLimits: {
          maxFungibleAmount: '9223372036854775807',
          maxNftCommitmentBytes: 40,
          tokenOutputMinimumSats: 1000,
        },
        limits: {
          maxProposalInputs: 200,
          maxProposalOutputs: 100,
          maxMessageLength: 8192,
        },
        capabilities: [],
      })),
    });
    await expect(sdk.meta.getInfo()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects duplicate SDK metadata entries', async () => {
    const sdk = createAddonWalletClient({
      request: vi.fn(async () => ({
        version: '1.6.0',
        protocolVersion: 1,
        modules: ['meta', 'meta'],
        methods: { meta: ['getInfo', 'getInfo'] },
        cashTokenIntents: ['transfer'],
        cashTokenLimits: {
          maxFungibleAmount: '9223372036854775807',
          maxNftCommitmentBytes: 40,
          tokenOutputMinimumSats: 1000,
        },
        limits: {
          maxProposalInputs: 200,
          maxProposalOutputs: 100,
          maxMessageLength: 8192,
        },
        capabilities: [],
      })),
    });
    await expect(sdk.meta.getInfo()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects unknown metadata capabilities', async () => {
    const sdk = createAddonWalletClient({
      request: vi.fn(async () => ({
        version: '1.6.0',
        protocolVersion: 1,
        modules: ['meta'],
        methods: { meta: ['getInfo'] },
        cashTokenIntents: ['transfer'],
        cashTokenLimits: {
          maxFungibleAmount: '9223372036854775807',
          maxNftCommitmentBytes: 40,
          tokenOutputMinimumSats: 1000,
        },
        limits: {
          maxProposalInputs: 200,
          maxProposalOutputs: 100,
          maxMessageLength: 8192,
        },
        capabilities: ['future:capability'],
      })),
    });
    await expect(sdk.meta.getInfo()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('uses an explicit origin for versioned postMessage transport and rejects mismatched peers', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted:
      | { targetOrigin: string; message: Record<string, unknown> }
      | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => {
        listeners.add(listener as (event: MessageEvent) => void);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => {
        listeners.delete(listener as (event: MessageEvent) => void);
      },
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>, targetOrigin: string) {
        posted = { message, targetOrigin };
      },
    } as unknown as Window;
    expect(() =>
      createAddonPostMessageTransport({
        target,
        eventTarget,
        sessionId: 'session-1',
      })
    ).toThrow(/targetOrigin/i);
    for (const targetOrigin of [
      'javascript:alert(1)',
      'data:text/plain,wallet',
    ]) {
      expect(() =>
        createAddonPostMessageTransport({
          target,
          eventTarget,
          sessionId: 'session-1',
          targetOrigin,
        })
      ).toThrow(/absolute origin/i);
    }
    expect(() =>
      createAddonPostMessageTransport({
        target,
        eventTarget,
        sessionId: 'session-1',
        targetOrigin: 'https://wallet.example',
        allowOpaqueOrigin: true,
      })
    ).toThrow(/opaque-origin.*\*/i);
    const transport = createAddonPostMessageTransport({
      target,
      sessionId: 'session-1',
      eventTarget,
      targetOrigin: 'https://wallet.example',
      timeoutMs: 1000,
    });
    const pending = transport.request('wallet.getContext', undefined);
    expect(posted?.targetOrigin).toBe('https://wallet.example');
    expect(posted?.message.sessionId).toBe('session-1');
    const response = {
      type: 'optn-addon-sdk-response',
      protocolVersion: 1,
      requestId: posted?.message.requestId,
      ok: true,
      result: { network: 'chipnet' },
    };
    for (const listener of listeners) {
      listener({ source: {} as Window, data: response } as MessageEvent);
    }
    for (const listener of listeners) {
      listener({
        source: target,
        origin: 'https://attacker.example',
        data: response,
      } as MessageEvent);
    }
    expect(posted?.targetOrigin).toBe('https://wallet.example');
    for (const listener of listeners) {
      listener({ source: target, data: response } as MessageEvent);
    }
    await expect(pending).resolves.toEqual({ network: 'chipnet' });
    await expect(
      transport.request('wallet.privateKey' as never, undefined)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(posted?.message.method).toBe('wallet.getContext');
    transport.dispose();
  });

  it('supports cancellation and structured host errors', async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    let posted: Record<string, unknown> | undefined;
    const eventTarget = {
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => {
        listeners.add(listener as (event: MessageEvent) => void);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) => {
        listeners.delete(listener as (event: MessageEvent) => void);
      },
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
    } as unknown as Window;
    const transport = createAddonPostMessageTransport({
      target,
      sessionId: 'session-1',
      eventTarget,
      targetOrigin: 'https://wallet.example',
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const cancelled = transport.request('wallet.getContext', undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const failed = transport.request('wallet.getContext', undefined);
    for (const listener of listeners) {
      listener({
        source: target,
        data: {
          type: 'optn-addon-sdk-response',
          protocolVersion: 1,
          requestId: posted?.requestId,
          ok: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: 'Permission denied',
            retry: 'never',
          },
        },
      } as MessageEvent);
    }
    await expect(failed).rejects.toBeInstanceOf(AddonSDKError);
    transport.dispose();
  });

  it('rejects pending requests immediately when the session is disposed', async () => {
    const eventTarget = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const target = { postMessage: vi.fn() } as unknown as Window;
    const transport = createAddonPostMessageTransport({
      target,
      sessionId: 'session-1',
      eventTarget,
      targetOrigin: 'https://wallet.example',
      timeoutMs: 60_000,
    });
    const pending = transport.request('wallet.getContext', undefined);
    transport.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('automatically expires the transport at the session deadline', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(event: MessageEvent) => void>();
      const eventTarget = {
        addEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject
        ) => listeners.add(listener as (event: MessageEvent) => void),
        removeEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject
        ) => listeners.delete(listener as (event: MessageEvent) => void),
      } as unknown as Window;
      const target = { postMessage: vi.fn() } as unknown as Window;
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      const transport = createAddonPostMessageTransport({
        target,
        sessionId: 'session-1',
        sessionExpiresAt: expiresAt,
        eventTarget,
        targetOrigin: 'https://wallet.example',
      });
      const pending = transport.request('wallet.getContext', undefined);
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'SESSION_EXPIRED',
      });
      await vi.advanceTimersByTimeAsync(1_100);
      await rejection;
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects every public CashToken state while rejecting malformed token data', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        proposalId: 'proposal-token',
        commitmentHex: 'c'.repeat(64),
        walletId: 1,
        network: 'chipnet',
        sessionId: null,
        grantRevision: null,
        authorityEpoch: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        inputs: [
          {
            address: 'bitcoincash:qqinput',
            tx_hash: 'd'.repeat(64),
            tx_pos: 0,
            value: 1000,
            height: 0,
            token: {
              category: 'A'.repeat(64),
              amount: '10',
              nft: { capability: 'mutable', commitment: 'ABCD' },
              BcmrTokenMetadata: { privateProviderState: 'redact-me' },
            },
          },
        ],
        outputs: [
          {
            recipientAddress: 'bitcoincash:qqoutput',
            amount: 1000,
            token: {
              category: 'a'.repeat(64),
              amount: '10',
              nft: { capability: 'mutable', commitment: 'abcd' },
            },
          },
        ],
        tokenIntent: {
          kind: 'mutate-nft',
          category: 'a'.repeat(64),
          source: { capability: 'mutable', commitment: '0102' },
          target: { capability: 'none', commitment: '' },
        },
        status: 'proposed',
      })),
    };
    const result = await createAddonWalletClient(transport).tx.propose({
      inputs: [],
      outputs: [],
    });
    expect(result.inputs[0].token).toEqual({
      category: 'a'.repeat(64),
      amount: '10',
      nft: { capability: 'mutable', commitment: 'abcd' },
    });
    expect(result.outputs[0]).toMatchObject({
      token: {
        category: 'a'.repeat(64),
        amount: '10',
        nft: { capability: 'mutable', commitment: 'abcd' },
      },
    });
    expect(result.tokenIntent).toEqual({
      kind: 'mutate-nft',
      category: 'a'.repeat(64),
      source: { capability: 'mutable', commitment: '0102' },
      target: { capability: 'none', commitment: '' },
    });

    const invalidTransport: AddonTransport = {
      request: vi.fn(async () => ({
        ...(await transport.request('tx.propose', undefined)),
        inputs: [
          {
            address: 'bitcoincash:qqinput',
            tx_hash: 'd'.repeat(64),
            tx_pos: 0,
            value: 1000,
            height: 0,
            token: { category: 'a'.repeat(64), amount: '0' },
          },
        ],
      })),
    };
    await expect(
      createAddonWalletClient(invalidTransport).tx.propose({
        inputs: [],
        outputs: [],
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a non-canonical proposal commitment from the wallet', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        ...proposal,
        commitmentHex: 'not-a-commitment',
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.propose({
        inputs: proposal.inputs,
        outputs: proposal.outputs,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects oversized response identifiers', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        ...proposal,
        proposalId: 'p'.repeat(257),
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.propose({
        inputs: proposal.inputs,
        outputs: proposal.outputs,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects invalid response timestamps', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        ...proposal,
        createdAt: 'not-a-timestamp',
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.propose({
        inputs: proposal.inputs,
        outputs: proposal.outputs,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects unsupported wallet networks in responses', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({ walletId: 1, network: 'regtest' })),
    };
    await expect(
      createAddonWalletClient(transport).wallet.getContext()
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects invalid wallet identifiers in responses', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({ walletId: 0, network: 'chipnet' })),
    };
    await expect(
      createAddonWalletClient(transport).wallet.getContext()
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects invalid authority revisions in proposals', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        ...proposal,
        grantRevision: 1.5,
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.propose({
        inputs: proposal.inputs,
        outputs: proposal.outputs,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects invalid authority revisions in operations', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        operationId: 'operation-1',
        status: 'submission_unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proposalId: 'proposal-1',
        mode: 'wallet-submit',
        sessionId: 'session-1',
        grantRevision: -1,
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.getOperation('operation-1')
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects operation timestamps that move backwards', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        operationId: 'operation-1',
        status: 'submission_unknown',
        createdAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        proposalId: 'proposal-1',
        mode: 'wallet-submit',
        sessionId: 'session-1',
        grantRevision: 1,
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.getOperation('operation-1')
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects oversized signed response fields', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        signature: 's'.repeat(513),
        address: 'bitcoincash:qqsigner',
        encoding: 'bch-signed-message',
      })),
    };
    await expect(
      createAddonWalletClient(transport).signing.signMessage({
        address: 'bitcoincash:qqsigner',
        message: 'hello',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects malformed signing requests before transport', async () => {
    const request = vi.fn(async () => ({
      signature: 'signature',
      address: 'bitcoincash:qqsigner',
      encoding: 'bch-signed-message',
    }));
    const transport: AddonTransport = { request };
    const client = createAddonWalletClient(transport);
    expect(() =>
      client.signing.signMessage({ address: '   ', message: 'hello' })
    ).toThrow(/Signing address/);
    expect(() =>
      client.signing.signMessage({
        address: 'a'.repeat(257),
        message: 'hello',
      })
    ).toThrow(/Signing address/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature recovery id', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        signature: 'signature',
        address: 'bitcoincash:qqsigner',
        encoding: 'bch-signed-message',
        details: {
          recoveryId: 4,
          compressed: true,
          messageHash: 'hash',
        },
      })),
    };
    await expect(
      createAddonWalletClient(transport).signing.signMessage({
        address: 'bitcoincash:qqsigner',
        message: 'hello',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects malformed transaction correlation ids', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        operationId: 'operation-1',
        txid: 'not-a-transaction-id',
        status: 'submission_unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proposalId: 'proposal-1',
        mode: 'wallet-submit',
        sessionId: 'session-1',
        grantRevision: 1,
      })),
    };
    await expect(
      createAddonWalletClient(transport).tx.getOperation('operation-1')
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('waits for a terminal operation without exposing transport polling controls', async () => {
    const operation = (status: 'mempool' | 'confirmed') => ({
      operationId: 'operation-1',
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      proposalId: 'proposal-1',
      mode: 'wallet-submit',
      sessionId: 'session-1',
      grantRevision: 1,
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(operation('mempool'))
      .mockResolvedValueOnce(operation('confirmed'));
    const transport: AddonTransport = { request };
    const result = await createAddonWalletClient(transport).tx.waitForOperation(
      'operation-1',
      { pollIntervalMs: 50, timeoutMs: 500 }
    );
    expect(result.status).toBe('confirmed');
    expect(request).toHaveBeenNthCalledWith(
      1,
      'tx.getOperation',
      { operationId: 'operation-1' },
      {}
    );
  });

  it('aborts operation polling before dispatch when requested', async () => {
    const request = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createAddonWalletClient({ request }).tx.waitForOperation('operation-1', {
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects invalid operation polling controls before dispatch', async () => {
    const request = vi.fn();
    const sdk = createAddonWalletClient({ request });
    await expect(
      sdk.tx.waitForOperation('operation-1', { pollIntervalMs: NaN })
    ).rejects.toThrow(/finite and positive/i);
    await expect(
      sdk.tx.waitForOperation('operation-1', { timeoutMs: 0 })
    ).rejects.toThrow(/finite and positive/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects empty or oversized operation and proposal IDs locally', async () => {
    const request = vi.fn();
    const sdk = createAddonWalletClient({ request });
    await expect(sdk.tx.getOperation('')).rejects.toThrow(/Operation ID/i);
    await expect(sdk.tx.getProposal('x'.repeat(257))).rejects.toThrow(
      /Proposal ID/i
    );
    await expect(sdk.tx.waitForOperation('   ')).rejects.toThrow(/Operation ID/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an incompatible signature encoding', async () => {
    const transport: AddonTransport = {
      request: vi.fn(async () => ({
        signature: 'signature',
        address: 'bitcoincash:qqsigner',
        encoding: 'raw-transaction-signature',
      })),
    };
    await expect(
      createAddonWalletClient(transport).signing.signMessage({
        address: 'bitcoincash:qqsigner',
        message: 'hello',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
