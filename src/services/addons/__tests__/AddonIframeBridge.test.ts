// Verifies the actual security boundary an installed addon runs behind:
// dispatchAddonSdkCall must let through only what the manifest granted, and
// reject anything else — this is what stands between a sandboxed iframe and
// the wallet's capabilities, so it's tested against a REAL createAddonSDK
// instance, not a mock of the dispatcher's own logic.
import { describe, expect, it, vi } from 'vitest';
import { createAddonSDK } from '../../AddonsSDK';
import {
  dispatchAddonSdkCall,
  dispatchAddonSdkRequest,
  isValidAddonConnectRequest,
} from '../AddonIframeBridge';
import type { AddonManifest } from '../../../types/addons';

vi.mock(import('@capacitor/core'), async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@capacitor/core');
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => 'web',
      isNativePlatform: () => false,
    },
  };
});

describe('addon SDK connect request validation', () => {
  it('accepts a bounded versioned request', () => {
    expect(
      isValidAddonConnectRequest({
        type: 'optn-addon-sdk-connect',
        protocolVersion: 1,
        requestId: 'request-1',
        addonId: 'example.addon',
        requestedCapabilities: ['wallet:context:read'],
      })
    ).toBe(true);
  });

  it('rejects malformed, oversized, or unsupported requests', () => {
    expect(
      isValidAddonConnectRequest({
        type: 'optn-addon-sdk-connect',
        protocolVersion: 2,
      })
    ).toBe(false);
    expect(
      isValidAddonConnectRequest({
        type: 'optn-addon-sdk-connect',
        protocolVersion: 1,
        requestId: '',
        addonId: 'example.addon',
        requestedCapabilities: [],
      })
    ).toBe(false);
    expect(
      isValidAddonConnectRequest({
        type: 'optn-addon-sdk-connect',
        protocolVersion: 1,
        requestId: 'request-1',
        addonId: 'example.addon',
        requestedCapabilities: Array.from(
          { length: 65 },
          () => 'wallet:context:read'
        ),
      })
    ).toBe(false);
    expect(
      isValidAddonConnectRequest({
        type: 'optn-addon-sdk-connect',
        protocolVersion: 1,
        requestId: 'request-1',
        addonId: 'example.addon',
        requestedCapabilities: ['wallet:context:read', 'wallet:context:read'],
      })
    ).toBe(false);
  });
});

vi.mock('../../../apis/TransactionManager/TransactionManager', () => ({
  default: function () {
    return { addOutput: vi.fn(), buildTransaction: vi.fn() };
  },
}));

vi.mock('../../BcmrService', () => ({
  // `new BcmrService()` in the SDK: the implementation must be constructible.
  default: vi.fn().mockImplementation(function () {
    return {
      getSnapshot: vi.fn(),
      resolveIdentityRegistry: vi.fn(),
    };
  }),
}));

// Grants ONLY wallet:context:read — everything else must be rejected.
const manifest: AddonManifest = {
  id: 'test.iframe-bundle',
  name: 'Test Iframe Addon',
  version: '1.0.0',
  permissions: [
    { kind: 'capabilities', capabilities: ['wallet:context:read'] },
  ],
  contracts: [],
};

describe('dispatchAddonSdkCall', () => {
  it('allows a granted capability', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    const result = await dispatchAddonSdkCall(sdk, 'wallet', 'getContext', []);
    expect(result).toEqual({ walletId: 7, network: 'mainnet' });
  });

  it('rejects a capability NOT in the manifest', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkCall(sdk, 'wallet', 'listAddresses', [])
    ).rejects.toThrow(/permission|capability/i);
  });

  it('rejects an unknown SDK method', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkCall(sdk, 'wallet', 'definitelyNotARealMethod', [])
    ).rejects.toThrow(/unknown SDK method/i);
  });

  it('rejects an unknown SDK module', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkCall(sdk, 'definitelyNotARealModule', 'x', [])
    ).rejects.toThrow(/unknown SDK module/i);
  });

  it('rejects internal methods even when the underlying SDK object contains them', async () => {
    const sdk = createAddonSDK(
      {
        ...manifest,
        permissions: [
          {
            kind: 'capabilities',
            capabilities: ['tx:build'],
          },
        ],
      },
      {
        walletId: 7,
        network: 'mainnet',
        allowLegacyTransactionExecution: true,
      }
    );
    await expect(
      dispatchAddonSdkCall(sdk, 'tx', 'build', [{ inputs: [], outputs: [] }])
    ).rejects.toThrow(/unavailable SDK method/i);
  });

  it('adapts the versioned method/params envelope without forwarding arbitrary args', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkRequest(sdk, 'wallet.getContext', undefined)
    ).resolves.toEqual({ walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkRequest(sdk, 'wallet.listAddresses', {
        injected: 'ignored',
      })
    ).rejects.toThrow(/unexpected parameters/i);
    await expect(
      dispatchAddonSdkRequest(sdk, 'wallet.listAddresses', undefined)
    ).rejects.toThrow(/permission|capability/i);
    await expect(
      dispatchAddonSdkRequest(sdk, 'contracts.deriveAddress', {
        artifact: {},
      })
    ).rejects.toThrow(/unsupported SDK method/i);
  });

  it('bounds and serializes request parameters before dispatch', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkRequest(sdk, 'wallet.toTokenAddress', {
        address: 'a'.repeat(70_000),
      })
    ).rejects.toThrow(/exceed the SDK limit/i);
    await expect(
      dispatchAddonSdkRequest(sdk, 'wallet.toTokenAddress', {
        address: 1n,
      })
    ).rejects.toThrow(/invalid parameters/i);
  });

  it('projects internal proposal records to the public UTXO wire shape', async () => {
    const sdk = createAddonSDK(
      {
        ...manifest,
        permissions: [
          { kind: 'capabilities', capabilities: ['tx:propose'] },
        ],
      },
      {
        walletId: 7,
        network: 'chipnet',
        walletAddresses: new Set(['bitcoincash:qqinput']),
      }
    );
    const result = (await dispatchAddonSdkRequest(sdk, 'tx.propose', {
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
        { recipientAddress: 'bitcoincash:qqoutput', amount: 1_000 },
      ],
    })) as Record<string, unknown>;
    const inputs = result.inputs as Array<Record<string, unknown>>;
    expect(inputs).toEqual([
      expect.objectContaining({
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        value: 2_000,
        height: 0,
      }),
    ]);
    expect(inputs[0]).not.toHaveProperty('valueSats');
  });
});
