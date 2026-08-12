import type { UTXO } from '../../types/types';

export type TokenCapability = 'none' | 'mutable' | 'minting';

export type CashTokenNft = {
  capability: TokenCapability;
  commitment: string;
};

export type CashToken = {
  amount: number | bigint;
  category: string;
  nft?: CashTokenNft;
};

export type TokenFamilySummary = {
  category: string;
  totalAtomicAmount: bigint;
  tokenUtxoCount: number;
  fungibleUtxoCount: number;
  nftUtxoCount: number;
  plainNftUtxoCount: number;
  mutableNftUtxoCount: number;
  mintingNftUtxoCount: number;
  capabilities: TokenCapability[];
};

export type CapabilityEligibility = {
  category: string;
  requestedCapability: TokenCapability;
  availableCapabilities: TokenCapability[];
  hasRequestedCapability: boolean;
  hasAnyNft: boolean;
  hasFungibleHoldings: boolean;
  canUseForQuantumroot: boolean;
  blockers: string[];
};

export type CapabilityOutputKind = 'fungible' | 'nft';

export type CapabilityOutputDraft = {
  id: string;
  sourceKey: string;
  recipientAddress: string;
  kind: CapabilityOutputKind;
  fungibleAmount?: string | number | bigint;
  nftCapability?: TokenCapability;
  nftCommitment?: string;
};

export type CapabilitySourceUtxo = Pick<UTXO, 'tx_hash' | 'tx_pos' | 'token' | 'value' | 'amount'>;

export type MintPlanSourceGroup = {
  sourceKey: string;
  category: string;
  sourceCapability: TokenCapability | null;
  nftOutputCount: number;
  fungibleOutputCount: number;
  outputCount: number;
  requestedCapabilities: TokenCapability[];
};

export type MintPlan = {
  sourceGroups: MintPlanSourceGroup[];
  blockers: string[];
  ready: boolean;
};

export type MutationPlan = {
  sourceKey: string;
  category: string;
  sourceCapability: TokenCapability | null;
  requestedCapability: TokenCapability | null;
  outputCount: number;
  blockers: string[];
  ready: boolean;
};

export type NftTransitionCheck = {
  sourceCapability: TokenCapability | null;
  sourceCommitment?: string | null;
  requestedCapability?: TokenCapability | null;
  requestedCommitment?: string | null;
  outputCount: number;
};

export type NftTransitionResult =
  | { ok: true }
  | { ok: false; message: string };
