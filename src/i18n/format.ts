import type { SupportedLocale } from './types';

export function interpolateMessage(
  message: string,
  values?: Record<string, string | number>
): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match
  );
}

export function intlLocale(locale: SupportedLocale): string {
  if (locale === 'es') return 'es-ES';
  if (locale === 'zh-CN') return 'zh-CN';
  return 'en-US';
}

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function formatDate(
  value: Date | number,
  locale: SupportedLocale,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(value);
}
