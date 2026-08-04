import { describe, expect, it } from 'vitest';
import { translations, type TranslationKey } from '../resources';
import { SUPPORTED_LOCALES, detectSupportedLocale } from '../types';

describe('i18n resources', () => {
  it('keeps every supported locale complete and non-empty', () => {
    const englishKeys = Object.keys(translations.en).sort();

    for (const locale of SUPPORTED_LOCALES) {
      const resource = translations[locale];
      expect(Object.keys(resource).sort()).toEqual(englishKeys);
      expect(
        Object.values(resource).every((value) => value.trim().length > 0)
      ).toBe(true);
    }
  });

  it('falls back to English for unsupported persisted locale values', () => {
    expect(detectSupportedLocale('fr')).toBe('en');
    expect(detectSupportedLocale('zh-CN')).toBe('zh-CN');
    expect(detectSupportedLocale('es')).toBe('es');
  });

  it('exposes the English resource keys as the translation key type', () => {
    const key: TranslationKey = 'app.language';
    expect(translations.en[key]).toBe('Language');
  });
});
