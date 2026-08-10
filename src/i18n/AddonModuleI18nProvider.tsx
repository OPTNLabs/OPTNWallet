import { useMemo, type PropsWithChildren } from 'react';
import { useI18n } from './useI18n';
import {
  AddonI18nContext,
  type AddonI18nContextValue,
} from './AddonI18nContext';
import {
  getAddonModuleLocaleMessages,
  type AddonModuleId,
} from './addonModuleCatalog';
import { translateAddonModuleMessage } from '../services/addons/AddonLocale';

export function AddonModuleI18nProvider({
  moduleId,
  children,
}: PropsWithChildren<{ moduleId: AddonModuleId }>) {
  const { locale } = useI18n();
  const messages = getAddonModuleLocaleMessages(moduleId, locale);
  const value = useMemo<AddonI18nContextValue>(
    () => ({
      locale,
      t: (key, fallback, values) =>
        translateAddonModuleMessage(messages, key, fallback, values),
    }),
    [locale, messages]
  );

  return (
    <AddonI18nContext.Provider value={value}>
      {children}
    </AddonI18nContext.Provider>
  );
}
