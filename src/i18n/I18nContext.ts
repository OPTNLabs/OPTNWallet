import { createContext } from 'react';
import type { SupportedLocale } from './types';
import type { TranslationKey } from './resources';

export type I18nContextValue = {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
};

export const I18nContext = createContext<I18nContextValue | null>(null);
