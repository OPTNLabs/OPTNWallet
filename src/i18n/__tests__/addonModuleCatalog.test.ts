import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../types';
import {
  ADDON_MODULE_IDS,
  ADDON_MODULE_LOCALE_BUNDLES,
  getAddonModuleLocaleMessages,
} from '../addonModuleCatalog';
import { placeholderMismatch } from '../translationPolicy';

describe('add-on module locale catalogs', () => {
  it('ships every supported locale for every built-in module', () => {
    for (const moduleId of ADDON_MODULE_IDS) {
      const bundles = ADDON_MODULE_LOCALE_BUNDLES[moduleId];
      const english = bundles.find((bundle) => bundle.locale === 'en');
      expect(english).toBeDefined();
      const englishKeys = Object.keys(english?.messages ?? {}).sort();
      expect(bundles.map((bundle) => bundle.locale)).toEqual([
        ...SUPPORTED_LOCALES,
      ]);
      for (const bundle of bundles) {
        expect(Object.keys(bundle.messages).sort()).toEqual(englishKeys);
        expect(Object.keys(bundle.messages).length).toBeGreaterThan(0);
        for (const [key, value] of Object.entries(bundle.messages)) {
          expect(key.length).toBeGreaterThan(0);
          expect(value.trim().length).toBeGreaterThan(0);
          if (bundle.locale !== 'en') {
            expect(
              placeholderMismatch(english?.messages[key] ?? '', value)
            ).toBe(false);
          }
        }
      }
    }
  });

  it('resolves the selected module locale without touching core resources', () => {
    const french = getAddonModuleLocaleMessages('fundme', 'fr');
    expect(french['module.createCampaign']).toBe('Créer une campagne');
    expect(french['common.back']).toBe('Retour');
  });
});
