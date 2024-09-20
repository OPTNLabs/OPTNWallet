// src/types/types.ts

// ElectrumClient related interfaces with updates
export interface UTXO {
  wallet_id?: number; // This field is used internally in our app, not part of Electrum response
  address?: string;
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  amount?: number;
  prefix?: string; // Default to 'bchtest' for now
  token_data?: {
    amount: string;
    category: string;
    nft?: {
      capability: string;
      commitment: string;
    };
  } | null; // token_data can be null in some cases
  privateKey?: Uint8Array; // Optional field for private key used in P2PKH
  contractName?: string; // For contract-related UTXOs
  abi?: object[]; // ABI for contract-related UTXOs
}

// TransactionHistoryItem remains the same
export interface TransactionHistoryItem {
  height: number;
  tx_hash: string;
  fee?: number; // Optional field if the transaction is from the mempool
}

// Transaction Output
export interface TransactionOutput {
  recipientAddress: string;
  amount: number | bigint;
  token?: {
    amount: number | bigint;
    category: string;
  };
}

// Electrum Request Response type (from electrum-cash library)
export type RequestResponse =
  | object
  | string
  | number
  | boolean
  | null
  | RequestResponse[];

// HdNode interface remains unchanged
export interface HdNode {
  chainCode: Uint8Array;
  childIndex: number;
  depth: number;
  parentFingerprint: Uint8Array;
  privateKey: Uint8Array;
  valid?: boolean; // Optional, present only in rootNode
  parentIdentifier?: Uint8Array; // Optional, present only in aliceNode
}

// Wallet Address interface remains unchanged
export type Address = {
  wallet_id: number;
  address: string;
  balance: number;
  hd_index: number;
  change_index: number;
  prefix: string;
};
