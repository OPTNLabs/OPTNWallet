import type { ReactNode } from 'react';
import type { AddonAppDefinition, AddonManifest } from '../../types/addons';
import type { AddonSDK } from '../../services/AddonsSDK';
import AuthGuardApp from './patient0/AuthGuardApp';
import AirdropsApp from './event-rewards/EventRewardsApp';
import FundMeAddonApp from './fundme/FundMeAddonApp';
import MemoCashReaderApp from './memo-cash-reader/MemoCashReaderApp';
import CauldronSwapApp from './cauldron/CauldronSwapApp';
import ParyonWorkspaceApp from './paryon/ParyonWorkspaceApp';

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

    case 'MemoCashReaderApp':
    case 'memoCashReaderApp':
      return <MemoCashReaderApp sdk={sdk} />;

    case 'EventRewardsApp':
    case 'AirdropsApp':
    case 'eventRewardsApp':
      return (
        <AirdropsApp
          manifest={resolved.manifest}
          app={resolved.app}
          sdk={sdk}
        />
      );

    case 'FundMeAddonApp':
    case 'fundmeApp':
      return (
        <FundMeAddonApp
          app={resolved.app}
          sdk={sdk}
        />
      );

    case 'CauldronSwapApp':
    case 'cauldronSwapApp':
      return (
        <CauldronSwapApp
          manifest={resolved.manifest}
          app={resolved.app}
          sdk={sdk}
        />
      );

    case 'ParyonWorkspaceApp':
    case 'paryonWorkspaceApp':
      return <ParyonWorkspaceApp sdk={sdk} app={resolved.app} />;

    default:
      return null;
  }
}
