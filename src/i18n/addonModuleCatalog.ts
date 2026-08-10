import type { AddonLocale, AddonLocaleBundle } from '../types/addons';
import {
  AIRDROPS_LOCALE_BUNDLES,
  AIRDROPS_MODULE_ID,
} from '../pages/apps/airdrops/locales';
import {
  AUTHGUARD_LOCALE_BUNDLES,
  AUTHGUARD_MODULE_ID,
} from '../pages/apps/patient0/locales';
import {
  CAULDRON_LOCALE_BUNDLES,
  CAULDRON_MODULE_ID,
} from '../pages/apps/cauldron/locales';
import {
  FUNDME_LOCALE_BUNDLES,
  FUNDME_MODULE_ID,
} from '../pages/apps/fundme/locales';
import {
  MEMO_CASH_LOCALE_BUNDLES,
  MEMO_CASH_MODULE_ID,
} from '../pages/apps/memo-cash-reader/locales';
import {
  MINT_CASH_TOKENS_LOCALE_BUNDLES,
  MINT_CASH_TOKENS_MODULE_ID,
} from '../pages/apps/mint-cashtokens-poc/locales';
import {
  PAPER_WALLET_LOCALE_BUNDLES,
  PAPER_WALLET_MODULE_ID,
} from '../pages/apps/paper-wallet-sweep/locales';
import {
  PARYON_LOCALE_BUNDLES,
  PARYON_MODULE_ID,
} from '../pages/apps/paryon/locales';

export const ADDON_MODULE_IDS = [
  AIRDROPS_MODULE_ID,
  AUTHGUARD_MODULE_ID,
  CAULDRON_MODULE_ID,
  FUNDME_MODULE_ID,
  MEMO_CASH_MODULE_ID,
  MINT_CASH_TOKENS_MODULE_ID,
  PAPER_WALLET_MODULE_ID,
  PARYON_MODULE_ID,
] as const;

export type AddonModuleId = (typeof ADDON_MODULE_IDS)[number];

export const ADDON_MODULE_LOCALE_BUNDLES: Record<
  AddonModuleId,
  AddonLocaleBundle[]
> = {
  [AIRDROPS_MODULE_ID]: AIRDROPS_LOCALE_BUNDLES,
  [AUTHGUARD_MODULE_ID]: AUTHGUARD_LOCALE_BUNDLES,
  [CAULDRON_MODULE_ID]: CAULDRON_LOCALE_BUNDLES,
  [FUNDME_MODULE_ID]: FUNDME_LOCALE_BUNDLES,
  [MEMO_CASH_MODULE_ID]: MEMO_CASH_LOCALE_BUNDLES,
  [MINT_CASH_TOKENS_MODULE_ID]: MINT_CASH_TOKENS_LOCALE_BUNDLES,
  [PAPER_WALLET_MODULE_ID]: PAPER_WALLET_LOCALE_BUNDLES,
  [PARYON_MODULE_ID]: PARYON_LOCALE_BUNDLES,
};

export function getAddonModuleLocaleMessages(
  moduleId: AddonModuleId,
  locale: AddonLocale
): Readonly<Record<string, string>> {
  const bundles = ADDON_MODULE_LOCALE_BUNDLES[moduleId];
  return (
    bundles.find((bundle) => bundle.locale === locale)?.messages ??
    bundles.find((bundle) => bundle.locale === 'en')?.messages ??
    {}
  );
}
