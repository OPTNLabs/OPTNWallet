import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';

import type { AddonSDK } from '../../../services/AddonsSDK';
import { AddressCashStarter, MasterCategoryID } from './values';
import {
  extractCampaignFromOutput,
  normalizeCampaignListPayload,
  parseLatestBlockHeight,
  stripHexPrefix,
  decodeLittleEndianNumber,
} from './fundmeHelpers';
import type {
  ArchivedCampaign,
  ChainCampaign,
  CreateDraft,
  DetailModalState,
  FundMeChainOutput,
  FullCampaignPayload,
  ShortCampaignPayload,
  CampaignRecord,
} from './types';
import { DEFAULT_BANNER } from './types';

type UseFundMeCampaignsResult = {
  walletAddress: string | null;
  network: string | null;
  latestBlock: number | null;
  activeCampaigns: ChainCampaign[];
  stoppedCampaigns: ChainCampaign[];
  archivedCampaigns: ArchivedCampaign[];
  loadingCampaigns: boolean;
  campaignError: string | null;
  detailModal: DetailModalState | null;
  createDraft: CreateDraft;
  setCreateDraft: Dispatch<SetStateAction<CreateDraft>>;
  openCampaignDetail: (campaign: CampaignRecord) => Promise<void>;
  closeCampaignDetail: () => void;
};

export function useFundMeCampaigns(sdk: AddonSDK): UseFundMeCampaignsResult {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [latestBlock, setLatestBlock] = useState<number | null>(null);
  const [activeCampaigns, setActiveCampaigns] = useState<ChainCampaign[]>([]);
  const [stoppedCampaigns, setStoppedCampaigns] = useState<ChainCampaign[]>([]);
  const [archivedCampaigns, setArchivedCampaigns] = useState<ArchivedCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
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
        const lockingBytecodeResult = cashAddressToLockingBytecode(AddressCashStarter);
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

        const outputs = (chainResponse.data?.output ?? []) as FundMeChainOutput[];
        const hostedCampaignIds = new Set(normalizeCampaignListPayload(hostedListPayload));
        const hostedShorts = new Map<number, ShortCampaignPayload | null>();

        const chainIds = outputs
          .map((output) => {
            const commitment = stripHexPrefix(output.nonfungible_token_commitment);
            if (!commitment || commitment.length < 80) return null;
            if (commitment.slice(70, 80) === 'ffffffffff') return null;
            return decodeLittleEndianNumber(commitment.slice(70, 80));
          })
          .filter((value): value is number => value !== null);

        const uniqueIds = Array.from(new Set([...hostedCampaignIds, ...chainIds])).sort(
          (a, b) => b - a
        );

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
                  stripHexPrefix(output.nonfungible_token_commitment).slice(70, 80)
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
    } catch {
      setDetailModal({
        campaign,
        detail: null,
        loading: false,
        error: 'Campaign metadata is not currently available from fundme.cash.',
      });
    }
  };

  return {
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
    closeCampaignDetail: () => setDetailModal(null),
  };
}
