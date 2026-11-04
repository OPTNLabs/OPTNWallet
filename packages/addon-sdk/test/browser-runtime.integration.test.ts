import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createAddonWalletClient } from '../src/client';
import { connectAddonPostMessage } from '../src/transport';

describe('SDK browser runtime fixture', () => {
  it('completes a handshake and wallet request through browser MessageEvents', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'https://addon.example.test/',
    });
    const { window } = dom;
    const target = window as unknown as Window;
    const requested: string[] = [];

    const originalPostMessage = window.postMessage.bind(window);
    window.postMessage = ((message: Record<string, unknown>) => {
      const response =
        message.type === 'optn-addon-sdk-connect'
          ? {
              type: 'optn-addon-sdk-connect-response',
              protocolVersion: 1,
              requestId: message.requestId,
              ok: true,
              session: {
                sessionId: 'browser-session',
                protocolVersion: 1,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                capabilities: ['wallet:context:read'],
              },
            }
          : {
              type: 'optn-addon-sdk-response',
              protocolVersion: 1,
              requestId: message.requestId,
              ok: true,
              result: { walletId: 1, network: 'chipnet' },
            };
      if (message.type !== 'optn-addon-sdk-connect') {
        requested.push(String(message.method));
      }
      queueMicrotask(() => {
        window.dispatchEvent(
          new window.MessageEvent('message', {
            source: window,
            origin: 'https://wallet.example',
            data: response,
          })
        );
      });
    }) as typeof window.postMessage;

    try {
      const connection = await connectAddonPostMessage({
        target,
        eventTarget: target,
        targetOrigin: 'https://wallet.example',
        addonId: 'browser.fixture',
        requestedCapabilities: ['wallet:context:read'],
        timeoutMs: 1_000,
      });
      const client = createAddonWalletClient(connection.transport);
      await expect(client.wallet.getContext()).resolves.toEqual({
        walletId: 1,
        network: 'chipnet',
      });
      expect(requested).toEqual(['wallet.getContext']);
      connection.transport.dispose();
    } finally {
      window.postMessage = originalPostMessage as typeof window.postMessage;
      dom.window.close();
    }
  });

  it('carries a typed generic contract proposal through the browser transport', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://addon.example.test/' });
    const { window } = dom;
    const target = window as unknown as Window;
    const originalPostMessage = window.postMessage.bind(window);
    window.postMessage = ((message: Record<string, unknown>) => {
      const response = message.type === 'optn-addon-sdk-connect'
        ? { type: 'optn-addon-sdk-connect-response', protocolVersion: 1, requestId: message.requestId, ok: true,
            session: { sessionId: 'contract-session', protocolVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: ['contracts:propose'] } }
        : { type: 'optn-addon-sdk-response', protocolVersion: 1, requestId: message.requestId, ok: true,
            result: { proposalId: 'proposal-contract', commitmentHex: 'a'.repeat(64), walletId: 1, network: 'chipnet', sessionId: 'contract-session', grantRevision: 1, authorityEpoch: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), inputs: [], outputs: [{ recipientAddress: 'bitcoincash:qrecipient', amount: 546 }], status: 'proposed' } };
      queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', { source: window, origin: 'https://wallet.example', data: response })));
    }) as typeof window.postMessage;
    try {
      const connection = await connectAddonPostMessage({ target, eventTarget: target, targetOrigin: 'https://wallet.example', addonId: 'browser.contract', requestedCapabilities: ['contracts:propose'], timeoutMs: 1_000 });
      const client = createAddonWalletClient(connection.transport);
      const result = await client.contracts.propose({
        contract: { contractId: 'c'.repeat(64), contractName: 'Demo', contractType: 'p2sh32', lockingBytecode: '51', bytecode: 'OP_TRUE', bytesize: 1, opcount: 1, compiler: { name: 'cashc', version: '0.14.0-next' } },
        artifact: { contractName: 'Demo', constructorInputs: [], abi: [{ name: 'spend', inputs: [{ name: 'signature', type: 'sig' }] }], bytecode: 'OP_TRUE', compiler: { name: 'cashc', version: '0.14.0-next' } },
        function: { name: 'spend', args: [{ type: 'sig', signer: { address: 'bitcoincash:qsigner', purpose: 'wallet-spend' } }] },
        inputs: [], contractInputIndexes: [], outputs: [{ recipientAddress: 'bitcoincash:qrecipient', amount: 546 }],
      });
      expect(result.proposalId).toBe('proposal-contract');
      connection.transport.dispose();
    } finally {
      window.postMessage = originalPostMessage as typeof window.postMessage;
      dom.window.close();
    }
  });
});
