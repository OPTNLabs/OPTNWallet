import React from 'react';

import type { CampaignRecord, CampaignType } from '../types';
import { formatBchFromSatoshis, isChainCampaign } from '../fundmeHelpers';

type FundMeDiscoverViewProps = {
  campaignType: CampaignType;
  displayedCampaigns: CampaignRecord[];
  loadingCampaigns: boolean;
  campaignError: string | null;
  totalCampaignCount: number;
  totalRaisedBch: number;
  activeCampaignsCount: number;
  onCampaignTypeChange: (type: CampaignType) => void;
  onOpenCampaignDetail: (campaign: CampaignRecord) => void;
};

const FundMeDiscoverView: React.FC<FundMeDiscoverViewProps> = ({
  campaignType,
  displayedCampaigns,
  loadingCampaigns,
  campaignError,
  totalCampaignCount,
  totalRaisedBch,
  activeCampaignsCount,
  onCampaignTypeChange,
  onOpenCampaignDetail,
}) => {
  return (
    <section className="h-full min-h-0 rounded-[28px] wallet-card p-3 flex flex-col overflow-hidden">
      <div className="flex-none">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] wallet-muted">
              Campaigns
            </div>
            <div className="mt-1 text-lg font-semibold wallet-text-strong">
              {totalCampaignCount}
            </div>
          </div>
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] wallet-muted">
              Raised
            </div>
            <div className="mt-1 text-lg font-semibold wallet-text-strong">
              {totalRaisedBch.toFixed(2)}
            </div>
          </div>
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] wallet-muted">
              Live
            </div>
            <div className="mt-1 text-lg font-semibold wallet-text-strong">
              {activeCampaignsCount}
            </div>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          {(['active', 'stopped', 'archived'] as CampaignType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onCampaignTypeChange(type)}
              className={`rounded-2xl px-3 py-2 text-sm font-semibold capitalize transition ${
                campaignType === type
                  ? 'bg-[#31d89a] text-[#08261a]'
                  : 'wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y space-y-3 pr-1 pb-6">
        {campaignError ? (
          <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
            {campaignError}
          </div>
        ) : null}

        {loadingCampaigns ? (
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-6 text-center wallet-muted">
            Loading campaigns...
          </div>
        ) : null}

        {!loadingCampaigns && displayedCampaigns.length === 0 ? (
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-6 text-center wallet-muted">
            No {campaignType} campaigns are available right now.
          </div>
        ) : null}

        {displayedCampaigns.map((campaign) => {
          const progressPercent =
            isChainCampaign(campaign) && campaign.targetSatoshis > 0
              ? Math.min((campaign.raisedSatoshis / campaign.targetSatoshis) * 100, 100)
              : 0;

          return (
            <button
              key={`${campaign.id}-${campaign.status}`}
              type="button"
              onClick={() => onOpenCampaignDetail(campaign)}
              className="w-full rounded-[24px] wallet-surface-strong border border-[var(--wallet-border)] p-3 text-left transition hover:border-[#31d89a]"
            >
              <div
                className="h-[96px] w-full rounded-2xl bg-cover bg-center"
                style={{ backgroundImage: `url(${campaign.banner})` }}
              />

              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold wallet-text-strong leading-tight">
                    {campaign.name}
                  </h3>
                  <p className="mt-1 text-xs wallet-muted">
                    Campaign #{campaign.id} by {campaign.owner}
                  </p>
                </div>
                <span className="rounded-full px-3 py-1 text-xs font-semibold wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong shrink-0">
                  {campaign.endLabel}
                </span>
              </div>

              <p className="mt-2 text-sm leading-6 wallet-muted">
                {campaign.shortDescription}
              </p>

              {isChainCampaign(campaign) ? (
                <>
                  <div className="mt-3 h-2 rounded-full bg-black/25 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#31d89a]"
                      style={{ width: `${Math.max(progressPercent, 2)}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="wallet-muted">
                      {formatBchFromSatoshis(campaign.raisedSatoshis)} /{' '}
                      {formatBchFromSatoshis(campaign.targetSatoshis)} BCH
                    </span>
                    <span className="wallet-text-strong">
                      {progressPercent.toFixed(1)}%
                    </span>
                  </div>
                </>
              ) : (
                <div className="mt-4 text-sm wallet-muted">
                  Hosted archive entry. Open to view the stored campaign description.
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default FundMeDiscoverView;
