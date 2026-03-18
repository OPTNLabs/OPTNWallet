import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
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
  const navigate = useNavigate();
  const inventory = useAirdropWalletInventory(sdk);
  const [workspace] = useState<AirdropWorkspace>({
    id: 'local-distributor',
    name: 'Airdrops',
    default_asset_type: 'token',
    default_amount: '1',
  });

  return (
    <div className="wallet-page mx-auto flex h-full max-w-md flex-col overflow-hidden px-4 pt-4 pb-4">
      <div className="flex-none">
        <div className="flex justify-center">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="OPTN"
            className="h-auto w-full max-w-[260px] object-contain"
          />
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold wallet-text-strong tracking-[-0.02em]">
            {app.name}
          </h1>
          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="wallet-btn-danger px-4 py-2"
          >
            Go Back
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pt-4 pb-24">
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
