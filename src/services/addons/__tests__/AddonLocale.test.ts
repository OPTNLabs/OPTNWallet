import { describe, expect, it } from 'vitest';
import {
  getAddonLocaleMessages,
  getLocalizedAddonAppDescription,
  getLocalizedAddonAppName,
  translateAddonMessage,
} from '../AddonLocale';
import type { AddonManifest } from '../../../types/addons';
import { BUILTIN_ADDONS } from '../../../addons/builtin';
import { SUPPORTED_LOCALES } from '../../../i18n/types';

const manifest: AddonManifest = {
  id: 'localized.addon',
  name: 'Demo Addon',
  description: 'A demo add-on',
  version: '1.0.0',
  permissions: [{ kind: 'none' }],
  contracts: [],
  localeBundles: [
    {
      locale: 'en',
      messages: {
        'app.demo.name': 'Demo',
        'app.demo.description': 'English description',
        greeting: 'Hello, {name}',
      },
    },
    {
      locale: 'es',
      messages: {
        'app.demo.name': 'Demostración',
        'app.demo.description': 'Descripción en español',
        greeting: 'Hola, {name}',
      },
    },
  ],
  apps: [
    {
      id: 'demo',
      name: 'Demo',
      description: 'A demo app',
      kind: 'declarative',
    },
  ],
};

describe('AddonLocale', () => {
  it('uses an exact locale bundle before English fallback', () => {
    expect(getAddonLocaleMessages(manifest, 'es').greeting).toBe(
      'Hola, {name}'
    );
    expect(getAddonLocaleMessages(manifest, 'fr').greeting).toBe(
      'Hello, {name}'
    );
  });

  it('translates add-on messages without changing the core catalog', () => {
    expect(
      translateAddonMessage(manifest, 'es', 'greeting', 'Fallback', {
        name: 'Ana',
      })
    ).toBe('Hola, Ana');
    expect(translateAddonMessage(manifest, 'fr', 'missing', 'Fallback')).toBe(
      'Fallback'
    );
  });

  it('uses a module catalog only after manifest messages', () => {
    expect(
      translateAddonMessage(
        manifest,
        'es',
        'module.title',
        'Fallback',
        undefined,
        { 'module.title': 'Título del módulo' }
      )
    ).toBe('Título del módulo');

    expect(
      translateAddonMessage(
        manifest,
        'es',
        'greeting',
        'Fallback',
        { name: 'Ana' },
        { greeting: 'Mensaje del módulo, {name}' }
      )
    ).toBe('Hola, Ana');
  });

  it('localizes app metadata and falls back to manifest values', () => {
    const app = manifest.apps?.[0];
    if (!app) throw new Error('test app missing');

    expect(getLocalizedAddonAppName(manifest, app, 'es')).toBe('Demostración');
    expect(getLocalizedAddonAppDescription(manifest, app, 'es')).toBe(
      'Descripción en español'
    );
    expect(getLocalizedAddonAppName(manifest, app, 'fr')).toBe('Demo');
    expect(getLocalizedAddonAppDescription(manifest, app, 'fr')).toBe(
      'English description'
    );
  });

  it('ships a locale bundle for every supported language on built-ins', () => {
    for (const builtin of BUILTIN_ADDONS) {
      expect(builtin.localeBundles?.map((bundle) => bundle.locale)).toEqual(
        expect.arrayContaining([...SUPPORTED_LOCALES])
      );
    }
  });
});
