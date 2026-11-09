import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ADDON_IDS,
  hostTrustTier,
  isBuiltinAddon,
  refuseUntrustedClaims,
} from '../AddonTrust';
import { getBuiltinAddons } from '../../../addons/builtin';
import { createAddonPolicyEngine } from '../AddonPolicyEngine';
import type { AddonManifest } from '../../../types/addons';

const sideloaded = (trustTier?: AddonManifest['trustTier']): AddonManifest => ({
  id: 'example.sideloaded',
  name: 'Sideloaded',
  version: '1.0.0',
  permissions: [{ kind: 'capabilities', capabilities: ['tx:broadcast'] }],
  contracts: [],
  trustTier,
});

describe('AddonTrust', () => {
  it('names exactly the add-ons the app ships', () => {
    const shipped = getBuiltinAddons(true).map((manifest) => manifest.id);
    expect([...BUILTIN_ADDON_IDS].sort()).toEqual([...shipped].sort());
    for (const manifest of getBuiltinAddons(true)) {
      expect(hostTrustTier(manifest)).toBe('internal');
    }
  });

  it('never trusts a manifest because it says so', () => {
    for (const claim of [
      'internal',
      'reviewed',
      'restricted',
      undefined,
    ] as const) {
      expect(hostTrustTier(sideloaded(claim))).toBe('restricted');
      expect(isBuiltinAddon(sideloaded(claim))).toBe(false);
    }
  });

  it('refuses an installed add-on that takes a shipped identity or claims internal trust', () => {
    expect(() => refuseUntrustedClaims(sideloaded('internal'))).toThrow(
      /only the app can grant/
    );
    expect(() =>
      refuseUntrustedClaims({ id: 'optn.builtin.events', trustTier: undefined })
    ).toThrow(/reserved/);
    expect(() =>
      refuseUntrustedClaims({
        id: 'optn.builtin.anything-new',
        trustTier: 'restricted',
      })
    ).toThrow(/reserved/);
    for (const claim of ['reviewed', 'restricted', undefined] as const) {
      expect(() => refuseUntrustedClaims(sideloaded(claim))).not.toThrow();
    }
  });

  it('gives a claimed tier no larger quota than a restricted one', async () => {
    const quota = async (manifest: AddonManifest) => {
      const policy = createAddonPolicyEngine({ manifest });
      let allowed = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await policy.authorizeCapability('tx:broadcast');
          allowed += 1;
        } catch {
          break;
        }
      }
      return allowed;
    };
    const restricted = await quota(sideloaded('restricted'));
    expect(await quota(sideloaded('internal'))).toBe(restricted);
    expect(await quota(sideloaded('reviewed'))).toBe(restricted);
  });
});
