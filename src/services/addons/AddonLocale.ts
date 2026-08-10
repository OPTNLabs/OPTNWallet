import { interpolateMessage } from '../../i18n/format';
import type {
  AddonAppDefinition,
  AddonContractDefinition,
  AddonContractFunction,
  AddonLocale,
  AddonManifest,
} from '../../types/addons';
import type { AddonModuleId } from '../../i18n/addonModuleCatalog';

export const ADDON_MANIFEST_NAME_KEY = 'manifest.name';
export const ADDON_MANIFEST_DESCRIPTION_KEY = 'manifest.description';

function findBundle(manifest: AddonManifest, locale: AddonLocale) {
  return (
    manifest.localeBundles?.find((bundle) => bundle.locale === locale) ??
    manifest.localeBundles?.find((bundle) => bundle.locale === 'en')
  );
}

/** Return only add-on-owned messages; never merge them into core resources. */
export function getAddonLocaleMessages(
  manifest: AddonManifest,
  locale: AddonLocale
): Readonly<Record<string, string>> {
  return findBundle(manifest, locale)?.messages ?? {};
}

export function translateAddonMessage(
  manifest: AddonManifest,
  locale: AddonLocale,
  key: string,
  fallback: string,
  values?: Record<string, string | number>,
  additionalMessages?: Readonly<Record<string, string>>
): string {
  const message =
    getAddonLocaleMessages(manifest, locale)[key] ??
    additionalMessages?.[key] ??
    fallback;
  return interpolateMessage(message, values);
}

export function translateAddonModuleMessage(
  messages: Readonly<Record<string, string>>,
  key: string,
  fallback: string,
  values?: Record<string, string | number>
): string {
  return interpolateMessage(messages[key] ?? fallback, values);
}

export type { AddonModuleId };

export function getLocalizedAddonName(
  manifest: AddonManifest,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    ADDON_MANIFEST_NAME_KEY,
    manifest.name
  );
}

export function getLocalizedAddonDescription(
  manifest: AddonManifest,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    ADDON_MANIFEST_DESCRIPTION_KEY,
    manifest.description ?? ''
  );
}

function appMessageKey(app: AddonAppDefinition, field: 'name' | 'description') {
  return `app.${app.id}.${field}`;
}

function contractMessageKey(
  contract: AddonContractDefinition,
  field: 'name' | 'description'
) {
  return `contract.${contract.id}.${field}`;
}

function contractFunctionMessageKey(
  contract: AddonContractDefinition,
  fn: AddonContractFunction,
  field: 'name' | 'description'
) {
  return `contract.${contract.id}.function.${fn.id}.${field}`;
}

export function getLocalizedAddonAppName(
  manifest: AddonManifest,
  app: AddonAppDefinition,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    appMessageKey(app, 'name'),
    app.name
  );
}

export function getLocalizedAddonAppDescription(
  manifest: AddonManifest,
  app: AddonAppDefinition,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    appMessageKey(app, 'description'),
    app.description ?? ''
  );
}

export function getLocalizedAddonContractName(
  manifest: AddonManifest,
  contract: AddonContractDefinition,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    contractMessageKey(contract, 'name'),
    contract.name
  );
}

export function getLocalizedAddonContractDescription(
  manifest: AddonManifest,
  contract: AddonContractDefinition,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    contractMessageKey(contract, 'description'),
    contract.description ?? ''
  );
}

export function getLocalizedAddonContractFunctionName(
  manifest: AddonManifest,
  contract: AddonContractDefinition,
  fn: AddonContractFunction,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    contractFunctionMessageKey(contract, fn, 'name'),
    fn.name
  );
}

export function getLocalizedAddonContractFunctionDescription(
  manifest: AddonManifest,
  contract: AddonContractDefinition,
  fn: AddonContractFunction,
  locale: AddonLocale
): string {
  return translateAddonMessage(
    manifest,
    locale,
    contractFunctionMessageKey(contract, fn, 'description'),
    fn.description ?? ''
  );
}
