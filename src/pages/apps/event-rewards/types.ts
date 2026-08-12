export type WalletAirdropAsset = {
  category: string;
  nftCommitments: string[];
  tokenBalance: string;
};

export type EventAppConfig = {
  screen?: string;
  apiBaseUrl?: string;
};

export type EventBackendHealth = {
  status: string;
  workspace_count?: number;
  recipient_count?: number;
  distribution_job_count?: number;
  tokenindex_base_url?: string;
  tokenindex_configured?: boolean;
};

export type AirdropWorkspace = {
  id: string;
  name: string;
  admin_category?: string;
  default_asset_type?: 'token' | 'bch' | string;
  default_token_category?: string;
  default_amount?: string;
  created_at?: string;
};

export type DistributionRecipient = {
  id: string;
  workspace_id: string;
  label: string;
  address: string;
  notes?: string;
  source?: string;
  selected?: boolean;
  created_at?: string;
};

export type DistributionJobRecord = {
  id: string;
  workspace_id: string;
  recipient_id: string;
  destination_address: string;
  asset_type: 'token' | 'bch' | string;
  token_category?: string;
  amount: string;
  status: string;
  txid?: string | null;
  created_at?: string;
  completed_at?: string;
};
