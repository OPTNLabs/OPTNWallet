import type { Utxo } from 'cashscript';

export type WalletConnectSignedTransaction = {
  signedTransaction: string;
  signedTransactionHash: string;
};

export type WalletConnectTransactionRequest = {
  transaction: unknown;
  sourceOutputs: unknown[];
  broadcast: boolean;
  userPrompt: string;
};

export type FundMeElectrumClient = {
  getUtxos: (address: string) => Promise<Utxo[]>;
  getBlockHeight: () => Promise<number>;
  sendRawTransaction: (rawTx: string) => Promise<string>;
};
