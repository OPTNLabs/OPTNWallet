import { describe, expect, it } from 'vitest';
import { validateAddonManifestAgainstSchema } from '../AddonManifestSchema';
import type { AddonManifest } from '../../../types/addons';

describe('AddonManifestSchema', () => {
  it('accepts a minimally valid manifest', () => {
    const manifest: AddonManifest = {
      id: 'ok.addon',
      name: 'OK Addon',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [
        {
          id: 'c1',
          name: 'Contract',
          cashscriptArtifact: {},
          functions: [],
        },
      ],
    };
    expect(validateAddonManifestAgainstSchema(manifest)).toEqual([]);
  });

  it('rejects invalid trustTier', () => {
    const manifest = {
      id: 'bad.addon',
      name: 'Bad Addon',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [
        {
          id: 'c1',
          name: 'Contract',
          cashscriptArtifact: {},
          functions: [],
        },
      ],
      trustTier: 'superuser',
    } as unknown as AddonManifest;

    const errors = validateAddonManifestAgainstSchema(manifest);
    expect(errors.some((e) => e.includes('invalid trustTier'))).toBe(true);
  });
});
