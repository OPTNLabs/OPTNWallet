import { describe, expect, it } from 'vitest';
import { translations } from '../resources';

// A locale can be complete, non-empty, key-for-key identical to English in
// shape -- and still be showing another language entirely.
//
// Six locales shipped that way: ar, fr, ko, ja and ru carried Traditional
// Chinese and vi carried Portuguese, because the generator that inserted them
// tracked locale blocks with a pattern that only matched quoted headers, and
// most headers are bare. Every existing check passed the whole time. They ask
// whether a key is present and non-empty, which it was.
//
// Script is the part of "is this the right language" that can be asserted
// cheaply and without a language-detection dependency.
const SCRIPTS = {
  han: /[一-鿿]/u,
  kana: /[぀-ヿ]/u,
  hangul: /[가-힯]/u,
  arabic: /[؀-ۿ]/u,
  cyrillic: /[Ѐ-ӿ]/u,
} as const;

type ScriptName = keyof typeof SCRIPTS;

/**
 * Scripts each locale is allowed to contain. Empty means Latin only.
 *
 * Korean is listed as hangul alone rather than hangul plus han: the wallet's
 * Korean copy uses no hanja at all today, so allowing han would only widen the
 * hole this test exists to close.
 *
 * Japanese permits han, and that is a real limit rather than an oversight --
 * it shares Han with Chinese, and 67 of its values are legitimately kana-free
 * short nouns (言語, 設定, 資産). A rule strict enough to catch Chinese text
 * filed under `ja` would reject those, so this covers eleven locales of twelve
 * and says so instead of pretending otherwise.
 */
const ALLOWED_SCRIPTS: Record<string, readonly ScriptName[]> = {
  en: [],
  es: [],
  fr: [],
  'ha-NG': [],
  'pt-BR': [],
  vi: [],
  ar: ['arabic'],
  ru: ['cyrillic'],
  ko: ['hangul'],
  ja: ['han', 'kana'],
  'zh-CN': ['han'],
  'zh-TW': ['han'],
};

describe('i18n locale scripts', () => {
  it('declares a script policy for every shipped locale', () => {
    // Otherwise a locale added later is silently exempt from the check below.
    expect(Object.keys(translations).sort()).toEqual(
      Object.keys(ALLOWED_SCRIPTS).sort()
    );
  });

  it('writes each locale in its own script', () => {
    const offenders: string[] = [];

    for (const [locale, entries] of Object.entries(translations)) {
      const permitted = ALLOWED_SCRIPTS[locale] ?? [];
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== 'string') continue;
        for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
          if (permitted.includes(name)) continue;
          if (SCRIPTS[name].test(value)) {
            offenders.push(`${locale}/${key} is written in ${name}: ${value}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
