import { describe, expect, it } from 'vitest';
import { assertUrlAllowedForAddon } from '../AddonsAllowlist';
import type { AddonManifest } from '../../types/addons';

const internalManifest: AddonManifest = {
  id: 'optn.builtin.events',
  name: 'Airdrops',
  version: '0.0.1',
  trustTier: 'internal',
  permissions: [
    {
      kind: 'capabilities',
      capabilities: ['http:fetch_json'],
    },
    {
      kind: 'http',
      domains: ['events.optnlabs.com'],
    },
  ],
  contracts: [],
};

describe('AddonsAllowlist local dev handling', () => {
  it('allows internal addons to call localhost over http in dev mode', () => {
    expect(() =>
      assertUrlAllowedForAddon(
        internalManifest,
        'http://127.0.0.1:8787/health',
        { devMode: true }
      )
    ).not.toThrow();
  });

  it('rejects localhost over http outside dev mode', () => {
    expect(() =>
      assertUrlAllowedForAddon(
        internalManifest,
        'http://127.0.0.1:8787/health',
        { devMode: false }
      )
    ).toThrow('non-https URL');
  });
});
