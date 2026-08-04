export const SUPPORTED_LOCALES = ['en', 'es', 'zh-CN'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
  'zh-CN': '简体中文',
};

export function detectSupportedLocale(
  value: string | undefined
): SupportedLocale {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.startsWith('es')) return 'es';
  if (normalized.startsWith('zh')) return 'zh-CN';
  return 'en';
}
