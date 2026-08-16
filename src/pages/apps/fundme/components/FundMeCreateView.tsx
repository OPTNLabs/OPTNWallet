import React, { type Dispatch, type SetStateAction } from 'react';

import type { CreateDraft } from '../types';
import { useAddonI18n } from '../../../../i18n/useAddonI18n';

type FundMeCreateViewProps = {
  createDraft: CreateDraft;
  latestBlock: number | null;
  latestKnownBlockLabel: string;
  network: string | null;
  walletAddress: string | null;
  onChange: Dispatch<SetStateAction<CreateDraft>>;
};

const FundMeCreateView: React.FC<FundMeCreateViewProps> = ({
  createDraft,
  latestBlock,
  latestKnownBlockLabel,
  network,
  walletAddress,
  onChange,
}) => {
  const { t: addonT } = useAddonI18n();
  const endBlockNumber = Number(createDraft.endBlock);
  const blocksAhead =
    latestBlock && Number.isFinite(endBlockNumber)
      ? Math.max(endBlockNumber - latestBlock, 0)
      : null;

  return (
    <section className="h-full min-h-0 rounded-[28px] wallet-card p-3 flex flex-col overflow-hidden">
      <div className="flex-none">
        <h2 className="text-lg font-semibold wallet-text-strong">
          {addonT('module.createTitle', 'Create campaign')}
        </h2>
        <p className="mt-0.5 text-xs wallet-muted">
          Fill in the hosted FundMe details and the on-chain settings together
          in one place.
        </p>
        <div className="mt-2 text-[11px] wallet-muted">
          {network ?? addonT('common.unavailable', 'Unavailable')} ·{' '}
          {walletAddress
            ? addonT('module.walletReady', 'Wallet ready')
            : addonT('module.walletUnavailable', 'Wallet unavailable')}
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y space-y-3 pr-1 pb-8">
        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
            {addonT('module.hostedDetails', 'Hosted campaign details')}
          </div>
          <p className="mt-2 text-sm leading-6 wallet-muted">
            These match the fields already returned by FundMe hosted campaign
            payloads.
          </p>

          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.campaignName', 'Campaign name')}
              </span>
              <input
                value={createDraft.name}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder={addonT('module.campaignName', 'My Campaign')}
                className="wallet-input mt-2 w-full"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.creatorName', 'Creator name')}
              </span>
              <input
                value={createDraft.owner}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    owner: event.target.value,
                  }))
                }
                placeholder={addonT(
                  'module.creatorName',
                  'Your name or wallet label'
                )}
                className="wallet-input mt-2 w-full"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.shortDescription', 'Short description')}
              </span>
              <textarea
                value={createDraft.shortDescription}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    shortDescription: event.target.value,
                  }))
                }
                placeholder={addonT(
                  'module.shortDescription',
                  'One short summary line for the campaign card'
                )}
                rows={3}
                className="wallet-input mt-2 w-full resize-none"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.fullDescription', 'Full description')}
              </span>
              <textarea
                value={createDraft.description}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder={addonT(
                  'module.fullDescription',
                  'Tell the full story of the campaign'
                )}
                rows={6}
                className="wallet-input mt-2 w-full resize-none"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.bannerUrl', 'Banner URL')}
              </span>
              <input
                value={createDraft.banner}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    banner: event.target.value,
                  }))
                }
                placeholder={addonT('module.bannerUrl', 'https://...')}
                className="wallet-input mt-2 w-full"
              />
            </label>
          </div>
        </div>

        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
            {addonT('module.onChainSettings', 'On-chain campaign settings')}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.targetBch', 'Target BCH')}
              </span>
              <input
                value={createDraft.targetBch}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    targetBch: event.target.value.replace(/[^0-9.]+/g, ''),
                  }))
                }
                placeholder="1.50"
                className="wallet-input mt-2 w-full"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                {addonT('module.endBlock', 'End block')}
              </span>
              <input
                value={createDraft.endBlock}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    endBlock: event.target.value.replace(/\D+/g, ''),
                  }))
                }
                placeholder={
                  latestBlock ? String(latestBlock + 4320) : '947378'
                }
                className="wallet-input mt-2 w-full"
              />
            </label>
          </div>

          <div className="mt-3 text-sm wallet-muted">
            {addonT('module.latestBlock', 'Latest known block')}:{' '}
            {latestKnownBlockLabel}.
            {blocksAhead !== null
              ? ` About ${blocksAhead.toLocaleString()} blocks ahead is roughly ${Math.round(
                  (blocksAhead * 10) / (60 * 24)
                )} days.`
              : ''}
          </div>

          <div className="mt-4 rounded-2xl border border-[var(--wallet-border)] px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
              {addonT('module.createTransaction', 'Create transaction')}
            </div>
            <p className="mt-2 text-xs wallet-muted">
              The create flow UI is now in place. The transaction button is
              intentionally disabled for now.
            </p>
            <button
              type="button"
              disabled
              className="mt-3 w-full rounded-2xl bg-[#31d89a]/40 px-4 py-3 text-sm font-semibold text-[#08261a]/70 cursor-not-allowed"
            >
              {addonT('module.createCampaign', 'Create campaign')}
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-dashed border-[var(--wallet-border)] px-4 py-3 text-sm wallet-text-strong">
          {addonT('module.draftPreview', 'Draft preview')}:{' '}
          {createDraft.name || 'Untitled campaign'} ·{' '}
          {createDraft.targetBch || '0.00'} BCH target · end block{' '}
          {createDraft.endBlock || 'not set'}
        </div>
      </div>
    </section>
  );
};

export default FundMeCreateView;
