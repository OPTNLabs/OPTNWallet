import { createContext } from 'react';
import type { SupportedLocale } from './types';

export type AddonI18nContextValue = {
  locale: SupportedLocale;
  t: (
    key: string,
    fallback: string,
    values?: Record<string, string | number>
  ) => string;
};

export const AddonI18nContext = createContext<AddonI18nContextValue | null>(
  null
);
