// src/types/types.ts

export interface Token {
  amount: number | bigint;
  category: string;
  nft?: {
    capability: 'none' | 'mutable' | 'minting';
    commitment: string;
  };
}

// ElectrumClient related interfaces with updates
export interface UTXO {
  wallet_id?: number; // This field is used internally in our app, not part of Electrum response
  address: string;
  tokenAddress?: string;
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  amount?: number;
  prefix?: string; // Default to 'bchtest' for now
  token_data?: Token | null; // only used for fetching response from electrum server
  token?: Token | null; // token can be null in some cases
  privateKey?: Uint8Array; // Optional field for private key used in P2PKH
  contractName?: string; // For contract-related UTXOs
  abi?: object[]; // ABI for contract-related UTXOs
  id?: string;
  isPaperWallet?: boolean;
  unlocker?: any;
  // **New Fields**
  contractFunction?: string;
  contractFunctionInputs?: { [key: string]: any };
}

// TransactionHistoryItem remains the same
export interface TransactionHistoryItem {
  height: number;
  tx_hash: string;
  timestamp?: string;
  amount?: string | number;
  fee?: number; // Optional field if the transaction is from the mempool
  address?: string; // Optional field for including address
}

// Transaction Output
export type TransactionOutput =
  | {
      // Regular transaction output variant
      recipientAddress: string;
      amount: number | bigint;
      token?: Token;
      // Explicitly disallow opReturn here
      opReturn?: never;
    }
  | {
      // OP_RETURN output variant
      opReturn: string[];
      // Explicitly disallow regular transaction fields
      recipientAddress?: never;
      amount?: never;
      token?: never;
    };

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

// Signed Messages
export interface SignedMessageI {
  sign(
    message: string,
    privateKey: Uint8Array
  ): Promise<SignedMessageResponseI>;
  verify(
    message: string,
    signature: string,
    cashaddr: string,
    publicKey?: Uint8Array
  ): Promise<VerifyMessageResponseI>;
}

export interface SignedMessageRawI {
  ecdsa: string;
  schnorr: string;
  der: string;
}

export interface SignedMessageDetailsI {
  recoveryId: number;
  compressed: boolean;
  messageHash: string;
}

export interface SignedMessageResponseI {
  raw?: SignedMessageRawI;
  details?: SignedMessageDetailsI;
  signature: string;
}

export interface VerifyMessageDetailsI {
  signatureType: string;
  messageHash: string;
  signatureValid: boolean;
  publicKeyHashMatch: boolean;
  publicKeyMatch: boolean;
}

export interface VerifyMessageResponseI {
  valid: boolean;
  details?: VerifyMessageDetailsI;
}

// Wallet Address interface remains unchanged
export type Address = {
  wallet_id: number;
  address: string;
  token_address?: string;
  balance: number;
  hd_index: number;
  change_index: number;
  prefix: string;
};
