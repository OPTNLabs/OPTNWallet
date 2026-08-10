import { useMemo, type PropsWithChildren } from 'react';
import type { AddonManifest } from '../types/addons';
import { useI18n } from './useI18n';
import { translateAddonMessage } from '../services/addons/AddonLocale';
import {
  AddonI18nContext,
  type AddonI18nContextValue,
} from './AddonI18nContext';
import {
  getAddonModuleLocaleMessages,
  type AddonModuleId,
} from './addonModuleCatalog';

export function AddonI18nProvider({
  manifest,
  moduleId,
  children,
}: PropsWithChildren<{ manifest: AddonManifest; moduleId?: AddonModuleId }>) {
  const { locale } = useI18n();
  const value = useMemo<AddonI18nContextValue>(() => {
    const moduleMessages = moduleId
      ? getAddonModuleLocaleMessages(moduleId, locale)
      : {};
    return {
      locale,
      t: (
        key: string,
        fallback: string,
        values?: Record<string, string | number>
      ) =>
        translateAddonMessage(
          manifest,
          locale,
          key,
          fallback,
          values,
          moduleMessages
        ),
    };
  }, [locale, manifest, moduleId]);

  return (
    <AddonI18nContext.Provider value={value}>
      {children}
    </AddonI18nContext.Provider>
  );
}
