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
  default: () => ({ addOutput: vi.fn(), buildTransaction: vi.fn() }),
}));

vi.mock('../../BcmrService', () => ({
  default: vi.fn().mockImplementation(() => ({
    getSnapshot: vi.fn(),
    resolveIdentityRegistry: vi.fn(),
  })),
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
    ).rejects.toThrow(/unknown SDK method/i);
  });

  it('rejects an unknown SDK module', async () => {
    const sdk = createAddonSDK(manifest, { walletId: 7, network: 'mainnet' });
    await expect(
      dispatchAddonSdkCall(sdk, 'definitelyNotARealModule', 'x', [])
    ).rejects.toThrow(/unknown SDK module/i);
  });
});
