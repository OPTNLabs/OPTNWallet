// Verifies the actual security boundary an installed addon runs behind:
// dispatchAddonSdkCall must let through only what the manifest granted, and
// reject anything else — this is what stands between a sandboxed iframe and
// the wallet's capabilities, so it's tested against a REAL createAddonSDK
// instance, not a mock of the dispatcher's own logic.
import { describe, expect, it, vi } from 'vitest';
import { createAddonSDK } from '../../AddonsSDK';
import { dispatchAddonSdkCall } from '../AddonIframeBridge';
import type { AddonManifest } from '../../../types/addons';

vi.mock(import('@capacitor/core'), async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@capacitor/core');
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, getPlatform: () => 'web', isNativePlatform: () => false },
  };
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
  permissions: [{ kind: 'capabilities', capabilities: ['wallet:context:read'] }],
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
    ).rejects.toThrow(/unknown SDK/i);
  });

  it('rejects an unknown SDK module', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkCall(sdk, 'definitelyNotARealModule', 'x', [])
    ).rejects.toThrow(/unknown SDK/i);
  });

  it('refuses privileged and inherited calls before a fully granted SDK is invoked', async () => {
    const entered = vi.fn();
    // Even a host SDK that grants everything cannot promote the iframe guest.
    const sdk = {
      tx: { addOutput: entered, build: entered, broadcast: entered },
      signing: { signMessage: entered, signatureTemplateForAddress: entered },
      utxos: { refreshAndStore: entered, listForAddress: entered },
      http: { fetchJson: entered },
      chain: { getLatestBlock: entered, queryUnspentByLockingBytecode: entered },
      bcmr: { getTokenMetadata: entered, getTokenMetadataState: entered },
      tokenIndex: { listTokenHolders: entered },
      meta: { getInfo: entered, getAuditTrail: entered },
      logging: { info: entered, warn: entered, error: entered },
      ui: { confirmSensitiveAction: entered },
      wallet: { constructor: entered, toString: entered },
    } as unknown as Parameters<typeof dispatchAddonSdkCall>[0];
    for (const [module, methods] of Object.entries(sdk)) {
      for (const method of Object.keys(methods)) {
        await expect(dispatchAddonSdkCall(sdk, module, method, []))
          .rejects.toThrow(/untrusted addon guest/);
      }
    }
    expect(entered).not.toHaveBeenCalled();
  });

  it('does not elevate a guest claiming internal trust with a permissive host context', async () => {
    const capabilities = [
      'wallet:context:read', 'tx:build', 'tx:broadcast',
      'signing:message_sign', 'signing:signature_template', 'utxo:address:refresh',
    ] as const;
    const sdk = createAddonSDK({
      ...manifest,
      trustTier: 'internal',
      permissions: [{ kind: 'capabilities', capabilities: [...capabilities] }],
    }, {
      walletId: 7,
      network: 'chipnet',
      allowedCapabilities: new Set(capabilities),
      authorizeCapability: () => undefined,
    });
    expect(await dispatchAddonSdkCall(sdk, 'wallet', 'getContext', []))
      .toEqual({ walletId: 7, network: 'chipnet' });
    for (const [module, method] of [
      ['tx', 'build'], ['tx', 'broadcast'],
      ['signing', 'signMessage'], ['signing', 'signatureTemplateForAddress'],
      ['utxos', 'refreshAndStore'],
    ]) {
      await expect(dispatchAddonSdkCall(sdk, module, method, []))
        .rejects.toThrow(/untrusted addon guest/);
    }
  });
});
