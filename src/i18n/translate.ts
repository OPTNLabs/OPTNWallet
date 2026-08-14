import { interpolateMessage } from './format';
import { translations, type TranslationKey } from './resources';
import type { SupportedLocale } from './types';

/** Translate copy from non-React services and Redux listeners. */
export function translate(
  locale: SupportedLocale,
  key: TranslationKey,
  values?: Record<string, string | number>
): string {
  return interpolateMessage(
    translations[locale][key] ?? translations.en[key] ?? key,
    values
  );
}
