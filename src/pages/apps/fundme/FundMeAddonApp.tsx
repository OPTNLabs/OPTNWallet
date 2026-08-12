import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition } from '../../../types/addons';
import FundMeDiscoverView from './components/FundMeDiscoverView';
import FundMeCreateView from './components/FundMeCreateView';
import FundMeDetailModal from './components/FundMeDetailModal';
import { useFundMeCampaigns } from './useFundMeCampaigns';
import type { CampaignType, ViewMode } from './types';

type FundMeAddonAppProps = {
  sdk: AddonSDK;
  app: AddonAppDefinition;
};

const FundMeAddonApp: React.FC<FundMeAddonAppProps> = ({ sdk, app }) => {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('discover');
  const [campaignType, setCampaignType] = useState<CampaignType>('active');
  const [donationDraft, setDonationDraft] = useState<string>('');
  const {
    walletAddress,
    network,
    latestBlock,
    activeCampaigns,
    stoppedCampaigns,
    archivedCampaigns,
    loadingCampaigns,
    campaignError,
    detailModal,
    createDraft,
    setCreateDraft,
    openCampaignDetail,
    closeCampaignDetail,
  } = useFundMeCampaigns(sdk);

  const displayedCampaigns =
    campaignType === 'active'
      ? activeCampaigns
      : campaignType === 'stopped'
        ? stoppedCampaigns
        : archivedCampaigns;

  const totalCampaignCount =
    activeCampaigns.length + stoppedCampaigns.length + archivedCampaigns.length;
  const totalRaisedBch = [...activeCampaigns, ...stoppedCampaigns].reduce(
    (sum, campaign) => sum + campaign.raisedSatoshis / 100_000_000,
    0
  );

  const latestKnownBlockLabel = latestBlock
    ? latestBlock.toLocaleString()
    : 'Unavailable';

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-2 pb-3 flex flex-col overflow-hidden wallet-page">
      <div className="flex-none">
        <div className="flex justify-center pt-1">
          <img
            src="/assets/images/fundme.png"
            alt="FundMe"
            className="h-16 w-16 object-contain"
          />
        </div>

        <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-3">
          <h1 className="text-2xl font-bold wallet-text-strong tracking-[-0.02em]">
            {app.name} (Demo)
          </h1>
          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="wallet-btn-danger justify-self-end px-4 py-2"
          >
            Go Back
          </button>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setViewMode('discover')}
            className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition ${
              viewMode === 'discover'
                ? 'bg-[#31d89a] text-[#08261a]'
                : 'wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong'
            }`}
          >
            Discover Campaigns
          </button>
          <button
            type="button"
            onClick={() => setViewMode('create')}
            className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition ${
              viewMode === 'create'
                ? 'bg-[#31d89a] text-[#08261a]'
                : 'wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong'
            }`}
          >
            Create Campaign
          </button>
        </div>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-hidden">
        {viewMode === 'discover' ? (
          <FundMeDiscoverView
            campaignType={campaignType}
            displayedCampaigns={displayedCampaigns}
            loadingCampaigns={loadingCampaigns}
            campaignError={campaignError}
            totalCampaignCount={totalCampaignCount}
            totalRaisedBch={totalRaisedBch}
            activeCampaignsCount={activeCampaigns.length}
            onCampaignTypeChange={setCampaignType}
            onOpenCampaignDetail={(campaign) => void openCampaignDetail(campaign)}
          />
        ) : (
          <FundMeCreateView
            createDraft={createDraft}
            latestBlock={latestBlock}
            latestKnownBlockLabel={latestKnownBlockLabel}
            network={network}
            walletAddress={walletAddress}
            onChange={setCreateDraft}
          />
        )}
      </div>

      <FundMeDetailModal
        detailModal={detailModal}
        latestKnownBlockLabel={latestKnownBlockLabel}
        donationDraft={donationDraft}
        onClose={closeCampaignDetail}
        onDonationDraftChange={setDonationDraft}
      />
    </div>
  );
};

export default FundMeAddonApp;
