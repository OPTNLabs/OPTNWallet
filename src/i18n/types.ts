export const SUPPORTED_LOCALES = [
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
] as const;

/**
 * Locale catalogs authored in the original localization pass. New locales
 * are composed from English plus reviewed overrides in resources.ts until
 * their complete catalogs are translated.
 */
export const BASE_LOCALES = ['en', 'es', 'zh-CN'] as const;

export type BaseLocale = (typeof BASE_LOCALES)[number];

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  vi: 'Tiếng Việt',
  ar: 'العربية',
  fr: 'Français',
  ru: 'Русский',
  ko: '한국어',
  ja: '日本語',
  'ha-NG': 'Hausa (Nigeria)',
};

export function detectSupportedLocale(
  value: string | undefined
): SupportedLocale {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.startsWith('es')) return 'es';
  if (normalized.startsWith('pt')) return 'pt-BR';
  if (normalized.startsWith('vi')) return 'vi';
  if (
    normalized.startsWith('zh-tw') ||
    normalized.startsWith('zh-hant') ||
    normalized.startsWith('zh-hk')
  ) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('ar')) return 'ar';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ru')) return 'ru';
  if (normalized.startsWith('ha')) return 'ha-NG';
  return 'en';
}

export function localeDirection(locale: SupportedLocale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
