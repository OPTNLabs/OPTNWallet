export type ViewMode = 'discover' | 'create';
export type CampaignType = 'active' | 'stopped' | 'archived';

export type ShortCampaignPayload = {
  name?: string;
  owner?: string;
  shortDescription?: string;
  banner?: string;
};

export type FullCampaignPayload = ShortCampaignPayload & {
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

export type ChainCampaign = {
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

export type ArchivedCampaign = {
  id: number;
  name: string;
  owner: string;
  shortDescription: string;
  banner: string;
  endLabel: string;
  status: 'archived';
};

export type CampaignRecord = ChainCampaign | ArchivedCampaign;

export type FundMeChainOutput = {
  transaction_hash: string;
  output_index: number;
  value_satoshis: number;
  nonfungible_token_capability: 'none' | 'mutable' | 'minting' | null;
  nonfungible_token_commitment: string | null;
};

export type DetailModalState = {
  campaign: CampaignRecord;
  detail: FullCampaignPayload | null;
  loading: boolean;
  error: string | null;
};

export type CreateDraft = {
  name: string;
  owner: string;
  shortDescription: string;
  description: string;
  banner: string;
  targetBch: string;
  endBlock: string;
};

export const DEFAULT_BANNER = '/assets/images/fundme.png';
