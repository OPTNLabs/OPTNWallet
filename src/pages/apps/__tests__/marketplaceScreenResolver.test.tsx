import { describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import { renderDeclarativeScreen } from '../marketplaceScreenResolver';
import AirdropsApp from '../event-rewards/EventRewardsApp';
import MintCashTokensPoCApp from '../mint-cashtokens-poc/MintCashTokensPoCApp';

describe('marketplaceScreenResolver', () => {
  const manifest: AddonManifest = {
    id: 'test.addon',
    name: 'Test Addon',
    version: '1.0.0',
    permissions: [{ kind: 'none' }],
    contracts: [],
  };

  const app: AddonAppDefinition = {
    id: 'mint',
    name: 'Mint',
    kind: 'declarative',
  };

  const sdk = {
    wallet: { getContext: () => ({ walletId: 1, network: 'mainnet' }) },
  } as unknown as AddonSDK;

  it('returns MintCashTokensPoCApp element for mint screen ids', () => {
    const rendered = renderDeclarativeScreen({
      screenId: 'MintCashTokensPoCApp',
      resolved: { manifest, app },
      sdk,
      loadWalletAddresses: vi.fn().mockResolvedValue(new Set()),
    });

    expect(isValidElement(rendered)).toBe(true);
    if (isValidElement(rendered)) {
      expect(rendered.type).toBe(MintCashTokensPoCApp);
    }
  });

  it('returns null for unsupported screens', () => {
    const rendered = renderDeclarativeScreen({
      screenId: 'unknown-screen',
      resolved: { manifest, app },
      sdk,
      loadWalletAddresses: vi.fn().mockResolvedValue(new Set()),
    });

    expect(rendered).toBeNull();
  });

  it('returns AirdropsApp element for airdrop screen ids', () => {
    const rendered = renderDeclarativeScreen({
      screenId: 'EventRewardsApp',
      resolved: { manifest, app },
      sdk,
      loadWalletAddresses: vi.fn().mockResolvedValue(new Set()),
    });

    expect(isValidElement(rendered)).toBe(true);
    if (isValidElement(rendered)) {
      expect(rendered.type).toBe(AirdropsApp);
    }
  });
});
