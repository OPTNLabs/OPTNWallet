// src/services/AddonsSDK.ts

// @ts-nocheck WIP addon system; see docs/wip-typecheck-exclusions.md
import type { AddonCapability, AddonManifest } from '../types/addons';
import {
  assertUrlAllowedForAddon,
  getAddonGrantedCapabilities,
  validateAddonPermissions,
} from './AddonsAllowlist';
import { CapacitorHttp } from '@capacitor/core';
import { isNativePlatform } from '../utils/platform';

import ElectrumService from './ElectrumService';
import TransactionService, { type BroadcastResult } from './TransactionService';
import OutboundTransactionTracker from './OutboundTransactionTracker';
import UTXOService from './UTXOService';
import AddressManager from '../apis/AddressManager/AddressManager';
import {
  queryUnspentOutputsByLockingBytecode,
  type GraphQLResponse,
} from '../apis/ChaingraphManager/ChaingraphManager';
import {
  createAddonPolicyEngine,
  type AddonPolicyAuditEvent,
} from './addons/AddonPolicyEngine';
import { validateAddonManifestAgainstSchema } from './addons/AddonManifestSchema';
import {
  ADDON_SDK_LIMITS,
  getAddonSDKInfo,
  type AddonSDKInfo,
} from './addons/SDKContract';
import type { BcmrSnapshot, BcmrTokenMetadataState } from '../types/bcmr';

import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { createWalletCashScriptContract } from './addons/CashScriptCompatibility';

import KeyService from './KeyService';
import BcmrService from './BcmrService';
import {
  SignatureTemplate,
  SighashType,
  ElectrumNetworkProvider,
} from 'cashscript';
import { sha256, encodeString } from '@cashscript/utils';
import parseInputValue from '../utils/parseInputValue';
import { assertAddonProposalExecutable } from './addons/AddonExecutionPreflight';
import type { AddonExecutionAuthority } from './addons/AddonExecutionAuthority';
import {
  MAX_CASHTOKEN_AMOUNT,
  MAX_NFT_COMMITMENT_HEX_LENGTH,
} from './addons/CashTokenProposalValidator';

import type {
  BcmrTokenMetadata,
  SignedMessageResponseI,
  UTXO,
  TransactionOutput,
} from '../types/types';
import type { TokenCapability } from './cashtokens';

const MAX_ADDON_IDEMPOTENCY_KEY_LENGTH = 256;

const toProviderNetwork = (
  network: string | null | undefined
): ConstructorParameters<typeof ElectrumNetworkProvider>[0] => {
  return network === 'chipnet' ? 'chipnet' : 'mainnet';
};

const getConstructorInputType = (
  artifact: unknown,
  index: number
): string | undefined => {
  if (!artifact || typeof artifact !== 'object') return undefined;
  if (!('constructorInputs' in artifact)) return undefined;
  const ctorInputs = (artifact as { constructorInputs?: unknown })
    .constructorInputs;
  if (!Array.isArray(ctorInputs)) return undefined;
  const input = ctorInputs[index];
  if (!input || typeof input !== 'object') return undefined;
  const maybeType = (input as { type?: unknown }).type;
  return typeof maybeType === 'string' ? maybeType : undefined;
};

function outpointKey(utxo: { tx_hash: string; tx_pos: number }): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === 'bigint' ? current.toString() : current
  );
}

const MAX_BCH_SATS = 21_000_000n * 100_000_000n;
const MAX_PROPOSAL_INPUTS = ADDON_SDK_LIMITS.maxProposalInputs;
const MAX_PROPOSAL_OUTPUTS = ADDON_SDK_LIMITS.maxProposalOutputs;

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

function normalizeNft(value: unknown, label: string) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} NFT metadata is invalid`);
  }
  const nft = value as Record<string, unknown>;
  const capability = nft.capability;
  const commitment = String(nft.commitment ?? '').toLowerCase();
  if (
    capability !== 'none' &&
    capability !== 'mutable' &&
    capability !== 'minting'
  ) {
    throw new Error(`${label} NFT capability is invalid`);
  }
  if (
    !/^[0-9a-f]*$/.test(commitment) ||
    commitment.length % 2 !== 0 ||
    commitment.length > MAX_NFT_COMMITMENT_HEX_LENGTH
  ) {
    throw new Error(`${label} NFT commitment is invalid`);
  }
  return { capability, commitment } as {
    capability: TokenCapability;
    commitment: string;
  };
}

function normalizeTokenIntent(
  value: unknown
): AddonCashTokenIntent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object')
    throw new Error('Token intent is invalid');
  const intent = value as Record<string, unknown>;
  const kind = intent.kind;
  if (kind === 'transfer') return { kind };
  const category = String(intent.category ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(category)) {
    throw new Error('Token intent category is invalid');
  }
  if (kind === 'mint-fungible') {
    const amount = BigInt(intent.amount as string | number | bigint);
    if (amount <= 0n || amount > MAX_CASHTOKEN_AMOUNT) {
      throw new Error('Token mint amount is outside the CashTokens range');
    }
    const nft =
      intent.nft === undefined
        ? undefined
        : normalizeNft(intent.nft, 'Token fungible mint');
    return {
      kind,
      category,
      amount: amount.toString(),
      ...(nft ? { nft } : {}),
    };
  }
  if (kind === 'mint-nft') {
    const nft = normalizeNft(
      { capability: intent.capability, commitment: intent.commitment },
      'Token mint'
    );
    return { kind, category, ...nft };
  }
  if (kind === 'mutate-nft') {
    const source = normalizeNft(intent.source, 'Token mutation source');
    const target = normalizeNft(intent.target, 'Token mutation target');
    return { kind, category, source, target };
  }
  if (kind === 'burn') {
    const amount =
      intent.amount === undefined
        ? undefined
        : BigInt(intent.amount as string | number | bigint);
    if (
      amount !== undefined &&
      (amount <= 0n || amount > MAX_CASHTOKEN_AMOUNT)
    ) {
      throw new Error('Token burn amount is outside the CashTokens range');
    }
    const nft =
      intent.nft === undefined
        ? undefined
        : normalizeNft(intent.nft, 'Token burn');
    return {
      kind,
      category,
      ...(amount === undefined ? {} : { amount: amount.toString() }),
      ...(nft ? { nft } : {}),
    };
  }
  throw new Error(`Unsupported token intent: ${String(kind)}`);
}

function normalizeProposalOutputs(
  outputs: unknown[]
): ReadonlyArray<TransactionOutput> {
  return outputs.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Transaction proposal output ${index} is invalid`);
    }
    const value = raw as Record<string, unknown>;
    if (Array.isArray(value.opReturn)) {
      if (
        value.opReturn.length > 20 ||
        value.opReturn.some((item) => typeof item !== 'string')
      ) {
        throw new Error(`Transaction proposal OP_RETURN ${index} is invalid`);
      }
      return { opReturn: value.opReturn.slice() } as TransactionOutput;
    }
    const recipientAddress = String(
      value.recipientAddress ?? value.address ?? ''
    ).trim();
    const amountValue = value.amount ?? value.value;
    if (!recipientAddress || amountValue === undefined) {
      throw new Error(`Transaction proposal output ${index} is incomplete`);
    }
    const amount = BigInt(amountValue as string | number | bigint);
    if (amount < 0n || amount > MAX_BCH_SATS) {
      throw new Error(
        `Transaction proposal output ${index} has an invalid BCH amount`
      );
    }
    const token = value.token;
    let normalizedToken:
      | {
          amount: bigint;
          category: string;
          nft?: { capability: TokenCapability; commitment: string };
        }
      | undefined;
    if (token !== undefined) {
      if (!token || typeof token !== 'object')
        throw new Error(`Transaction proposal token ${index} is invalid`);
      const tokenValue = token as Record<string, unknown>;
      const category = String(tokenValue.category ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(category))
        throw new Error(
          `Transaction proposal token ${index} has an invalid category`
        );
      const tokenAmount = BigInt(tokenValue.amount as string | number | bigint);
      if (
        tokenAmount < 0n ||
        tokenAmount > MAX_CASHTOKEN_AMOUNT ||
        (tokenValue.nft === undefined && tokenAmount === 0n)
      )
        throw new Error(
          `Transaction proposal token ${index} has an invalid amount`
        );
      normalizedToken = {
        amount: tokenAmount,
        category,
        ...(tokenValue.nft !== undefined
          ? {
              nft: normalizeNft(
                tokenValue.nft,
                `Transaction proposal token ${index}`
              ),
            }
          : {}),
      };
    }
    return {
      recipientAddress,
      amount,
      ...(normalizedToken ? { token: normalizedToken } : {}),
    } as TransactionOutput;
  });
}

export type AddonProposalStore = {
  get(proposalId: string): Promise<AddonTransactionProposal | undefined>;
  put(args: {
    proposal: AddonTransactionProposal;
    idempotencyKey?: string;
    requestCommitmentHex: string;
  }): Promise<
    | { kind: 'stored'; proposal: AddonTransactionProposal }
    | { kind: 'existing'; proposal: AddonTransactionProposal }
  >;
  delete(proposalId: string): Promise<void>;
};

export type AddonExecutionResult = {
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
};

export type AddonExecutionOperation = AddonExecutionResult & {
  createdAt: string;
  updatedAt: string;
  proposalId: string;
  mode: 'wallet-submit' | 'signed-export';
  sessionId: string | null;
  grantRevision: number | null;
};

export type AddonOperationStore = {
  get(operationId: string): Promise<AddonExecutionOperation | undefined>;
  list?(): Promise<AddonExecutionOperation[]>;
  getByProposalId?(
    proposalId: string
  ): Promise<AddonExecutionOperation | undefined>;
  getByIdempotencyKey?(
    key: string
  ): Promise<AddonExecutionOperation | undefined>;
  put(
    operation: AddonExecutionOperation,
    idempotencyKey?: string
  ): Promise<void>;
};

export type AddonSDKContext = {
  walletId: number;
  network?: string | null;
  /** Runtime-owned authority context. Values are opaque to the addon. */
  sessionId?: string;
  sessionExpiresAt?: string;
  grantRevision?: number;
  authorityEpoch?: number;
  /** Runtime-owned persistence/authority store. */
  proposalStore?: AddonProposalStore;
  operationStore?: AddonOperationStore;
  /** Runtime-owned approval/signing/submission handler. */
  executeProposal?: (args: {
    proposal: AddonTransactionProposal;
    mode: 'wallet-submit' | 'signed-export';
    idempotencyKey?: string;
  }) => Promise<AddonExecutionResult>;
  /** Internal wallet authority; never returned through the public SDK object. */
  executionAuthority?: AddonExecutionAuthority;
  /** Wallet UI approval. Add-on supplied confirmation is never authoritative. */
  approveExecution?: (args: {
    proposal: AddonTransactionProposal;
    mode: 'wallet-submit' | 'signed-export';
  }) => Promise<boolean>;
  /** Rejects proposals created under a stale wallet/add-on authority context. */
  validateProposalAuthority?: (
    proposal: AddonTransactionProposal
  ) => Promise<boolean> | boolean;
  /** Explicit host opt-in; public add-ons cannot export signed artifacts by default. */
  allowSignedExport?: boolean;
  /** Runtime-owned message signer; key material never enters the SDK facade. */
  signMessage?: (args: {
    address: string;
    message: string;
  }) => Promise<SignedMessageResponseI>;
  approveMessageSigning?: (args: {
    address: string;
    message: string;
  }) => Promise<boolean>;
  /**
   * Optional hardening:
   * if provided, SDK will only allow addons to query addresses in this set.
   */
  walletAddresses?: ReadonlySet<string>;
  /**
   * Optional app-level capability subset.
   * If provided, SDK exposure is intersected with manifest-granted capabilities.
   */
  allowedCapabilities?: ReadonlySet<AddonCapability>;
  /**
   * Hardening default: address-based access requires walletAddresses to be present.
   */
  requireAddressAllowlist?: boolean;
  /**
   * Optional runtime authorizer for user-consent flows.
   * Throw to deny an action.
   */
  authorizeCapability?: (args: {
    capability: AddonCapability;
    addonId: string;
  }) => Promise<void> | void;
  appId?: string;
  confirmAction?: (prompt: {
    title: string;
    description?: string;
    risk?: 'low' | 'medium' | 'high';
  }) => Promise<boolean> | boolean;
  auditSink?: (event: AddonPolicyAuditEvent) => void;
  /** Host-only compatibility switch for the built-in FundMe prototype. */
  allowLegacyKeyBearingSigning?: boolean;
  /** Host-only compatibility switch for pre-proposal built-in flows. */
  allowLegacyTransactionExecution?: boolean;
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
  inputs: Array<{
    txid: string;
    vout: number;
    address: string;
    valueSats: string;
    tokenCategory?: string;
    tokenAmount?: string;
    tokenNft?: { capability: TokenCapability; commitment: string };
  }>;
  outputs: ReadonlyArray<TransactionOutput>;
  tokenIntent?: AddonCashTokenIntent;
  contract?: {
    contractId: string;
    contractAddress?: string;
    contractLockingBytecode?: string;
    artifact: unknown;
    contractType?: 'p2sh20' | 'p2sh32' | 'p2s';
    constructorArgs?: unknown[];
    functionName: string;
    functionArgs: unknown[];
    signerBindings?: Array<{ address: string; purpose: 'wallet-spend' }>;
    contractInputIndexes?: number[];
  };
  status: 'proposed';
};

export type AddonSDK = {
  meta: {
    getInfo(): AddonSDKInfo;
    getAuditTrail(): AddonPolicyAuditEvent[];
  };

  wallet: {
    getContext(): {
      walletId: number;
      network: string | null;
    };
    listAddresses(): Promise<{ address: string; tokenAddress: string }[]>;
    getPrimaryAddress(): Promise<string | null>;
    toTokenAddress(address: string): Promise<string>;
  };

  utxos: {
    // read-only (network)
    listForAddress(address: string): Promise<UTXO[]>;
    listForWallet(): Promise<{ allUtxos: UTXO[]; tokenUtxos: UTXO[] }>;

    // optional: DB write path (enabled by your current implementation)
    refreshAndStore(address: string): Promise<UTXO[]>;
  };

  bcmr: {
    getTokenMetadata(category: string): Promise<BcmrTokenMetadata | null>;
    getTokenMetadataState(
      category: string
    ): Promise<BcmrTokenMetadataState | null>;
  };

  tokenIndex: {
    listTokenHolders(args: {
      category: string;
      limit?: number;
      cursor?: string;
    }): Promise<{
      holders: Array<{
        locking_bytecode: string;
        locking_address?: string | null;
        ft_balance: string;
        utxo_count: number;
        updated_height: number;
      }>;
      next_cursor?: string | null;
    }>;
  };

  chain: {
    getLatestBlock(): Promise<unknown>;
    queryUnspentByLockingBytecode(
      lockingBytecodeHex: string,
      tokenId: string
    ): Promise<GraphQLResponse>;
  };

  tx: {
    /**
     * Create an unsigned proposal. This method deliberately does not call
     * TransactionManager, KeyService, CashScript builders, or providers.
     * Execution/signing is a separate wallet-owned flow under construction.
     */
    propose(params: {
      inputs: UTXO[];
      outputs: TransactionOutput[];
      expiresInMs?: number;
      idempotencyKey?: string;
      tokenIntent?: AddonCashTokenIntent;
    }): Promise<AddonTransactionProposal>;
    getProposal(proposalId: string): Promise<AddonTransactionProposal>;
    requestExecution(params: {
      proposalId: string;
      mode?: 'wallet-submit' | 'signed-export';
      idempotencyKey?: string;
    }): Promise<AddonExecutionResult>;
    getOperation(operationId: string): Promise<AddonExecutionOperation>;
    addOutput(params: {
      recipientAddress: string;
      transferAmount: number;
      tokenAmount: number | bigint;
      selectedTokenCategory?: string;
      selectedUtxos?: UTXO[];
      addresses?: { address: string; tokenAddress?: string }[];
      nftCapability?: TokenCapability;
      nftCommitment?: string;
    }): TransactionOutput | undefined;

    build(params: {
      inputs: UTXO[];
      outputs: TransactionOutput[];
      changeAddress?: string;
    }): Promise<{
      hex: string;
      bytes: number;
      finalOutputs: TransactionOutput[] | null;
      errorMsg: string;
    }>;

    broadcast(hex: string): Promise<{
      txid: string | null;
      errorMessage: string | null;
      broadcastState?: BroadcastResult['broadcastState'];
    }>;
  };

  contracts: {
    propose(params: {
      artifact: unknown;
      contractId: string;
      constructorArgs?: unknown[];
      functionName: string;
      functionArgs?: unknown[];
      inputs: UTXO[];
      outputs: TransactionOutput[];
      expiresInMs?: number;
      idempotencyKey?: string;
      signerBindings?: Array<{ address: string; purpose: 'wallet-spend' }>;
    }): Promise<AddonTransactionProposal>;
    instantiate(params: {
      artifact: unknown;
      constructorInputs?: unknown[];
      contractType?: 'p2sh20' | 'p2sh32' | 'p2s';
    }): {
      contractId: string;
      contractName: string;
      contractType: 'p2sh20' | 'p2sh32' | 'p2s';
      address?: string;
      tokenAddress?: string;
      lockingBytecode: string;
      bytecode: string;
      bytesize: number;
      opcount: number;
      artifactFingerprint?: string;
      compiler: { name: string; version: string };
    };
    deriveAddress(params: {
      artifact: unknown;
      constructorInputs?: unknown[];
      contractType?: 'p2sh20' | 'p2sh32' | 'p2s';
    }): string;
    deriveLockingBytecodeHex(params: {
      artifact: unknown;
      constructorInputs?: unknown[];
      contractType?: 'p2sh20' | 'p2sh32' | 'p2s';
    }): string;
  };

  signing: {
    signMessage(args: { address: string; message: string }): Promise<
      SignedMessageResponseI & {
        address: string;
        encoding: 'bch-signed-message';
      }
    >;
  };

  http: {
    fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  };

  ui: {
    confirmSensitiveAction(args: {
      title: string;
      description?: string;
      risk?: 'low' | 'medium' | 'high';
    }): Promise<boolean>;
  };

  logging: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

/**
 * Stable third-party surface. Internal compatibility methods are removed from
 * the returned object as well as from this type; callers cannot reach them by
 * bypassing TypeScript declarations.
 */
export type AddonPublicSDK = Omit<
  AddonSDK,
  'tx' | 'signing' | 'logging'
> & {
  meta: Omit<AddonSDK['meta'], 'getAuditTrail'> & {
    getAuditTrail(): AddonPublicAuditEvent[];
  };
  utxos: {
    listForAddress(address: string): Promise<AddonPublicUTXO[]>;
    listForWallet(): Promise<{
      allUtxos: AddonPublicUTXO[];
      tokenUtxos: AddonPublicUTXO[];
    }>;
    refreshAndStore(address: string): Promise<AddonPublicUTXO[]>;
  };
  tx: Omit<
    AddonSDK['tx'],
    | 'addOutput'
    | 'build'
    | 'broadcast'
    | 'requestExecution'
    | 'propose'
    | 'getProposal'
  > & {
    propose(params: AddonPublicProposalParams): Promise<AddonPublicTransactionProposal>;
    getProposal(proposalId: string): Promise<AddonPublicTransactionProposal>;
    requestExecution(params: {
      proposalId: string;
      mode?: 'wallet-submit';
      idempotencyKey?: string;
    }): Promise<AddonExecutionResult>;
  };
  signing: AddonSDK['signing'];
  contracts: Pick<
    AddonSDK['contracts'],
    | 'instantiate'
    | 'deriveAddress'
    | 'deriveLockingBytecodeHex'
    | 'propose'
  >;
};

/** Policy events safe to expose to the requesting add-on. */
export type AddonPublicAuditEvent = Pick<
  AddonPolicyAuditEvent,
  'at' | 'addonId' | 'capability' | 'action'
>;

export type AddonPublicToken = {
  amount: number | bigint;
  category: string;
  nft?: {
    capability: TokenCapability;
    commitment: string;
  };
};

/** Chain-facing UTXO data safe to cross the third-party boundary. */
export type AddonPublicUTXO = {
  address: string;
  tokenAddress?: string;
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  amount?: number;
  prefix?: string;
  token?: AddonPublicToken | null;
};

export type AddonPublicTransactionProposal = Omit<
  AddonTransactionProposal,
  'inputs'
> & {
  inputs: AddonPublicUTXO[];
};

export type AddonPublicProposalParams = Omit<
  Parameters<AddonSDK['tx']['propose']>[0],
  'inputs'
> & {
  inputs: AddonPublicUTXO[];
};

export function sanitizeAddonOperation(
  operation: AddonExecutionOperation
): AddonExecutionOperation {
  return structuredClone({
    operationId: operation.operationId,
    ...(operation.txid ? { txid: operation.txid } : {}),
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    proposalId: operation.proposalId,
    mode: operation.mode,
    sessionId: operation.sessionId,
    grantRevision: operation.grantRevision,
  });
}

function sanitizeAddonToken(
  token: UTXO['token']
): AddonPublicToken | null | undefined {
  if (token === undefined || token === null) return token;
  return {
    amount: token.amount,
    category: token.category,
    ...(token.nft
      ? {
          nft: {
            capability: token.nft.capability,
            commitment: token.nft.commitment,
          },
        }
      : {}),
  };
}

export function sanitizeAddonUTXO(utxo: UTXO): AddonPublicUTXO {
  return structuredClone({
    address: utxo.address,
    ...(utxo.tokenAddress ? { tokenAddress: utxo.tokenAddress } : {}),
    height: utxo.height,
    tx_hash: utxo.tx_hash,
    tx_pos: utxo.tx_pos,
    value: utxo.value,
    ...(utxo.amount !== undefined ? { amount: utxo.amount } : {}),
    ...(utxo.prefix ? { prefix: utxo.prefix } : {}),
    ...(utxo.token !== undefined
      ? { token: sanitizeAddonToken(utxo.token) }
      : {}),
  });
}

export function sanitizeAddonAuditEvent(
  event: AddonPolicyAuditEvent
): AddonPublicAuditEvent {
  return {
    at: event.at,
    addonId: event.addonId,
    capability: event.capability,
    action: event.action,
  };
}

export function sanitizeAddonProposal(
  proposal: AddonTransactionProposal
): AddonTransactionProposal & { inputs: AddonPublicUTXO[] } {
  return structuredClone({
    proposalId: proposal.proposalId,
    commitmentHex: proposal.commitmentHex,
    walletId: proposal.walletId,
    network: proposal.network,
    sessionId: proposal.sessionId,
    grantRevision: proposal.grantRevision,
    authorityEpoch: proposal.authorityEpoch,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    outputs: proposal.outputs,
    status: proposal.status,
    ...(proposal.tokenIntent ? { tokenIntent: proposal.tokenIntent } : {}),
    inputs: proposal.inputs.map((input) =>
      sanitizeAddonUTXO({
        address: input.address,
        tx_hash: input.txid,
        tx_pos: input.vout,
        value: Number(BigInt(input.valueSats)),
        height: 0,
        ...(input.tokenCategory
          ? {
              token: {
                category: input.tokenCategory,
                amount: BigInt(input.tokenAmount ?? '0'),
                ...(input.tokenNft ? { nft: input.tokenNft } : {}),
              },
            }
          : {}),
      })
    ),
  });
}

const PUBLIC_FORBIDDEN_CAPABILITIES = new Set<AddonCapability>([
  'tx:build',
  'tx:broadcast',
  'tx:add_output',
  'signing:signature_template',
]);
const MAX_IN_MEMORY_PROPOSALS = 512;
const MAX_IN_MEMORY_OPERATIONS = 512;

function assertAddressAllowed(ctx: AddonSDKContext, address: string) {
  if (
    typeof address !== 'string' ||
    address.trim().length === 0 ||
    address.length > 256
  )
    throw new Error('Invalid address');
  if (ctx.requireAddressAllowlist !== false && !ctx.walletAddresses) {
    throw new Error(
      'Address allowlist unavailable; refusing addon address-scoped access'
    );
  }
  if (ctx.walletAddresses && !ctx.walletAddresses.has(address)) {
    throw new Error(`Addon attempted access to non-wallet address: ${address}`);
  }
}

export function createAddonSDK(
  manifest: AddonManifest,
  ctx: AddonSDKContext
): AddonSDK {
  const schemaErrors = validateAddonManifestAgainstSchema(manifest);
  if (schemaErrors.length) {
    throw new Error(
      `Addon "${manifest?.id ?? '(unknown)'}" failed schema checks: ${schemaErrors.join('; ')}`
    );
  }
  validateAddonPermissions(manifest);

  const txMgr = TransactionManager();
  const proposals = new Map<string, AddonTransactionProposal>();
  const proposalIdempotency = new Map<
    string,
    { requestCommitmentHex: string; proposalId: string }
  >();
  const proposalStore: AddonProposalStore = ctx.proposalStore ?? {
    async get(proposalId) {
      return proposals.get(proposalId);
    },
    async put({ proposal, idempotencyKey, requestCommitmentHex }) {
      if (idempotencyKey !== undefined) {
        const prior = proposalIdempotency.get(idempotencyKey);
        if (prior) {
          if (prior.requestCommitmentHex !== requestCommitmentHex) {
            throw new Error(
              'Idempotency key was already used for different proposal contents'
            );
          }
          const existing = proposals.get(prior.proposalId);
          if (existing && Date.parse(existing.expiresAt) > Date.now()) {
            return { kind: 'existing', proposal: existing };
          }
          proposalIdempotency.delete(idempotencyKey);
        }
        proposalIdempotency.set(idempotencyKey, {
          requestCommitmentHex,
          proposalId: proposal.proposalId,
        });
      }
      for (const [storedId, stored] of proposals) {
        if (Date.parse(stored.expiresAt) <= Date.now()) {
          proposals.delete(storedId);
          for (const [key, prior] of proposalIdempotency) {
            if (prior.proposalId === storedId) proposalIdempotency.delete(key);
          }
        }
      }
      if (proposals.size >= MAX_IN_MEMORY_PROPOSALS) {
        const oldest = proposals.keys().next().value;
        if (oldest) {
          proposals.delete(oldest);
          for (const [key, prior] of proposalIdempotency) {
            if (prior.proposalId === oldest) proposalIdempotency.delete(key);
          }
        }
      }
      proposals.set(proposal.proposalId, proposal);
      return { kind: 'stored', proposal };
    },
    async delete(proposalId) {
      proposals.delete(proposalId);
      for (const [key, prior] of proposalIdempotency) {
        if (prior.proposalId === proposalId) proposalIdempotency.delete(key);
      }
    },
  };
  const operations = new Map<string, AddonExecutionOperation>();
  const operationIdempotency = new Map<string, string>();
  const executionLocks = new Map<string, Promise<void>>();
  async function withExecutionLock<T>(
    key: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = executionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    executionLocks.set(key, current);
    await previous;
    try {
      const locks = globalThis.navigator?.locks;
      if (locks) {
        return await locks.request(
          `optn-addon-execution:${key}`,
          { mode: 'exclusive' },
          task
        );
      }
      return await task();
    } finally {
      release();
      if (executionLocks.get(key) === current) executionLocks.delete(key);
    }
  }
  const operationStore: AddonOperationStore = ctx.operationStore ?? {
    async get(operationId) {
      return operations.get(operationId);
    },
    async getByIdempotencyKey(key) {
      const operationId = operationIdempotency.get(key);
      return operationId ? operations.get(operationId) : undefined;
    },
    async getByProposalId(proposalId) {
      return [...operations.values()].find(
        (operation) => operation.proposalId === proposalId
      );
    },
    async put(operation, idempotencyKey) {
      if (operations.size >= MAX_IN_MEMORY_OPERATIONS) {
        const oldest = operations.keys().next().value;
        if (oldest) operations.delete(oldest);
      }
      operations.set(operation.operationId, operation);
      if (idempotencyKey)
        operationIdempotency.set(idempotencyKey, operation.operationId);
    },
  };
  const bcmr = new BcmrService();
  const manifestCapabilities = getAddonGrantedCapabilities(manifest);
  const effectiveCapabilities = new Set<AddonCapability>();

  if (ctx.allowedCapabilities) {
    for (const cap of ctx.allowedCapabilities) {
      if (manifestCapabilities.has(cap)) {
        effectiveCapabilities.add(cap);
      }
    }
  } else {
    for (const cap of manifestCapabilities) {
      effectiveCapabilities.add(cap);
    }
  }

  const requireCapability = (capability: AddonCapability) => {
    if (!effectiveCapabilities.has(capability)) {
      throw new Error(
        `Addon "${manifest.id}" attempted SDK capability without permission: ${capability}`
      );
    }
  };
  const policy = createAddonPolicyEngine({
    manifest,
    appId: ctx.appId,
    runtimeAuthorizer: ctx.authorizeCapability,
    auditSink: ctx.auditSink,
  });

  const authorizeCapability = async (capability: AddonCapability) => {
    if (
      ctx.sessionExpiresAt &&
      (!Number.isFinite(Date.parse(ctx.sessionExpiresAt)) ||
        Date.parse(ctx.sessionExpiresAt) <= Date.now())
    ) {
      throw new Error('Addon SDK session has expired');
    }
    requireCapability(capability);
    await policy.authorizeCapability(capability);
  };

  const assertProposalAuthorityContext = (
    proposal: AddonTransactionProposal
  ) => {
    if (
      ctx.sessionExpiresAt &&
      (!Number.isFinite(Date.parse(ctx.sessionExpiresAt)) ||
        Date.parse(ctx.sessionExpiresAt) <= Date.now())
    ) {
      throw new Error('Addon SDK session has expired');
    }
    if (
      proposal.sessionId !== (ctx.sessionId ?? null) ||
      proposal.grantRevision !== (ctx.grantRevision ?? null) ||
      proposal.walletId !== ctx.walletId
    ) {
      throw new Error(
        'Addon proposal is outside the current authority context'
      );
    }
  };

  const withPolicyTimeout = async <T>(
    operation: string,
    timeoutMs: number,
    run: () => Promise<T>
  ) => {
    return await policy.withTimeout(operation, timeoutMs, run);
  };

  async function fetchTokenIndexJson<T>(
    url: string,
    {
      headers,
      timeoutMs = 8000,
    }: {
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const fetchJson = async (): Promise<T> => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const response = await fetch(url, { headers, signal: ctrl.signal });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`TokenIndex ${response.status}: ${text}`);
        }
        return JSON.parse(text) as T;
      } finally {
        clearTimeout(to);
      }
    };

    const nativeHttpJson = async (): Promise<T> => {
      const response = await CapacitorHttp.get({ url, headers });
      return response.data as T;
    };

    try {
      return await fetchJson();
    } catch (fetchError) {
      if (isNativePlatform()) {
        try {
          return await nativeHttpJson();
        } catch {
          throw fetchError;
        }
      }
      throw fetchError;
    }
  }

  const buildBcmrTokenMetadataState = (
    snapshot: BcmrSnapshot,
    iconUri: string | null,
    freshness: BcmrTokenMetadataState['freshness'],
    provenance?: Pick<
      BcmrTokenMetadataState,
      'lastFetch' | 'registryUri' | 'registryHash'
    >
  ): BcmrTokenMetadataState => ({
    status: 'ready',
    freshness,
    name: snapshot.name,
    symbol: snapshot.token?.symbol || '',
    decimals: snapshot.token?.decimals ?? 0,
    iconUri,
    snapshot,
    isRefreshing: false,
    lastFetch: provenance?.lastFetch ?? snapshot.lastFetch ?? null,
    registryUri: provenance?.registryUri ?? snapshot.registryUri ?? null,
    registryHash: provenance?.registryHash ?? snapshot.registryHash ?? null,
  });

  const getReservedOutpointKeys = async (): Promise<Set<string>> => {
    const reserved = await OutboundTransactionTracker.listReservedOutpoints(
      ctx.walletId
    );
    return new Set(reserved.map((outpoint) => outpointKey(outpoint)));
  };

  const resolveAddonBcmrMetadataState = async (
    category: string
  ): Promise<BcmrTokenMetadataState | null> => {
    await authorizeCapability('bcmr:token:read');
    const normalized = String(category ?? '')
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error('Invalid token category');
    }

    return await withPolicyTimeout(
      'bcmr.getTokenMetadataState',
      20_000,
      async () => {
        const cached = await bcmr.getSnapshot(normalized);
        if (cached) {
          let iconUri: string | null = null;
          try {
            const authbase = await bcmr.getCategoryAuthbase(normalized);
            iconUri = await bcmr.resolveIcon(authbase, undefined, normalized);
          } catch {
            // Preserve the cached metadata if icon hydration fails.
          }

          return buildBcmrTokenMetadataState(cached, iconUri, 'cached');
        }

        try {
          const authbase = await bcmr.getCategoryAuthbase(normalized);
          const registry = await bcmr.resolveIdentityRegistry(authbase);
          const snapshot = bcmr.extractIdentityByCategory(
            normalized,
            registry.registry
          );
          const iconUri = await bcmr.resolveIcon(
            authbase,
            undefined,
            normalized
          );
          return buildBcmrTokenMetadataState(snapshot, iconUri, 'fresh', {
            lastFetch: registry.lastFetch,
            registryUri: registry.registryUri,
            registryHash: registry.registryHash,
          });
        } catch {
          return null;
        }
      }
    );
  };

  const filterReservedUtxos = async (utxos: UTXO[]): Promise<UTXO[]> => {
    const reservedKeys = await getReservedOutpointKeys();
    if (reservedKeys.size === 0) return utxos;
    return utxos.filter((utxo) => !reservedKeys.has(outpointKey(utxo)));
  };

  let txApi: AddonSDK['tx'];

  return {
    meta: {
      getInfo() {
        return getAddonSDKInfo(Array.from(effectiveCapabilities));
      },
      getAuditTrail() {
        return policy.getAuditTrail();
      },
    },

    wallet: {
      getContext() {
        requireCapability('wallet:context:read');
        return {
          walletId: ctx.walletId,
          network: ctx.network ?? null,
        };
      },

      async listAddresses() {
        await authorizeCapability('wallet:addresses:read');
        const { addresses } = await withPolicyTimeout(
          'wallet.listAddresses',
          15_000,
          async () =>
            await TransactionService.fetchAddressesAndUTXOs(ctx.walletId)
        );
        return addresses.map(({ address, tokenAddress }) => ({
          address,
          tokenAddress,
        }));
      },

      async getPrimaryAddress() {
        await authorizeCapability('wallet:addresses:read');
        const { addresses } = await withPolicyTimeout(
          'wallet.getPrimaryAddress',
          15_000,
          async () =>
            await TransactionService.fetchAddressesAndUTXOs(ctx.walletId)
        );
        return addresses[0]?.address ?? null;
      },

      async toTokenAddress(address: string) {
        await authorizeCapability('wallet:addresses:read');
        const manager = AddressManager();
        const mapped = await withPolicyTimeout(
          'wallet.toTokenAddress',
          10_000,
          async () => await manager.fetchTokenAddress(ctx.walletId, address)
        );
        return mapped || address;
      },
    },

    utxos: {
      async listForAddress(address: string) {
        await authorizeCapability('utxo:address:read');
        assertAddressAllowed(ctx, address);
        // read-only electrum fetch (no DB)
        const utxos = await withPolicyTimeout(
          'utxos.listForAddress',
          20_000,
          async () => await ElectrumService.getUTXOs(address)
        );
        return await filterReservedUtxos(utxos);
      },

      async listForWallet() {
        await authorizeCapability('utxo:wallet:read');
        const walletUtxos = await withPolicyTimeout(
          'utxos.listForWallet',
          25_000,
          async () => await UTXOService.fetchAllWalletUtxos(ctx.walletId)
        );
        const reservedKeys = await getReservedOutpointKeys();
        if (reservedKeys.size === 0) return walletUtxos;

        return {
          allUtxos: walletUtxos.allUtxos.filter(
            (utxo) => !reservedKeys.has(outpointKey(utxo))
          ),
          tokenUtxos: walletUtxos.tokenUtxos.filter(
            (utxo) => !reservedKeys.has(outpointKey(utxo))
          ),
        };
      },

      async refreshAndStore(address: string) {
        await authorizeCapability('utxo:address:refresh');
        assertAddressAllowed(ctx, address);
        // DB write path (still safe; no secrets exposed)
        return await withPolicyTimeout(
          'utxos.refreshAndStore',
          30_000,
          async () =>
            await UTXOService.fetchAndStoreUTXOs(ctx.walletId, address)
        );
      },
    },

    chain: {
      async getLatestBlock() {
        await authorizeCapability('chain:query');
        return await withPolicyTimeout(
          'chain.getLatestBlock',
          15_000,
          async () => await ElectrumService.getLatestBlock()
        );
      },

      async queryUnspentByLockingBytecode(
        lockingBytecodeHex: string,
        tokenId: string
      ) {
        await authorizeCapability('chain:query');
        return await withPolicyTimeout(
          'chain.queryUnspentByLockingBytecode',
          20_000,
          async () =>
            await queryUnspentOutputsByLockingBytecode(
              lockingBytecodeHex,
              tokenId
            )
        );
      },
    },

    bcmr: {
      async getTokenMetadata(category: string) {
        const state = await resolveAddonBcmrMetadataState(category);
        return (state?.snapshot as BcmrTokenMetadata | null) ?? null;
      },

      async getTokenMetadataState(category: string) {
        return await resolveAddonBcmrMetadataState(category);
      },
    },

    tokenIndex: {
      async listTokenHolders({ category, limit, cursor }) {
        await authorizeCapability('tokenindex:holders:read');
        const normalized = String(category ?? '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(normalized)) {
          throw new Error('Invalid token category');
        }

        const url = new URL(
          `https://tokenindex.optnlabs.com/v1/token/${normalized}/holders`
        );
        url.searchParams.set(
          'limit',
          String(Math.min(Math.max(limit ?? 100, 1), 500))
        );
        if (cursor) {
          url.searchParams.set('cursor', cursor);
        }

        assertUrlAllowedForAddon(manifest, url.toString());

        return await withPolicyTimeout(
          'tokenIndex.listTokenHolders',
          20_000,
          async () => {
            return await fetchTokenIndexJson<{
              holders: Array<{
                locking_bytecode: string;
                locking_address?: string | null;
                ft_balance: string;
                utxo_count: number;
                updated_height: number;
              }>;
              next_cursor?: string | null;
            }>(url.toString(), {
              headers: {
                Accept: 'application/json',
              },
            });
          }
        );
      },
    },

    tx: (txApi = {
      async propose({
        inputs,
        outputs,
        expiresInMs,
        idempotencyKey,
        tokenIntent,
      }) {
        await authorizeCapability('tx:propose');
        const normalizedTokenIntent = normalizeTokenIntent(tokenIntent);

        if (!Array.isArray(inputs) || inputs.length === 0) {
          throw new Error('Transaction proposal requires at least one input');
        }
        if (inputs.length > MAX_PROPOSAL_INPUTS) {
          throw new Error(
            `Transaction proposal exceeds ${MAX_PROPOSAL_INPUTS} inputs`
          );
        }
        if (!Array.isArray(outputs) || outputs.length === 0) {
          throw new Error('Transaction proposal requires at least one output');
        }
        if (outputs.length > MAX_PROPOSAL_OUTPUTS) {
          throw new Error(
            `Transaction proposal exceeds ${MAX_PROPOSAL_OUTPUTS} outputs`
          );
        }
        const seen = new Set<string>();
        const publicInputs = inputs.map((input) => {
          const txid = String(input.tx_hash ?? '')
            .trim()
            .toLowerCase();
          const vout = Number(input.tx_pos);
          const value = input.value ?? input.amount;
          const valueSats = BigInt(value ?? 0);
          const height = Number(input.height ?? 0);
          if (!/^[0-9a-f]{64}$/.test(txid)) {
            throw new Error('Transaction proposal input has an invalid txid');
          }
          if (!Number.isInteger(vout) || vout < 0) {
            throw new Error('Transaction proposal input has an invalid index');
          }
          if (valueSats < 0n) {
            throw new Error('Transaction proposal input has a negative value');
          }
          const address = String(input.address ?? '').trim();
          if (!address) {
            throw new Error('Transaction proposal input requires an address');
          }
          if (ctx.walletAddresses && !ctx.walletAddresses.has(address)) {
            throw new Error(
              `Transaction proposal input is outside the wallet address allowlist: ${address}`
            );
          }
          if (valueSats > MAX_BCH_SATS) {
            throw new Error('Transaction proposal input has an invalid value');
          }
          if (!Number.isSafeInteger(height) || height < 0) {
            throw new Error('Transaction proposal input has an invalid height');
          }
          if (
            input.token?.category !== undefined &&
            !/^[0-9a-f]{64}$/i.test(String(input.token.category))
          ) {
            throw new Error(
              'Transaction proposal input has an invalid token category'
            );
          }
          if (
            input.token?.amount !== undefined &&
            (BigInt(input.token.amount) < 0n ||
              BigInt(input.token.amount) > MAX_CASHTOKEN_AMOUNT)
          ) {
            throw new Error(
              'Transaction proposal input has an invalid token amount'
            );
          }
          const tokenNft =
            input.token?.nft !== undefined
              ? normalizeNft(input.token.nft, 'Transaction proposal input')
              : undefined;
          const outpoint = `${txid}:${vout}`;
          if (seen.has(outpoint)) {
            throw new Error(
              `Transaction proposal contains duplicate input: ${outpoint}`
            );
          }
          seen.add(outpoint);
          if (
            input.unlocker !== undefined ||
            input.contractFunctionInputs !== undefined
          ) {
            throw new Error(
              'Transaction proposal cannot contain executable unlockers or callbacks'
            );
          }
          return {
            txid,
            vout,
            address,
            height,
            valueSats: valueSats.toString(),
            ...(input.token?.category
              ? { tokenCategory: String(input.token.category).toLowerCase() }
              : {}),
            ...(input.token?.amount !== undefined
              ? { tokenAmount: BigInt(input.token.amount).toString() }
              : {}),
            ...(tokenNft ? { tokenNft } : {}),
          };
        });
        const normalizedOutputs = normalizeProposalOutputs(outputs);

        const requestCommitmentHex = bytesToHex(
          sha256(
            encodeString(
              canonicalJson({
                version: 1,
                walletId: ctx.walletId,
                network: ctx.network ?? null,
                inputs: publicInputs,
                outputs: normalizedOutputs,
                tokenIntent: normalizedTokenIntent ?? null,
              })
            )
          )
        );
        if (
          idempotencyKey !== undefined &&
          (typeof idempotencyKey !== 'string' ||
            !idempotencyKey.trim() ||
            idempotencyKey.length > MAX_ADDON_IDEMPOTENCY_KEY_LENGTH)
        ) {
          throw new Error(
            `Idempotency key must contain between 1 and ${MAX_ADDON_IDEMPOTENCY_KEY_LENGTH} characters`
          );
        }
        const now = Date.now();
        const lifetime = Math.min(
          Math.max(expiresInMs ?? 5 * 60_000, 1_000),
          5 * 60_000
        );
        const createdAt = new Date(now).toISOString();
        const expiresAt = new Date(now + lifetime).toISOString();
        const commitmentHex = bytesToHex(
          sha256(
            encodeString(
              canonicalJson({
                version: 1,
                walletId: ctx.walletId,
                network: ctx.network ?? null,
                sessionId: ctx.sessionId ?? null,
                grantRevision: ctx.grantRevision ?? null,
                authorityEpoch: ctx.authorityEpoch ?? null,
                createdAt,
                expiresAt,
                inputs: publicInputs,
                outputs: normalizedOutputs,
                tokenIntent: normalizedTokenIntent,
              })
            )
          )
        );
        const proposal = {
          proposalId: `optn-proposal-v1:${commitmentHex}`,
          commitmentHex,
          walletId: ctx.walletId,
          network: ctx.network ?? null,
          sessionId: ctx.sessionId ?? null,
          grantRevision: ctx.grantRevision ?? null,
          authorityEpoch: ctx.authorityEpoch ?? null,
          createdAt,
          expiresAt,
          inputs: publicInputs,
          outputs: normalizedOutputs.map((output) => ({ ...output })),
          ...(normalizedTokenIntent
            ? { tokenIntent: normalizedTokenIntent }
            : {}),
          status: 'proposed' as const,
        };
        const stored = await proposalStore.put({
          proposal,
          idempotencyKey,
          requestCommitmentHex,
        });
        return structuredClone(stored.proposal);
      },

      async getProposal(proposalId: string) {
        await authorizeCapability('tx:propose');
        if (typeof proposalId !== 'string' || !proposalId.trim()) {
          throw new Error('Proposal id is required');
        }
        const proposal = await proposalStore.get(proposalId);
        if (!proposal) {
          throw new Error('Addon proposal not found');
        }
        assertProposalAuthorityContext(proposal);
        if (Date.parse(proposal.expiresAt) <= Date.now()) {
          await proposalStore.delete(proposalId);
          throw new Error('Addon proposal expired');
        }
        return structuredClone(proposal);
      },

      async requestExecution({
        proposalId,
        mode = 'wallet-submit',
        idempotencyKey,
      }) {
        await authorizeCapability('tx:execute');
        if (mode !== 'wallet-submit' && mode !== 'signed-export') {
          throw new Error(
            `Unsupported proposal execution mode: ${String(mode)}`
          );
        }
        if (mode === 'signed-export' && !ctx.allowSignedExport) {
          throw new Error(
            'Signed transaction export is unavailable to this SDK context'
          );
        }
        if (
          idempotencyKey !== undefined &&
          (typeof idempotencyKey !== 'string' ||
            !idempotencyKey.trim() ||
            idempotencyKey.length > MAX_ADDON_IDEMPOTENCY_KEY_LENGTH)
        ) {
          throw new Error(
            `Idempotency key must contain between 1 and ${MAX_ADDON_IDEMPOTENCY_KEY_LENGTH} characters`
          );
        }
        const proposal = await proposalStore.get(proposalId);
        if (!proposal) {
          throw new Error('Addon proposal not found');
        }
        assertProposalAuthorityContext(proposal);
        if (Date.parse(proposal.expiresAt) <= Date.now()) {
          await proposalStore.delete(proposalId);
          throw new Error('Addon proposal expired');
        }
        assertAddonProposalExecutable(proposal);
        const authority = ctx.executionAuthority;
        if (!ctx.executeProposal && !authority) {
          throw new Error(
            'Wallet execution authority is unavailable for this SDK context'
          );
        }
        const validateAuthority =
          ctx.validateProposalAuthority ?? authority?.validate;
        if (validateAuthority) {
          const current = await withPolicyTimeout(
            'tx.requestExecution.validateAuthority',
            10_000,
            async () => {
              if (authority && !ctx.validateProposalAuthority) {
                await validateAuthority(proposal);
                return true;
              }
              return await validateAuthority(structuredClone(proposal));
            }
          );
          if (!current) {
            throw new Error('Addon proposal authority context is stale');
          }
        }
        if (idempotencyKey && operationStore.getByIdempotencyKey) {
          const existing =
            await operationStore.getByIdempotencyKey(idempotencyKey);
          if (existing && existing.proposalId === proposalId) {
            return structuredClone(existing);
          }
          if (existing && existing.proposalId !== proposalId) {
            throw new Error(
              'Idempotency key was already used for another proposal'
            );
          }
        }
        const executionKey = `${proposalId}:${mode}`;
        return await withExecutionLock(executionKey, async () => {
          // Recheck after acquiring the lock; another concurrent caller may
          // have completed and persisted the same idempotent operation.
          if (idempotencyKey && operationStore.getByIdempotencyKey) {
            const existing =
              await operationStore.getByIdempotencyKey(idempotencyKey);
            if (existing && existing.proposalId === proposalId) {
              return structuredClone(existing);
            }
            if (existing && existing.proposalId !== proposalId) {
              throw new Error(
                'Idempotency key was already used for another proposal'
              );
            }
          }
          if (operationStore.getByProposalId) {
            const existing = await operationStore.getByProposalId(proposalId);
            if (existing) return structuredClone(existing);
          }
          const approveExecution = ctx.approveExecution ?? authority?.approve;
          if (!approveExecution) {
            throw new Error(
              'Wallet execution approval is unavailable for this SDK context'
            );
          }
          const approved = await withPolicyTimeout(
            'tx.requestExecution.approval',
            120_000,
            async () =>
              await approveExecution({
                proposal: structuredClone(proposal),
                mode,
              })
          );
          if (!approved)
            throw new Error('User rejected addon execution request');
          const executeProposal = ctx.executeProposal ?? authority?.execute;
          let result: AddonExecutionResult;
          try {
            result = await withPolicyTimeout(
              'tx.requestExecution.execute',
              30_000,
              async () =>
                await executeProposal!({
                  proposal: structuredClone(proposal),
                  mode,
                  idempotencyKey,
                })
            );
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes('tx.requestExecution.execute') ||
              !error.message.includes('timed out')
            ) {
              throw error;
            }
            const now = new Date().toISOString();
            const unknownOperation: AddonExecutionOperation = {
              operationId: `optn-operation-v1:${proposal.commitmentHex}`,
              status: 'submission_unknown',
              proposalId,
              mode,
              sessionId: ctx.sessionId ?? null,
              grantRevision: ctx.grantRevision ?? null,
              createdAt: now,
              updatedAt: now,
            };
            await operationStore.put(unknownOperation, idempotencyKey);
            return structuredClone(unknownOperation);
          }
          if (
            !result ||
            typeof result.operationId !== 'string' ||
            !result.operationId ||
            result.operationId.length > 256 ||
            ![
              'awaiting_approval',
              'signing',
              'submitting',
              'submission_unknown',
              'mempool',
              'confirmed',
              'rejected',
            ].includes(result.status)
          ) {
            throw new Error(
              'Wallet execution authority returned an invalid operation'
            );
          }
          if (
            result.txid !== undefined &&
            (typeof result.txid !== 'string' ||
              !/^[0-9a-fA-F]{64}$/.test(result.txid))
          ) {
            throw new Error(
              'Wallet execution authority returned an invalid transaction id'
            );
          }
          const now = new Date().toISOString();
          const operation: AddonExecutionOperation = {
            operationId: result.operationId,
            status: result.status,
            ...(result.txid ? { txid: result.txid.toLowerCase() } : {}),
            proposalId,
            mode,
            sessionId: ctx.sessionId ?? null,
            grantRevision: ctx.grantRevision ?? null,
            createdAt: now,
            updatedAt: now,
          };
          await operationStore.put(operation, idempotencyKey);
          return structuredClone(operation);
        });
      },

      async getOperation(operationId: string) {
        await authorizeCapability('tx:operation:read');
        if (typeof operationId !== 'string' || !operationId.trim()) {
          throw new Error('Operation id is required');
        }
        const operation = await operationStore.get(operationId);
        if (!operation) throw new Error('Addon operation not found');
        if (
          operation.sessionId !== (ctx.sessionId ?? null) ||
          operation.grantRevision !== (ctx.grantRevision ?? null)
        ) {
          throw new Error(
            'Addon operation is outside the current authority context'
          );
        }
        return structuredClone(operation);
      },

      addOutput({
        recipientAddress,
        transferAmount,
        tokenAmount,
        selectedTokenCategory,
        selectedUtxos,
        addresses,
        nftCapability,
        nftCommitment,
      }) {
        requireCapability('tx:add_output');
        return txMgr.addOutput(
          recipientAddress,
          transferAmount,
          tokenAmount,
          selectedTokenCategory ?? '',
          selectedUtxos ?? [],
          addresses ?? [],
          nftCapability,
          nftCommitment,
          false
        );
      },

      async build({ inputs, outputs, changeAddress }) {
        if (!ctx.allowLegacyTransactionExecution) {
          throw new Error(
            'Legacy transaction execution is unavailable to third-party addons; use tx.propose and wallet execution'
          );
        }
        await authorizeCapability('tx:build');
        // Modules must provide any contract unlockers on the input UTXOs themselves.
        // contractFunctionInputs is intentionally `null` here.
        const res = await withPolicyTimeout(
          'tx.build',
          20_000,
          async () =>
            await txMgr.buildTransaction(
              outputs,
              null,
              changeAddress ?? '',
              inputs
            )
        );

        return {
          hex: res.finalTransaction,
          bytes: res.bytecodeSize,
          finalOutputs: res.finalOutputs,
          errorMsg: res.errorMsg,
        };
      },

      async broadcast(hex: string) {
        if (!ctx.allowLegacyTransactionExecution) {
          throw new Error(
            'Legacy transaction broadcast is unavailable to third-party addons; use wallet execution'
          );
        }
        await authorizeCapability('tx:broadcast');
        return await withPolicyTimeout(
          'tx.broadcast',
          20_000,
          async () =>
            await TransactionService.sendTransaction(hex, undefined, {
              source: 'addon',
              sourceLabel: manifest.name
                ? `App: ${manifest.name}`
                : `App: ${manifest.id}`,
            })
        );
      },
    }),

    contracts: {
      async propose({
        artifact,
        contractId,
        contractAddress,
        constructorArgs = [],
        functionName,
        functionArgs = [],
        inputs,
        outputs,
        expiresInMs,
        idempotencyKey,
        signerBindings = [],
        contractType = 'p2sh32',
        contractInputIndexes,
      }: Record<string, unknown>) {
        await authorizeCapability('contracts:propose');
        if (!txApi) throw new Error('Transaction proposal service unavailable');
        if (typeof contractId !== 'string' || !/^[0-9a-f]{64}$/.test(contractId)) {
          throw new Error('Invalid contract id');
        }
        if (typeof functionName !== 'string' || !functionName.trim()) {
          throw new Error('Contract function name is required');
        }
        const proposal = await txApi.propose({
          inputs,
          outputs,
          expiresInMs,
        });
        const contractCommitmentHex = bytesToHex(
          sha256(
            encodeString(
              canonicalJson({
                version: 1,
                baseCommitmentHex: proposal.commitmentHex,
                contractId,
                contractAddress,
                contractLockingBytecode,
                artifact,
                constructorArgs,
                functionName,
                functionArgs,
                signerBindings,
                contractType,
                contractInputIndexes,
              })
            )
          )
        );
        const contractProposal = {
          ...proposal,
          proposalId: `optn-proposal-v1:${contractCommitmentHex}`,
          commitmentHex: contractCommitmentHex,
          contract: {
            contractId,
            contractAddress,
            contractLockingBytecode,
            artifact,
            constructorArgs,
            functionName,
            functionArgs,
            signerBindings,
            contractType,
            contractInputIndexes,
          },
        } as AddonTransactionProposal;
        let persisted;
        try {
          persisted = await proposalStore.put({
            proposal: contractProposal,
            idempotencyKey,
            requestCommitmentHex: contractCommitmentHex,
          });
        } finally {
          await proposalStore.delete(proposal.proposalId);
        }
        return structuredClone(persisted.proposal);
      },
      instantiate({ artifact, constructorArgs, contractType = 'p2sh32' }) {
        requireCapability('contracts:derive');
        const provider = new ElectrumNetworkProvider(toProviderNetwork(ctx.network));
        const typedArtifact = artifact as unknown as ContractCtorArtifact;
        const normalizedInputs = Array.isArray(constructorArgs)
          ? constructorArgs.map((raw: unknown) =>
              raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
            )
          : [];
        const args = normalizedInputs.length > 0
          ? normalizedInputs.map((raw, idx) => parseInputValue(raw, getConstructorInputType(artifact, idx)))
          : [];
        const contract = createWalletCashScriptContract({ artifact: typedArtifact, constructorArgs: args, provider, contractType });
        const bytecode = typeof contract.bytecode === 'string'
          ? contract.bytecode
          : bytesToHex(contract.bytecode as Uint8Array);
        const lockingBytecode = typeof contract.lockingBytecode === 'string'
          ? contract.lockingBytecode
          : bytesToHex(contract.lockingBytecode as Uint8Array);
        const artifactFingerprint = typeof typedArtifact.fingerprint === 'string'
          ? typedArtifact.fingerprint
          : undefined;
        const contractId = bytesToHex(
          sha256(new TextEncoder().encode(`${typedArtifact.contractName}:${bytecode}`))
        );
        return {
          contractId,
          contractName: contract.name,
          contractType,
          ...(contractType === 'p2s' ? {} : { address: contract.address, tokenAddress: contract.tokenAddress }),
          lockingBytecode,
          bytecode,
          bytesize: contract.bytesize,
          opcount: contract.opcount,
          ...(artifactFingerprint ? { artifactFingerprint } : {}),
          compiler: {
            name: String(typedArtifact.compiler?.name ?? 'cashc'),
            version: String(typedArtifact.compiler?.version ?? 'unknown'),
          },
        };
      },
      deriveAddress({ artifact, constructorArgs, contractType = 'p2sh32' }) {
        requireCapability('contracts:derive');
        const provider = new ElectrumNetworkProvider(
          toProviderNetwork(ctx.network)
        );
        const normalizedInputs = Array.isArray(constructorArgs)
          ? constructorArgs.map((raw: unknown) => raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw)
          : [];
        const args = normalizedInputs.map((raw, idx) =>
          parseInputValue(raw, getConstructorInputType(artifact, idx))
        );
        const contract = createWalletCashScriptContract({ artifact, constructorArgs: args, provider, contractType });
        return contract.tokenAddress || contract.address;
      },

      deriveLockingBytecodeHex({ artifact, constructorInputs, contractType = 'p2sh32' }) {
        requireCapability('contracts:derive');
        const provider = new ElectrumNetworkProvider(
          toProviderNetwork(ctx.network)
        );
        const normalizedInputs = Array.isArray(constructorInputs)
          ? constructorInputs.map((raw: unknown) => raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw)
          : [];
        const args = normalizedInputs.map((raw, idx) =>
          parseInputValue(raw, getConstructorInputType(artifact, idx))
        );
        const contract = createWalletCashScriptContract({ artifact, constructorArgs: args, provider, contractType });
        if (typeof contract.bytecode === 'string') return contract.bytecode;
        return Array.from(contract.bytecode as Uint8Array, (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('');
      },
    },

    signing: {
      async signMessage({ address, message }) {
        if (
          typeof message !== 'string' ||
          message.length === 0 ||
          message.length > ADDON_SDK_LIMITS.maxMessageLength
        ) {
          throw new Error(
            `Message must contain between 1 and ${ADDON_SDK_LIMITS.maxMessageLength} characters`
          );
        }
        await authorizeCapability('signing:message_sign');
        assertAddressAllowed(ctx, address);
        if (!ctx.signMessage) {
          throw new Error(
            'Wallet message-signing authority is unavailable for this SDK context'
          );
        }
        if (!ctx.approveMessageSigning) {
          throw new Error(
            'Wallet message-signing approval is unavailable for this SDK context'
          );
        }
        const approved = await ctx.approveMessageSigning({ address, message });
        if (!approved) throw new Error('User rejected addon message signing');
        const signed = await withPolicyTimeout(
          'signing.signMessage',
          10_000,
          async () => await ctx.signMessage!({ address, message })
        );
        const raw = signed.raw
          ? {
              ecdsa: signed.raw.ecdsa,
              schnorr: signed.raw.schnorr,
              der: signed.raw.der,
            }
          : undefined;
        const details = signed.details
          ? {
              recoveryId: signed.details.recoveryId,
              compressed: signed.details.compressed,
              messageHash: signed.details.messageHash,
            }
          : undefined;
        return {
          signature: signed.signature,
          ...(raw ? { raw } : {}),
          ...(details ? { details } : {}),
          address,
          encoding: 'bch-signed-message' as const,
        };
      },

      async signatureTemplateForAddress(address: string) {
        if (!ctx.allowLegacyKeyBearingSigning) {
          throw new Error(
            'Legacy key-bearing signing is unavailable to third-party addons; use an approved wallet signing operation'
          );
        }
        await authorizeCapability('signing:signature_template');
        assertAddressAllowed(ctx, address);
        const pk = await withPolicyTimeout(
          'signing.signatureTemplateForAddress',
          10_000,
          async () => await KeyService.fetchAddressPrivateKey(address, 'spend')
        );
        if (!pk) throw new Error(`Missing private key for address: ${address}`);
        return new SignatureTemplate(pk, SighashType.SIGHASH_ALL);
      },
    },

    http: {
      async fetchJson<T>(url: string, init?: RequestInit) {
        // HTTP is gated by domain permission and this explicit capability.
        // This keeps "network read" separate from wallet mutations/signing scopes.
        await authorizeCapability('http:fetch_json');
        // enforce addon permission + global allowlist
        assertUrlAllowedForAddon(manifest, url);

        const res = await withPolicyTimeout(
          'http.fetchJson',
          20_000,
          async () =>
            fetch(url, {
              ...init,
              // safety: avoid cookies/credentials leakage
              credentials: 'omit',
            })
        );

        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return (await res.json()) as T;
      },
    },

    ui: {
      async confirmSensitiveAction(args) {
        await authorizeCapability('ui:confirm');
        if (!ctx.confirmAction) return false;
        return await ctx.confirmAction(args);
      },
    },

    logging: {
      info: (...args) =>
        console.log('[addon]', { addonId: manifest.id }, ...args),
      warn: (...args) =>
        console.warn('[addon]', { addonId: manifest.id }, ...args),
      error: (...args) =>
        console.error('[addon]', { addonId: manifest.id }, ...args),
    },
  };
}

export function createPublicAddonSDK(
  manifest: AddonManifest,
  ctx: AddonSDKContext
): AddonPublicSDK {
  if (manifest.trustTier === 'internal') {
    throw new Error(
      'Internal addons must use the host-private SDK constructor'
    );
  }
  const forbiddenRequested = Array.from(
    getAddonGrantedCapabilities(manifest)
  ).filter((capability) => PUBLIC_FORBIDDEN_CAPABILITIES.has(capability));
  if (forbiddenRequested.length > 0) {
    throw new Error(
      `Addon requests internal-only capabilities: ${forbiddenRequested.join(', ')}`
    );
  }
  const internal = createAddonSDK(manifest, {
    ...ctx,
    requireAddressAllowlist: true,
    allowLegacyKeyBearingSigning: false,
    allowLegacyTransactionExecution: false,
    allowSignedExport: false,
  });
  const tx = {
    ...internal.tx,
    async propose(...args: Parameters<typeof internal.tx.propose>) {
      return sanitizeAddonProposal(await internal.tx.propose(...args));
    },
    async getProposal(...args: Parameters<typeof internal.tx.getProposal>) {
      return sanitizeAddonProposal(await internal.tx.getProposal(...args));
    },
    async requestExecution(
      ...args: Parameters<typeof internal.tx.requestExecution>
    ) {
      return sanitizeAddonOperation(
        (await internal.tx.requestExecution(...args)) as AddonExecutionOperation
      );
    },
    async getOperation(...args: Parameters<typeof internal.tx.getOperation>) {
      return sanitizeAddonOperation(await internal.tx.getOperation(...args));
    },
  };
  delete tx.addOutput;
  delete tx.build;
  delete tx.broadcast;
  const signing = { ...internal.signing } as AddonSDK['signing'] & {
    signatureTemplateForAddress?: unknown;
  };
  delete signing.signatureTemplateForAddress;
  const publicInternal = { ...internal };
  delete publicInternal.logging;
  const utxos = {
    async listForAddress(address: string) {
      const result = await internal.utxos.listForAddress(address);
      return result.map(sanitizeAddonUTXO);
    },
    async listForWallet() {
      const result = await internal.utxos.listForWallet();
      return {
        allUtxos: result.allUtxos.map(sanitizeAddonUTXO),
        tokenUtxos: result.tokenUtxos.map(sanitizeAddonUTXO),
      };
    },
    async refreshAndStore(address: string) {
      const result = await internal.utxos.refreshAndStore(address);
      return result.map(sanitizeAddonUTXO);
    },
  };
  const meta = {
    ...internal.meta,
    getInfo() {
      const info = internal.meta.getInfo();
      return {
        ...info,
        methods: {
          ...info.methods,
          tx: info.methods.tx.filter((method) => method !== 'addOutput'),
        },
        capabilities: info.capabilities.filter(
          (capability) => !PUBLIC_FORBIDDEN_CAPABILITIES.has(capability)
        ),
      };
    },
    getAuditTrail() {
      return internal.meta.getAuditTrail().map(sanitizeAddonAuditEvent);
    },
  };
  return {
    ...publicInternal,
    meta,
    utxos,
    tx,
    signing,
    contracts: {
      instantiate: internal.contracts.instantiate,
      deriveAddress: internal.contracts.deriveAddress,
      deriveLockingBytecodeHex: internal.contracts.deriveLockingBytecodeHex,
      propose: async (...args: Parameters<typeof internal.contracts.propose>) =>
        sanitizeAddonProposal(await internal.contracts.propose(...args)),
    },
  } as AddonPublicSDK;
}
