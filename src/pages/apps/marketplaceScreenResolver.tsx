import type { ReactNode } from 'react';
import type { AddonAppDefinition, AddonManifest } from '../../types/addons';
import type { AddonSDK } from '../../services/AddonsSDK';
import AuthGuardApp from './patient0/AuthGuardApp';
import MintCashTokensPoCApp from './mint-cashtokens-poc/MintCashTokensPoCApp';

type ResolvedAppLike = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

export function renderDeclarativeScreen(params: {
  screenId: string;
  resolved: ResolvedAppLike;
  sdk: AddonSDK;
  loadWalletAddresses: () => Promise<Set<string>>;
}): ReactNode {
  const { screenId, resolved, sdk, loadWalletAddresses } = params;

  switch (screenId) {
    case 'authguard':
    case 'AuthGuard':
    case 'AuthGuardApp':
      return (
        <AuthGuardApp
          manifest={resolved.manifest}
          app={resolved.app}
          sdk={sdk}
          loadWalletAddresses={loadWalletAddresses}
        />
      );

    case 'MintCashTokensPoCApp':
    case 'mintCashTokensPoCApp':
      return <MintCashTokensPoCApp sdk={sdk} />;

    default:
      return null;
  }
}
