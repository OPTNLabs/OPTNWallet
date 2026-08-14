import type { AddonLocale, AddonLocaleBundle } from '../types/addons';

export type AddonModuleLocaleMessages = Record<
  AddonLocale,
  Record<string, string>
>;

export function createAddonModuleLocaleBundles(
  messagesByLocale: AddonModuleLocaleMessages,
  sharedMessagesByLocale: AddonModuleLocaleMessages = {} as AddonModuleLocaleMessages
): AddonLocaleBundle[] {
  return Object.entries(messagesByLocale).map(([locale, messages]) => ({
    locale: locale as AddonLocale,
    messages: {
      ...(sharedMessagesByLocale[locale as AddonLocale] ?? {}),
      ...messages,
    },
  }));
}
