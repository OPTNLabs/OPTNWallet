export type AddonCapability =
  | 'wallet:context:read'
  | 'wallet:addresses:read'
  | 'utxo:wallet:read'
  | 'utxo:address:read'
  | 'utxo:address:refresh'
  | 'chain:query'
  | 'bcmr:token:read'
  | 'tokenindex:holders:read'
  | 'tx:propose'
  | 'tx:execute'
  | 'tx:operation:read'
  | 'ui:confirm'
  | 'signing:message_sign'
  | 'http:fetch_json'
  | 'contracts:derive'
  | 'contracts:propose';

export type TokenCapability = 'none' | 'mutable' | 'minting';
export type Amount = string | number | bigint;

export type AddonToken = {
  amount: Amount;
  category: string;
  nft?: {
    capability: TokenCapability;
    commitment: string;
  };
};

/** Chain-facing UTXO projection. Internal wallet and contract fields are absent. */
export type AddonUtxo = {
  address: string;
  tokenAddress?: string;
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  amount?: number;
  prefix?: string;
  token?: AddonToken | null;
};

export type AddonTransactionOutput =
  | {
      recipientAddress: string;
      amount: Amount;
      token?: AddonToken;
      opReturn?: never;
    }
  | {
      opReturn: string[];
      recipientAddress?: never;
      amount?: never;
      token?: never;
    };

export type AddonCashTokenIntent =
  | { kind: 'transfer' }
  | {
      kind: 'mint-fungible';
      category: string;
      amount: string;
      nft?: { capability: TokenCapability; commitment: string };
    }
  | {
      kind: 'mint-nft';
      category: string;
      capability: TokenCapability;
      commitment: string;
    }
  | {
      kind: 'mutate-nft';
      category: string;
      source: { capability: TokenCapability; commitment: string };
      target: { capability: TokenCapability; commitment: string };
    }
  | {
      kind: 'burn';
      category: string;
      amount?: string;
      nft?: { capability: TokenCapability; commitment: string };
    };

export type AddonTransactionProposal = {
  proposalId: string;
  commitmentHex: string;
  walletId: number;
  network: string | null;
  sessionId: string | null;
  grantRevision: number | null;
  authorityEpoch: number | null;
  createdAt: string;
  expiresAt: string;
  inputs: AddonUtxo[];
  outputs: ReadonlyArray<AddonTransactionOutput>;
  tokenIntent?: AddonCashTokenIntent;
  contract?: {
    contractId: string;
    functionName: string;
    artifactFingerprint?: string;
  };
  status: 'proposed';
};

/** CashScript artifact-compatible ABI input. */
export type AddonCashScriptAbiInput = {
  name: string;
  type: string;
};

export type AddonCashScriptAbiFunction = {
  name: string;
  inputs: readonly AddonCashScriptAbiInput[];
};

/** Public subset of the CashScript artifact format. Debug data is omitted. */
export type AddonCashScriptArtifact = {
  contractName: string;
  constructorInputs: readonly AddonCashScriptAbiInput[];
  abi: readonly AddonCashScriptAbiFunction[];
  bytecode: string;
  source?: string;
  compiler: {
    name: string;
    version: string;
    options?: {
      enforceFunctionParameterTypes?: boolean;
      enforceLocktimeGuard?: boolean;
    };
  };
  updatedAt?: string;
  fingerprint?: string;
};

export type AddonCashScriptValue =
  | { type: 'bool'; value: boolean }
  | { type: 'int'; value: string }
  | { type: 'string'; value: string }
  | { type: 'bytes' | 'byte' | `bytes${number}` | 'pubkey' | 'sig' | 'datasig'; value: string };

export type AddonCashScriptFunctionArgument =
  | AddonCashScriptValue
  | {
      type: 'sig';
      signer: { address: string; purpose: 'wallet-spend' };
    }
  | {
      type: 'datasig';
      value: string;
      signer?: { address: string; purpose: 'wallet-spend' | 'external' };
    };

export type AddonContractType = 'p2sh20' | 'p2sh32' | 'p2s';

export type AddonContractView = {
  contractId: string;
  contractName: string;
  contractType: AddonContractType;
  address?: string;
  tokenAddress?: string;
  lockingBytecode: string;
  bytecode: string;
  bytesize: number;
  opcount: number;
  artifactFingerprint?: string;
  compiler: { name: string; version: string };
};

export type AddonContractProposalRequest = {
  contract: AddonContractView;
  artifact: AddonCashScriptArtifact;
  constructorArgs?: AddonCashScriptValue[];
  function: {
    name: string;
    args: AddonCashScriptFunctionArgument[];
  };
  inputs: AddonUtxo[];
  /** Input indexes unlocked by the declared CashScript function. */
  contractInputIndexes: number[];
  outputs: ReadonlyArray<AddonTransactionOutput>;
  expiresInMs?: number;
  idempotencyKey?: string;
};

export type AddonExecutionOperation = {
  operationId: string;
  /** Chain transaction identifier, when the wallet received one. */
  txid?: string;
  status:
    | 'awaiting_approval'
    | 'signing'
    | 'submitting'
    | 'submission_unknown'
    | 'mempool'
    | 'confirmed'
    | 'rejected';
  createdAt: string;
  updatedAt: string;
  proposalId: string;
  mode: 'wallet-submit';
  sessionId: string | null;
  grantRevision: number | null;
};

export type AddonSignedMessageResponse = {
  signature: string;
  raw?: { ecdsa: string; schnorr: string; der: string };
  details?: {
    recoveryId: number;
    compressed: boolean;
    messageHash: string;
  };
  address: string;
  encoding: 'bch-signed-message';
};

export type AddonPolicyAuditEvent = {
  at: string;
  addonId: string;
  capability: AddonCapability;
  action: 'allow' | 'deny' | 'rate_limited';
};

export type AddonAddress = {
  address: string;
  tokenAddress: string;
};

export type AddonManifest = {
  schemaVersion?: 1;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  permissions: ReadonlyArray<
    | { kind: 'none' }
    | { kind: 'http'; domains: string[] }
    | { kind: 'capabilities'; capabilities: AddonCapability[] }
  >;
  /** Manifest metadata only; no contract execution/derivation API is exposed. */
  contracts: unknown[];
  apps?: unknown[];
  trustTier?: 'restricted' | 'reviewed' | 'internal';
};

export type AddonSDKInfo = {
  version: string;
  protocolVersion: number;
  modules: string[];
  methods: Record<string, readonly string[]>;
  cashTokenIntents: readonly AddonCashTokenIntent['kind'][];
  cashTokenLimits: {
    maxFungibleAmount: string;
    maxNftCommitmentBytes: number;
    tokenOutputMinimumSats: number;
  };
  limits: {
    maxProposalInputs: number;
    maxProposalOutputs: number;
    maxMessageLength: number;
    maxIdempotencyKeyLength: number;
  };
  capabilities: AddonCapability[];
};

export type AddonHttpRequest = {
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
};
