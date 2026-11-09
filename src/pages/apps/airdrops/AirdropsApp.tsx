import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import { useAddonI18n } from '../../../i18n/useAddonI18n';
import SectionCard from '../../../components/ui/SectionCard';
import AirdropDistributionScreen from './screens/AirdropDistributionScreen';
import { useAirdropWalletInventory } from './hooks/useAirdropWalletInventory';
import type { AirdropWorkspace } from './types';
import { getReturnPath } from '../../../utils/navigation';
import PageHeader from '../../../components/ui/PageHeader';
import RouteExitFooter from '../../../components/ui/RouteExitFooter';

type AirdropsAppProps = {
  sdk: AddonSDK;
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

const AirdropsApp: React.FC<AirdropsAppProps> = ({ sdk }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const { t: addonT } = useAddonI18n();
  const inventory = useAirdropWalletInventory(sdk);
  const [workspace] = useState<AirdropWorkspace>({
    id: 'local-distributor',
    name: 'Airdrops',
    default_asset_type: 'token',
    default_amount: '1',
  });

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] min-h-0 px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
      <div className="flex-none">
        <PageHeader title="Airdrop" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pt-4 pr-1">
        <div className="space-y-4">
          {inventory.error ? (
            <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
              {addonT('common.walletError', 'Wallet error')}: {inventory.error}
            </div>
          ) : null}

          {!inventory.addresses[0]?.address ? (
            <SectionCard title={addonT('common.unavailable', 'Unavailable')}>
              <p className="text-sm wallet-muted">
                {addonT(
                  'common.noWalletAddress',
                  'No wallet address is available yet.'
                )}
              </p>
            </SectionCard>
          ) : null}

          {inventory.addresses[0]?.address ? (
            <AirdropDistributionScreen
              sdk={sdk}
              workspace={workspace}
              availableTokens={inventory.passes}
              feeFundingSats={inventory.feeFundingSats}
              feeFundingUtxoCount={inventory.feeFundingUtxoCount}
            />
          ) : null}
        </div>
      </div>
      <RouteExitFooter
        label={addonT('common.back', 'Back')}
        onBack={() => navigate(backTarget)}
      />
    </div>
  );
};

export default AirdropsApp;
