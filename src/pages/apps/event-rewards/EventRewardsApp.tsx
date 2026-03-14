import React, { useState } from 'react';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import PageHeader from '../../../components/ui/PageHeader';
import SectionCard from '../../../components/ui/SectionCard';
import DistributorScreen from './screens/DistributorScreen';
import { useAirdropWalletInventory } from './hooks/useEventWalletInventory';
import type { AirdropWorkspace } from './types';

type AirdropsAppProps = {
  sdk: AddonSDK;
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

const AirdropsApp: React.FC<AirdropsAppProps> = ({ sdk, app }) => {
  const inventory = useAirdropWalletInventory(sdk);
  const [workspace] = useState<AirdropWorkspace>({
    id: 'local-distributor',
    name: 'Airdrops',
    default_asset_type: 'token',
    default_amount: '1',
  });

  return (
    <div className="wallet-page mx-auto flex h-full max-w-md flex-col overflow-hidden px-4 pt-2">
      <div className="flex-none">
        <PageHeader title={app.name} compact />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pb-24">
        <div className="space-y-4">
          {inventory.error ? (
            <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
              Wallet error: {inventory.error}
            </div>
          ) : null}

          {!inventory.addresses[0]?.address ? (
            <SectionCard title="Unavailable">
              <p className="text-sm wallet-muted">
                No wallet address is available yet.
              </p>
            </SectionCard>
          ) : null}

          {inventory.addresses[0]?.address ? (
            <DistributorScreen
              sdk={sdk}
              workspace={workspace}
              availableTokens={inventory.passes}
              feeFundingSats={inventory.feeFundingSats}
              feeFundingUtxoCount={inventory.feeFundingUtxoCount}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default AirdropsApp;
