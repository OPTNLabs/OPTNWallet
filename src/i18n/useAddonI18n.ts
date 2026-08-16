import { useContext } from 'react';
import {
  AddonI18nContext,
  type AddonI18nContextValue,
} from './AddonI18nContext';

export function useAddonI18n(): AddonI18nContextValue {
  const value = useContext(AddonI18nContext);
  if (!value) {
    throw new Error('useAddonI18n must be used within an AddonI18nProvider');
  }
  return value;
}
