import type { UTXO } from '../../../../types/types';
import type { TokenCapability } from '../../../../services/cashtokens';

export type MintType = 'FT' | 'NFT';
export type NftCapability = TokenCapability;

export type MintConfig = {
  mintType: MintType;
  ftAmount: string;
  nftCapability: NftCapability;
  nftCommitment: string;
  /**
   * The NFT's number when its commitment was built from one. The commitment
   * is then derived from the collection layout, and rebuilt if the layout
   * changes; without a serial the commitment is custom hex, kept as typed.
   */
  nftSerial?: string;
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
