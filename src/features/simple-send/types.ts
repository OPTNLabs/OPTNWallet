import { TransactionOutput, UTXO } from '../../types/types';
import type { BcmrTokenMetadataState } from '../../types/bcmr';

export type AssetType = 'bch' | 'ft' | 'nft';

export type TokenMetaMap = Record<string, BcmrTokenMetadataState>;

export type CategorySummary = {
  category: string;
  isNft: boolean;
  ftAmount: bigint;
  nftCommitments: string[];
};

export type ReviewState = {
  rawTx: string;
  feeSats: number;
  totalSats: number;
  finalOutputs: TransactionOutput[];
  tokenChange?: {
    category: string;
    amount: bigint;
  };
};

export type InputTableRow = {
  i: number;
  outpoint: string;
  address: string;
  amount: number;
  height: number;
  token: string;
  contract: string;
};

export type OutputTableRow = {
  i: number;
  type: string;
  address: string;
  amount: number;
  token: string;
  details: string;
};

export type SimpleSendInput = UTXO;
