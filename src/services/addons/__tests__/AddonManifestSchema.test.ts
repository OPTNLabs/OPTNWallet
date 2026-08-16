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

  it('accepts an apps-only manifest with no contracts', () => {
    const manifest: AddonManifest = {
      id: 'apps.only',
      name: 'Apps Only',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [],
      apps: [
        {
          id: 'a1',
          name: 'App',
          kind: 'declarative',
        },
      ],
    };

    expect(validateAddonManifestAgainstSchema(manifest)).toEqual([]);
  });

  it('accepts locale bundles for supported locales', () => {
    const manifest: AddonManifest = {
      id: 'localized.addon',
      name: 'Localized Addon',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [],
      localeBundles: [
        { locale: 'en', messages: { 'app.title': 'Title' } },
        { locale: 'es', messages: { 'app.title': 'Título' } },
      ],
    };

    expect(validateAddonManifestAgainstSchema(manifest)).toEqual([]);
  });

  it('rejects duplicate or unsupported locale bundles', () => {
    const manifest = {
      id: 'bad.locales',
      name: 'Bad Locales',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [],
      localeBundles: [
        { locale: 'es', messages: { title: 'Uno' } },
        { locale: 'es', messages: { title: 'Dos' } },
        { locale: 'de', messages: { title: 'Titel' } },
      ],
    } as unknown as AddonManifest;

    const errors = validateAddonManifestAgainstSchema(manifest);
    expect(errors.some((e) => e.includes('duplicate locale bundle'))).toBe(
      true
    );
    expect(errors.some((e) => e.includes('unsupported locale bundle'))).toBe(
      true
    );
  });

  it('rejects non-string locale messages', () => {
    const manifest = {
      id: 'bad.message',
      name: 'Bad Message',
      version: '1.0.0',
      permissions: [{ kind: 'none' }],
      contracts: [],
      localeBundles: [{ locale: 'en', messages: { title: 123 } }],
    } as unknown as AddonManifest;

    const errors = validateAddonManifestAgainstSchema(manifest);
    expect(errors.some((e) => e.includes('invalid locale message value'))).toBe(
      true
    );
  });
});
