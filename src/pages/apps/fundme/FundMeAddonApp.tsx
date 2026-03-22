import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition } from '../../../types/addons';
import { AddressCashStarter, MasterCategoryID } from './values';

type FundMeAddonAppProps = {
  sdk: AddonSDK;
  app: AddonAppDefinition;
};

type ViewMode = 'discover' | 'create';
type CampaignType = 'active' | 'stopped' | 'archived';

type ShortCampaignPayload = {
  name?: string;
  owner?: string;
  shortDescription?: string;
  banner?: string;
};

type FullCampaignPayload = ShortCampaignPayload & {
  description?: string;
  logo?: string;
  ownersAddress?: string;
  pledges?: Array<{
    campaignID?: string;
    pledgeID?: string;
    name?: string;
    message?: string;
    amount?: number | string;
  }>;
  updates?: Array<{
    number?: number;
    text?: string;
  }>;
  isComplete?: boolean;
};

type ChainCampaign = {
  id: number;
  txHash: string;
  outputIndex: number;
  capability: 'minting' | 'mutable' | 'none';
  targetSatoshis: number;
  raisedSatoshis: number;
  endBlock: number;
  endLabel: string;
  status: 'active' | 'stopped';
  name: string;
  owner: string;
  shortDescription: string;
  banner: string;
};

type ArchivedCampaign = {
  id: number;
  name: string;
  owner: string;
  shortDescription: string;
  banner: string;
  endLabel: string;
  status: 'archived';
};

type CampaignRecord = ChainCampaign | ArchivedCampaign;

type FundMeChainOutput = {
  transaction_hash: string;
  output_index: number;
  value_satoshis: number;
  nonfungible_token_capability: 'none' | 'mutable' | 'minting' | null;
  nonfungible_token_commitment: string | null;
};

type DetailModalState = {
  campaign: CampaignRecord;
  detail: FullCampaignPayload | null;
  loading: boolean;
  error: string | null;
};

type CreateDraft = {
  name: string;
  owner: string;
  shortDescription: string;
  description: string;
  banner: string;
  targetBch: string;
  endBlock: string;
};

const DEFAULT_BANNER = '/assets/images/fundme.png';

function decodeLittleEndianNumber(hex: string | null | undefined): number {
  const normalized = String(hex ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return 0;
  const bytes = normalized.match(/.{2}/g);
  if (!bytes) return 0;
  return parseInt(bytes.reverse().join(''), 16);
}

function formatBchFromSatoshis(satoshis: number): string {
  return (satoshis / 100_000_000).toFixed(4);
}

function formatBlocksRemaining(
  endBlock: number,
  latestBlock: number | null
): string {
  if (!endBlock) return 'Unknown';
  if (!latestBlock) return `Ends at ${endBlock}`;

  const blocksRemaining = Math.max(endBlock - latestBlock, 0);
  if (blocksRemaining === 0) return 'Expired';

  const totalMinutes = blocksRemaining * 10;
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function parseLatestBlockHeight(latest: unknown): number | null {
  if (!latest || typeof latest !== 'object') return null;
  const maybeHeight = (latest as { height?: unknown }).height;
  return typeof maybeHeight === 'number' ? maybeHeight : null;
}

function stripHexPrefix(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}

function extractCampaignFromOutput(args: {
  output: {
    transaction_hash: string;
    output_index: number;
    value_satoshis: number;
    nonfungible_token_capability: 'none' | 'mutable' | 'minting' | null;
    nonfungible_token_commitment: string | null;
  };
  latestBlock: number | null;
  hosted?: ShortCampaignPayload | null;
}): ChainCampaign | null {
  const { output, latestBlock, hosted } = args;
  const commitment = stripHexPrefix(output.nonfungible_token_commitment);
  if (!commitment || commitment.length < 80) return null;
  if (commitment.slice(70, 80) === 'ffffffffff') return null;
  if (
    output.nonfungible_token_capability !== 'minting' &&
    output.nonfungible_token_capability !== 'mutable'
  ) {
    return null;
  }

  const id = decodeLittleEndianNumber(commitment.slice(70, 80));
  const endBlock = decodeLittleEndianNumber(commitment.slice(52, 60));
  const targetSatoshis = decodeLittleEndianNumber(commitment.slice(0, 12));
  const status =
    output.nonfungible_token_capability === 'mutable' ? 'stopped' : 'active';

  return {
    id,
    txHash: stripHexPrefix(output.transaction_hash),
    outputIndex: output.output_index,
    capability: output.nonfungible_token_capability,
    targetSatoshis,
    raisedSatoshis: output.value_satoshis,
    endBlock,
    endLabel:
      status === 'stopped'
        ? `Stopped at ${endBlock}`
        : formatBlocksRemaining(endBlock, latestBlock),
    status,
    name: hosted?.name?.trim() || `Campaign #${id}`,
    owner: hosted?.owner?.trim() || 'FundMe',
    shortDescription:
      hosted?.shortDescription?.trim() ||
      'Campaign metadata is not currently available.',
    banner: hosted?.banner?.trim() || DEFAULT_BANNER,
  };
}

function normalizeCampaignListPayload(payload: unknown): number[] {
  if (Array.isArray(payload)) {
    return payload
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { campaigns?: unknown[] }).campaigns)
  ) {
    return ((payload as { campaigns: unknown[] }).campaigns ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  return [];
}

function isChainCampaign(campaign: CampaignRecord): campaign is ChainCampaign {
  return campaign.status === 'active' || campaign.status === 'stopped';
}

const FundMeAddonApp: React.FC<FundMeAddonAppProps> = ({ sdk, app }) => {
  const navigate = useNavigate();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [latestBlock, setLatestBlock] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('discover');
  const [campaignType, setCampaignType] = useState<CampaignType>('active');

  const [activeCampaigns, setActiveCampaigns] = useState<ChainCampaign[]>([]);
  const [stoppedCampaigns, setStoppedCampaigns] = useState<ChainCampaign[]>([]);
  const [archivedCampaigns, setArchivedCampaigns] = useState<
    ArchivedCampaign[]
  >([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
  const [donationDraft, setDonationDraft] = useState<string>('');

  const [createDraft, setCreateDraft] = useState<CreateDraft>({
    name: '',
    owner: '',
    shortDescription: '',
    description: '',
    banner: '',
    targetBch: '',
    endBlock: '',
  });

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const context = sdk.wallet.getContext();
        const primaryAddress = await sdk.wallet.getPrimaryAddress();
        const latest = await sdk.chain.getLatestBlock();

        if (!mounted) return;

        setNetwork(context.network);
        setWalletAddress(primaryAddress);
        setLatestBlock(parseLatestBlockHeight(latest));
        setCreateDraft((current) => ({
          ...current,
          owner: current.owner || primaryAddress || '',
        }));
      } catch (nextError) {
        if (!mounted) return;
        setCampaignError(
          nextError instanceof Error
            ? nextError.message
            : 'Unable to initialize FundMe.'
        );
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sdk]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoadingCampaigns(true);
      setCampaignError(null);

      try {
        const lockingBytecodeResult =
          cashAddressToLockingBytecode(AddressCashStarter);
        if (typeof lockingBytecodeResult === 'string') {
          throw new Error(lockingBytecodeResult);
        }

        const lockingBytecodeHex = binToHex(lockingBytecodeResult.bytecode);
        const [latest, chainResponse, hostedListPayload] = await Promise.all([
          sdk.chain.getLatestBlock(),
          sdk.chain.queryUnspentByLockingBytecode(
            lockingBytecodeHex,
            MasterCategoryID
          ),
          sdk.http.fetchJson<unknown>('https://fundme.cash/get-campaignlist'),
        ]);

        if (!mounted) return;

        const nextLatestBlock = parseLatestBlockHeight(latest);
        setLatestBlock(nextLatestBlock);

        const outputs = (chainResponse.data?.output ??
          []) as FundMeChainOutput[];
        const hostedCampaignIds = new Set(
          normalizeCampaignListPayload(hostedListPayload)
        );
        const hostedShorts = new Map<number, ShortCampaignPayload | null>();

        const chainIds = outputs
          .map((output) => {
            const commitment = stripHexPrefix(
              output.nonfungible_token_commitment
            );
            if (!commitment || commitment.length < 80) return null;
            if (commitment.slice(70, 80) === 'ffffffffff') return null;
            return decodeLittleEndianNumber(commitment.slice(70, 80));
          })
          .filter((value): value is number => value !== null);

        const uniqueIds = Array.from(
          new Set([...hostedCampaignIds, ...chainIds])
        ).sort((a, b) => b - a);

        await Promise.all(
          uniqueIds.map(async (id) => {
            try {
              const payload = await sdk.http.fetchJson<ShortCampaignPayload>(
                `https://fundme.cash/get-shortcampaign/${id}`
              );
              hostedShorts.set(id, payload);
            } catch {
              hostedShorts.set(id, null);
            }
          })
        );

        if (!mounted) return;

        const liveCampaigns = outputs
          .map((output) =>
            extractCampaignFromOutput({
              output,
              latestBlock: nextLatestBlock,
              hosted: hostedShorts.get(
                decodeLittleEndianNumber(
                  stripHexPrefix(output.nonfungible_token_commitment).slice(
                    70,
                    80
                  )
                )
              ),
            })
          )
          .filter((campaign): campaign is ChainCampaign => campaign !== null)
          .sort((a, b) => b.id - a.id);

        const liveIds = new Set(liveCampaigns.map((campaign) => campaign.id));
        const archived = uniqueIds
          .filter((id) => !liveIds.has(id))
          .map((id) => {
            const hosted = hostedShorts.get(id);
            return {
              id,
              name: hosted?.name?.trim() || `Campaign #${id}`,
              owner: hosted?.owner?.trim() || 'FundMe',
              shortDescription:
                hosted?.shortDescription?.trim() ||
                'Campaign metadata is not currently available.',
              banner: hosted?.banner?.trim() || DEFAULT_BANNER,
              endLabel: 'Archived',
              status: 'archived' as const,
            };
          })
          .sort((a, b) => b.id - a.id);

        setActiveCampaigns(
          liveCampaigns.filter((campaign) => campaign.status === 'active')
        );
        setStoppedCampaigns(
          liveCampaigns.filter((campaign) => campaign.status === 'stopped')
        );
        setArchivedCampaigns(archived);
      } catch (nextError) {
        if (!mounted) return;
        setCampaignError(
          nextError instanceof Error
            ? nextError.message
            : 'Unable to load FundMe campaigns.'
        );
      } finally {
        if (mounted) {
          setLoadingCampaigns(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sdk]);

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

  const openCampaignDetail = async (campaign: CampaignRecord) => {
    setDetailModal({
      campaign,
      detail: null,
      loading: true,
      error: null,
    });

    try {
      const detail = await sdk.http.fetchJson<FullCampaignPayload>(
        `https://fundme.cash/get-campaign/${campaign.id}`
      );

      setDetailModal({
        campaign,
        detail,
        loading: false,
        error: null,
      });
    } catch (error) {
      setDetailModal({
        campaign,
        detail: null,
        loading: false,
        error: 'Campaign metadata is not currently available from fundme.cash.',
      });
    }
  };

  const latestKnownBlockLabel = latestBlock
    ? latestBlock.toLocaleString()
    : 'Unavailable';
  const endBlockNumber = Number(createDraft.endBlock);
  const blocksAhead =
    latestBlock && Number.isFinite(endBlockNumber)
      ? Math.max(endBlockNumber - latestBlock, 0)
      : null;

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
            {app.name}
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
                    {activeCampaigns.length}
                  </div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-3 gap-2">
                {(['active', 'stopped', 'archived'] as CampaignType[]).map(
                  (type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setCampaignType(type)}
                      className={`rounded-2xl px-3 py-2 text-sm font-semibold capitalize transition ${
                        campaignType === type
                          ? 'bg-[#31d89a] text-[#08261a]'
                          : 'wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong'
                      }`}
                    >
                      {type}
                    </button>
                  )
                )}
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
                    ? Math.min(
                        (campaign.raisedSatoshis / campaign.targetSatoshis) *
                          100,
                        100
                      )
                    : 0;

                return (
                  <button
                    key={`${campaign.id}-${campaign.status}`}
                    type="button"
                    onClick={() => void openCampaignDetail(campaign)}
                    className="w-full rounded-[24px] wallet-surface-strong border border-[var(--wallet-border)] p-3 text-left transition hover:border-[#31d89a]"
                  >
                    <div
                      className="h-[96px] w-full rounded-2xl bg-cover bg-center"
                      style={{
                        backgroundImage: `url(${campaign.banner || DEFAULT_BANNER})`,
                      }}
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
                            style={{
                              width: `${Math.max(progressPercent, 2)}%`,
                            }}
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
                        Hosted archive entry. Open to view the stored campaign
                        description.
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="h-full min-h-0 rounded-[28px] wallet-card p-3 flex flex-col overflow-hidden">
            <div className="flex-none">
              <h2 className="text-lg font-semibold wallet-text-strong">
                Create Campaign
              </h2>
              <p className="mt-0.5 text-xs wallet-muted">
                Fill in the hosted FundMe details and the on-chain settings
                together in one place.
              </p>
              <div className="mt-2 text-[11px] wallet-muted">
                {network ?? 'Unavailable'} ·{' '}
                {walletAddress ? 'Wallet ready' : 'Wallet unavailable'}
              </div>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y space-y-3 pr-1 pb-8">
              <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                  Hosted Campaign Details
                </div>
                <p className="mt-2 text-sm leading-6 wallet-muted">
                  These match the fields already returned by FundMe hosted
                  campaign payloads.
                </p>

                <div className="mt-4 space-y-4">
                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Campaign Name
                    </span>
                    <input
                      value={createDraft.name}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="My Campaign"
                      className="wallet-input mt-2 w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Creator Name
                    </span>
                    <input
                      value={createDraft.owner}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          owner: event.target.value,
                        }))
                      }
                      placeholder="Your name or wallet label"
                      className="wallet-input mt-2 w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Short Description
                    </span>
                    <textarea
                      value={createDraft.shortDescription}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          shortDescription: event.target.value,
                        }))
                      }
                      placeholder="One short summary line for the campaign card"
                      rows={3}
                      className="wallet-input mt-2 w-full resize-none"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Full Description
                    </span>
                    <textarea
                      value={createDraft.description}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      placeholder="Tell the full story of the campaign"
                      rows={6}
                      className="wallet-input mt-2 w-full resize-none"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Banner URL
                    </span>
                    <input
                      value={createDraft.banner}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          banner: event.target.value,
                        }))
                      }
                      placeholder="https://..."
                      className="wallet-input mt-2 w-full"
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                  On-Chain Campaign Settings
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Target BCH
                    </span>
                    <input
                      value={createDraft.targetBch}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          targetBch: event.target.value.replace(
                            /[^0-9.]+/g,
                            ''
                          ),
                        }))
                      }
                      placeholder="1.50"
                      className="wallet-input mt-2 w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      End Block
                    </span>
                    <input
                      value={createDraft.endBlock}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
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
                  Latest known block: {latestKnownBlockLabel}.
                  {blocksAhead !== null
                    ? ` About ${blocksAhead.toLocaleString()} blocks ahead is roughly ${Math.round(
                        (blocksAhead * 10) / (60 * 24)
                      )} days.`
                    : ''}
                </div>

                <div className="mt-4 rounded-2xl border border-[var(--wallet-border)] px-3 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                    Create Transaction
                  </div>
                  <p className="mt-2 text-xs wallet-muted">
                    The create flow UI is now in place. The transaction button is intentionally disabled for now.
                  </p>
                  <button
                    type="button"
                    disabled
                    className="mt-3 w-full rounded-2xl bg-[#31d89a]/40 px-4 py-3 text-sm font-semibold text-[#08261a]/70 cursor-not-allowed"
                  >
                    Create Campaign
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-dashed border-[var(--wallet-border)] px-4 py-3 text-sm wallet-text-strong">
                Draft preview: {createDraft.name || 'Untitled campaign'} ·{' '}
                {createDraft.targetBch || '0.00'} BCH target · end block{' '}
                {createDraft.endBlock || 'not set'}
              </div>
            </div>
          </section>
        )}
      </div>

      {detailModal
        ? createPortal(
            <div
              className="fixed inset-0 z-[1000] bg-black/60"
              onClick={() => setDetailModal(null)}
            >
              <div
                className="absolute left-1/2 top-[10dvh] bottom-[calc(var(--navbar-height)+var(--safe-bottom)+6px)] flex w-[calc(100vw-40px)] max-w-[18.5rem] -translate-x-1/2 flex-col rounded-[20px] wallet-card shadow-2xl overflow-hidden"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex flex-none items-start justify-between gap-3 border-b border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-4 py-3">
                  <div className="min-w-0">
                    <h3 className="mt-1 text-lg font-semibold wallet-text-strong leading-tight">
                      {detailModal.campaign.name}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailModal(null)}
                    className="wallet-btn-danger shrink-0 px-3 py-2 text-sm"
                  >
                    Close
                  </button>
                </div>

                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y px-3 py-3"
                  style={{ WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="space-y-3">
                    <div
                      className="h-[72px] w-full rounded-2xl bg-cover bg-center"
                      style={{
                        backgroundImage: `url(${detailModal.detail?.banner || detailModal.campaign.banner || DEFAULT_BANNER})`,
                      }}
                    />

                    <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs wallet-muted">
                            Campaign #{detailModal.campaign.id} by{' '}
                            {detailModal.detail?.owner ||
                              detailModal.campaign.owner}
                          </div>
                          <div className="mt-1 text-sm wallet-text-strong">
                            Status: {detailModal.campaign.status}
                          </div>
                        </div>
                        <span className="rounded-full px-3 py-1 text-xs font-semibold wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong">
                          {detailModal.campaign.endLabel}
                        </span>
                      </div>

                      {isChainCampaign(detailModal.campaign) ? (
                        <div className="mt-4">
                          <div className="h-2 rounded-full bg-black/25 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[#31d89a]"
                              style={{
                                width: `${Math.max(
                                  Math.min(
                                    (detailModal.campaign.raisedSatoshis /
                                      Math.max(
                                        detailModal.campaign.targetSatoshis,
                                        1
                                      )) *
                                      100,
                                    100
                                  ),
                                  2
                                )}%`,
                              }}
                            />
                          </div>
                          <div className="mt-2 text-xs wallet-muted">
                            {formatBchFromSatoshis(
                              detailModal.campaign.raisedSatoshis
                            )}{' '}
                            /{' '}
                            {formatBchFromSatoshis(
                              detailModal.campaign.targetSatoshis
                            )}{' '}
                            BCH
                          </div>
                          <div className="mt-1 text-xs wallet-muted">
                            End block:{' '}
                            {detailModal.campaign.endBlock.toLocaleString()} ·
                            Latest block: {latestKnownBlockLabel}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {detailModal.loading ? (
                      <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-6 text-center wallet-muted">
                        Loading campaign details...
                      </div>
                    ) : null}

                    {detailModal.error ? (
                      <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-4 text-sm wallet-muted">
                        {detailModal.error}
                      </div>
                    ) : null}

                    {!detailModal.loading && !detailModal.error ? (
                      <>
                        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                          <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                            Overview
                          </div>
                          <p className="mt-2 text-sm leading-6 wallet-muted">
                            {detailModal.detail?.shortDescription ||
                              detailModal.campaign.shortDescription}
                          </p>
                          {detailModal.detail?.description ? (
                            <div
                              className="mt-3 rounded-xl border border-[var(--wallet-border)] px-3 py-3 text-sm leading-6 wallet-muted [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
                              dangerouslySetInnerHTML={{
                                __html: detailModal.detail.description,
                              }}
                            />
                          ) : null}
                        </div>

                        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                          <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                            Pledges
                          </div>
                          <div className="mt-3 text-sm wallet-text-strong">
                            {detailModal.detail?.pledges?.length ?? 0} pledge
                            entries
                          </div>
                          <p className="mt-2 text-sm wallet-muted">
                            Transaction actions are still being reattached after
                            the native screen loss, so this restore focuses on
                            campaign browsing and creation UI first.
                          </p>
                        </div>

                        {isChainCampaign(detailModal.campaign) ? (
                          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                            <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                              Donate
                            </div>
                            <p className="mt-2 text-xs wallet-muted">
                              Donation transaction controls are visible here now. The action stays disabled until the native call path is reattached.
                            </p>
                            <div className="mt-3 flex items-center gap-2">
                              <input
                                value={donationDraft}
                                onChange={(event) =>
                                  setDonationDraft(
                                    event.target.value.replace(/[^0-9.]+/g, '')
                                  )
                                }
                                placeholder="0.01000000"
                                className="wallet-input min-w-0 flex-1"
                              />
                              <button
                                type="button"
                                disabled
                                className="rounded-2xl bg-[#31d89a]/40 px-4 py-3 text-sm font-semibold text-[#08261a]/70 cursor-not-allowed"
                              >
                                Donate
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
};

export default FundMeAddonApp;
