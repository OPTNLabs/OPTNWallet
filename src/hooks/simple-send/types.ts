import { TransactionOutput, UTXO } from '../../types/types';

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

export type SimpleSendMode = 'idle' | 'review' | 'sending' | 'sent' | 'error';
export type AssetType = 'bch' | 'ft' | 'nft';

export type BuildOk = {
  ok: true;
  feeSats: number;
  totalSats: number;
  rawTx: string;
  finalOutputs: TransactionOutput[];
  changeSats: number;
  inputSum: number;
};

export type BuildErr = { ok: false; err: string };
export type BuildResult = BuildOk | BuildErr;

export type BchBuildResult =
  | {
      ok: true;
      inputs: UTXO[];
      feeSats: number;
      totalSats: number;
      rawTx: string;
      finalOutputs: TransactionOutput[];
    }
  | BuildErr;
