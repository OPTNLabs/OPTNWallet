import type { UTXO } from '../../../types/types';

export type PaperWalletSweepTokenGroup = {
  category: string;
  tokenUtxos: UTXO[];
  totalAmount: bigint;
  hasNft: boolean;
};

export type PaperWalletSweepPlan = {
  paperWalletAddress: string;
  destinationAddress: string;
  paperWalletUtxos: UTXO[];
  feeInputs: UTXO[];
  outputs: Array<{
    recipientAddress: string;
    amount: number | bigint;
    token?: {
      category: string;
      amount: number | bigint;
      nft?: {
        capability: 'none' | 'mutable' | 'minting';
        commitment: string;
      };
    };
  }>;
  paperWalletBchTotal: bigint;
  tokenGroups: PaperWalletSweepTokenGroup[];
};
