import { describe, expect, it } from 'vitest';
import { translations, type TranslationKey } from '../resources';
import {
  SUPPORTED_LOCALES,
  detectSupportedLocale,
  localeDirection,
} from '../types';
import {
  classifyTranslation,
  isStableTermKey,
  placeholderMismatch,
} from '../translationPolicy';

describe('i18n resources', () => {
  it('keeps the language picker order stable', () => {
    expect(SUPPORTED_LOCALES).toEqual([
      'en',
      'es',
      'pt-BR',
      'zh-CN',
      'zh-TW',
      'vi',
      'ar',
      'fr',
      'ko',
      'ja',
      'ru',
      'ha-NG',
    ]);
  });

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
    expect(detectSupportedLocale('de')).toBe('en');
    expect(detectSupportedLocale('zh-CN')).toBe('zh-CN');
    expect(detectSupportedLocale('es')).toBe('es');
    expect(detectSupportedLocale('pt-BR')).toBe('pt-BR');
    expect(detectSupportedLocale('pt-PT')).toBe('pt-BR');
    expect(detectSupportedLocale('vi-VN')).toBe('vi');
    expect(detectSupportedLocale('zh-TW')).toBe('zh-TW');
    expect(detectSupportedLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(detectSupportedLocale('ar-EG')).toBe('ar');
    expect(detectSupportedLocale('fr-FR')).toBe('fr');
    expect(detectSupportedLocale('ko-KR')).toBe('ko');
    expect(detectSupportedLocale('ja-JP')).toBe('ja');
    expect(detectSupportedLocale('ru-RU')).toBe('ru');
    expect(detectSupportedLocale('ha-NG')).toBe('ha-NG');
  });

  it('exposes the English resource keys as the translation key type', () => {
    const key: TranslationKey = 'app.language';
    expect(translations.en[key]).toBe('Language');
  });

  it('keeps product names stable while translating the new locale shell', () => {
    for (const locale of [
      'pt-BR',
      'vi',
      'zh-TW',
      'ar',
      'fr',
      'ko',
      'ja',
      'ru',
      'ha-NG',
    ] as const) {
      expect(translations[locale]['app.language']).not.toBe('Language');
      expect(translations[locale]['actions.walletConnect']).toBe(
        'WalletConnect'
      );
      expect(translations[locale]['actions.wizardConnect']).toBe(
        'WizardConnect'
      );
    }
  });

  it('translates the remaining wallet controls on the settings page', () => {
    const settingsKeys = [
      'settingsRows.walletInfo',
      'settingsRows.walletInfoDescription',
      'settingsRows.exportArchive',
      'settingsRows.exportArchiveDescription',
      'settingsRows.rebuildWallet',
      'settingsRows.rebuildWalletDescription',
      'settingsPanels.walletInfo',
      'settingsPanels.exportArchive',
      'settingsPanels.rebuildWallet',
    ] as const;

    for (const locale of SUPPORTED_LOCALES.filter(
      (supportedLocale) => supportedLocale !== 'en'
    )) {
      for (const key of settingsKeys) {
        expect(translations[locale][key]).not.toBe(translations.en[key]);
      }
    }
  });

  it('does not leave Arabic user-facing copy on the English fallback', () => {
    const untranslated = Object.keys(translations.en).filter(
      (key) =>
        translations.ar[key] === translations.en[key] &&
        classifyTranslation(
          key,
          translations.en[key],
          translations.ar[key],
          'ar'
        ) === 'needs-review'
    );

    expect(untranslated).toEqual([]);
  });

  it('keeps Cash Code as the stable RPA UI name in every locale', () => {
    const brandedKeys = [
      'experimental.rpaDescription',
      'experimental.rpaWarning',
      'rpa.copySuccess',
      'rpa.derivationFailed',
      'rpa.title',
      'rpa.deriving',
      'rpa.shareDescription',
      'rpa.paycode',
    ] as const;

    for (const locale of SUPPORTED_LOCALES) {
      for (const key of brandedKeys) {
        expect(translations[locale][key]).toContain('Cash Code');
      }
    }
  });

  it('uses RTL layout only for Arabic', () => {
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('pt-BR')).toBe('ltr');
    expect(localeDirection('zh-TW')).toBe('ltr');
  });

  it('keeps interpolation variables intact', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(translations.en)) {
        expect(
          placeholderMismatch(translations.en[key], translations[locale][key])
        ).toBe(false);
      }
    }
  });

  it('uses the documented stable-term policy for stable identifiers', () => {
    expect(isStableTermKey('actions.walletConnect')).toBe(true);
    expect(
      classifyTranslation(
        'actions.walletConnect',
        translations.en['actions.walletConnect'],
        translations['pt-BR']['actions.walletConnect'],
        'pt-BR'
      )
    ).toBe('stable-term');
    expect(isStableTermKey('actions.sendDescription')).toBe(false);
  });
});
