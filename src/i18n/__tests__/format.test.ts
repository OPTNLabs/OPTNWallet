import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatNumber,
  interpolateMessage,
  intlLocale,
} from '../format';

describe('locale formatting', () => {
  it('maps supported app locales to stable Intl locales', () => {
    expect(intlLocale('en')).toBe('en-US');
    expect(intlLocale('es')).toBe('es-ES');
    expect(intlLocale('zh-CN')).toBe('zh-CN');
    expect(intlLocale('pt-BR')).toBe('pt-BR');
    expect(intlLocale('vi')).toBe('vi-VN');
    expect(intlLocale('zh-TW')).toBe('zh-TW');
    expect(intlLocale('ar')).toBe('ar');
    expect(intlLocale('fr')).toBe('fr-FR');
    expect(intlLocale('ko')).toBe('ko-KR');
    expect(intlLocale('ja')).toBe('ja-JP');
    expect(intlLocale('ru')).toBe('ru-RU');
    expect(intlLocale('ha-NG')).toBe('ha-NG');
  });

  it('formats numbers using the selected app locale', () => {
    expect(formatNumber(12345.67, 'en')).toBe('12,345.67');
    expect(formatNumber(12345.67, 'es')).toBe('12.345,67');
    expect(formatNumber(12345.67, 'zh-CN')).toBe('12,345.67');
  });

  it('formats dates using the selected app locale', () => {
    const date = new Date('2026-01-02T00:00:00.000Z');
    const options = {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    } as const;

    expect(formatDate(date, 'en', options)).toContain('January');
    expect(formatDate(date, 'es', options)).toContain('enero');
    expect(formatDate(date, 'zh-CN', options)).toContain('1月');
  });

  it('interpolates dynamic values without removing unknown placeholders', () => {
    expect(interpolateMessage('Word {number} of {total}', { number: 3 })).toBe(
      'Word 3 of {total}'
    );
  });
});
