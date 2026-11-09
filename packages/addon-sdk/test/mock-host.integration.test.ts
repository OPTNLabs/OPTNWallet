import { describe, expect, it } from 'vitest';
import { createAddonWalletClient } from '../src/client';
import {
  ADDON_SDK_PROTOCOL_VERSION,
  ADDON_SDK_VERSION,
} from '../src/contract';
import {
  connectAddonPostMessage,
  createAddonPostMessageTransport,
  type AddonTransport,
} from '../src/transport';
import { createMockPublicAddonSDK } from '../../../src/services/addons/MockAddonHost';
import type { AddonManifest } from '../../../src/types/addons';

const manifest: AddonManifest = {
  id: 'test.third-party.integration',
  name: 'Third-party integration fixture',
  version: '1.0.0',
  permissions: [
    {
      kind: 'capabilities',
      capabilities: ['tx:propose', 'tx:execute'],
    },
  ],
  contracts: [],
};

describe('public package to wallet host integration', () => {
  it('keeps wallet-owned execution and returns sanitized operation state', async () => {
    const host = createMockPublicAddonSDK(manifest, {
      addresses: ['bitcoincash:qqinput'],
    });
    expect(host.meta.getInfo()).toMatchObject({
      version: ADDON_SDK_VERSION,
      protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
    });
    const transport: AddonTransport = {
      async request(method, params) {
        switch (method) {
          case 'tx.propose':
            return host.tx.propose(params as never);
          case 'tx.requestExecution':
            return host.tx.requestExecution(params as never);
          default:
            throw new Error(`Unsupported integration fixture method: ${method}`);
        }
      },
    };
    const client = createAddonWalletClient(transport);
    const secretBearingInput = {
      inputs: [
        {
          address: 'bitcoincash:qqinput',
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 2_000,
          height: 0,
          unlocker: { privateKey: 'must-not-cross-boundary' },
        } as never,
      ],
      outputs: [
        {
          recipientAddress: 'bitcoincash:qqoutput',
          amount: 1_000,
          secretInternalField: 'must-not-cross-boundary',
        } as never,
      ],
    };
    await expect(client.tx.propose(secretBearingInput as never)).rejects.toThrow(
      /executable unlockers/i
    );

    const proposal = await client.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qqinput',
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          value: 2_000,
          height: 0,
        },
      ],
      outputs: [
        {
          recipientAddress: 'bitcoincash:qqoutput',
          amount: 1_000,
        },
      ],
    });

    expect(proposal.inputs[0]).not.toHaveProperty('unlocker');
    expect(proposal.outputs[0]).not.toHaveProperty('secretInternalField');
    expect(proposal).not.toHaveProperty('idempotencyKey');
    expect(proposal).not.toHaveProperty('requestCommitmentHex');

    const operation = await client.tx.requestExecution({
      proposalId: proposal.proposalId,
      idempotencyKey: 'integration-request-1',
    });
    expect(operation).toMatchObject({
      status: 'submission_unknown',
      proposalId: proposal.proposalId,
      mode: 'wallet-submit',
    });
    expect(operation).not.toHaveProperty('privateKey');
    expect(operation).not.toHaveProperty('mnemonic');
  });

  it('completes the same flow over the authenticated postMessage transport', async () => {
    const host = createMockPublicAddonSDK(manifest, {
      addresses: ['bitcoincash:qqinput'],
    });
    const listeners = new Set<(event: MessageEvent) => void>();
    const eventTarget = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.delete(listener),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>, origin: string) {
        expect(origin).toBe('https://wallet.example');
        void (async () => {
          expect(message.sessionId).toBe('session-transport');
          const [moduleName, methodName] = String(message.method).split('.');
          const method = (host as never as Record<string, Record<string, Function>>)[
            moduleName
          ][methodName];
          const result = await method.call(
            (host as never as Record<string, Record<string, unknown>>)[moduleName],
            message.params
          );
          const response = {
            type: 'optn-addon-sdk-response',
            protocolVersion: 1,
            requestId: message.requestId,
            ok: true,
            result,
          } as unknown as MessageEvent;
          for (const listener of listeners) {
            listener({
              source: target,
              origin: 'https://wallet.example',
              data: response,
            } as unknown as MessageEvent);
          }
        })();
      },
    } as unknown as Window;
    const transport = createAddonPostMessageTransport({
      target,
      eventTarget,
      sessionId: 'session-transport',
      targetOrigin: 'https://wallet.example',
      timeoutMs: 1_000,
    });
    const client = createAddonWalletClient(transport);
    const proposal = await client.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qqinput',
          tx_hash: 'b'.repeat(64),
          tx_pos: 0,
          value: 2_000,
          height: 0,
        },
      ],
      outputs: [{ recipientAddress: 'bitcoincash:qqoutput', amount: 1_000 }],
    });
    const operation = await client.tx.requestExecution({
      proposalId: proposal.proposalId,
      idempotencyKey: 'transport-request-1',
    });
    expect(operation.status).toBe('submission_unknown');
    transport.dispose();
  });

  it('establishes a scoped session before using the public transport', async () => {
    const host = createMockPublicAddonSDK(manifest, {
      addresses: ['bitcoincash:qqinput'],
    });
    const listeners = new Set<(event: MessageEvent) => void>();
    const eventTarget = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
        listeners.delete(listener),
    } as unknown as Window;
    const target = {
      postMessage(message: Record<string, unknown>, origin: string) {
        expect(origin).toBe('https://wallet.example');
        void (async () => {
          const response =
            message.type === 'optn-addon-sdk-connect'
              ? {
                  type: 'optn-addon-sdk-connect-response',
                  protocolVersion: 1,
                  requestId: message.requestId,
                  ok: true,
                  session: {
                    sessionId: 'handshake-session',
                    protocolVersion: 1,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    capabilities: ['tx:propose', 'tx:execute'],
                  },
                }
              : {
                  type: 'optn-addon-sdk-response',
                  protocolVersion: 1,
                  requestId: message.requestId,
                  ok: true,
                  result: await (async () => {
                    const [moduleName, methodName] = String(message.method).split('.');
                    const method = (host as never as Record<string, Record<string, Function>>)[
                      moduleName
                    ][methodName];
                    return method.call(
                      (host as never as Record<string, Record<string, unknown>>)[moduleName],
                      message.params
                    );
                  })(),
                };
          for (const listener of listeners) {
            listener({
              source: target,
              origin: 'https://wallet.example',
              data: response,
            } as unknown as MessageEvent);
          }
        })();
      },
    } as unknown as Window;

    const connection = await connectAddonPostMessage({
      target,
      eventTarget,
      targetOrigin: 'https://wallet.example',
      addonId: manifest.id,
      requestedCapabilities: ['tx:propose', 'tx:execute'],
      timeoutMs: 1_000,
    });
    expect(connection.session.sessionId).toBe('handshake-session');
    expect(connection.hasCapability('tx:execute')).toBe(true);

    const client = createAddonWalletClient(connection.transport);
    const proposal = await client.tx.propose({
      inputs: [
        {
          address: 'bitcoincash:qqinput',
          tx_hash: 'c'.repeat(64),
          tx_pos: 0,
          value: 2_000,
          height: 0,
        },
      ],
      outputs: [{ recipientAddress: 'bitcoincash:qqoutput', amount: 1_000 }],
    });
    const operation = await client.tx.requestExecution({
      proposalId: proposal.proposalId,
      idempotencyKey: 'handshake-request-1',
    });
    expect(operation.status).toBe('submission_unknown');
    connection.transport.dispose();
  });
});
