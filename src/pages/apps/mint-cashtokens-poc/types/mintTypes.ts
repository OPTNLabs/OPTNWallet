import type { UTXO } from '../../../../types/types';

export type MintType = 'FT' | 'NFT';
export type NftCapability = 'none' | 'mutable' | 'minting';

export type MintConfig = {
  mintType: MintType;
  ftAmount: string;
  nftCapability: NftCapability;
  nftCommitment: string;
};

export const DEFAULT_CFG: MintConfig = {
  mintType: 'FT',
  ftAmount: '1',
  nftCapability: 'none',
  nftCommitment: '',
};

export type MintAppUtxo = UTXO;
export type MintDisplayUtxo = MintAppUtxo & { __synthetic?: 'bootstrap' };

export type MintBcmrPublication = {
  enabled: boolean;
  registryJson: string;
  uris: string[];
};

export type WalletAddressRecord = {
  address: string;
  tokenAddress: string;
};

export type MintOutputDraft = {
  id: string;
  recipientCashAddr: string;
  sourceKey: string;
  config: MintConfig;
};
