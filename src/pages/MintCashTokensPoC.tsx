import MintCashTokensPoCApp from './apps/mint-cashtokens-poc/MintCashTokensPoCApp';
import { AddonModuleI18nProvider } from '../i18n/AddonModuleI18nProvider';

export default function MintCashTokensPoC() {
  return (
    <AddonModuleI18nProvider moduleId="mint-cashtokens">
      <MintCashTokensPoCApp />
    </AddonModuleI18nProvider>
  );
}
