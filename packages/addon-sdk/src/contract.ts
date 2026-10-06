import type {
  AddonCapability,
  AddonCashTokenIntent,
  AddonSDKInfo,
} from './types.js';

export const ADDON_SDK_VERSION = '1.6.0' as const;
export const ADDON_SDK_PROTOCOL_VERSION = 1 as const;
export const ADDON_SDK_LIMITS = {
  maxProposalInputs: 200,
  maxProposalOutputs: 100,
  maxMessageLength: 8192,
  maxIdempotencyKeyLength: 256,
} as const;

export const ADDON_SDK_CASHTOKEN_INTENTS = [
  'transfer',
  'mint-fungible',
  'mint-nft',
  'mutate-nft',
  'burn',
] as const satisfies readonly AddonCashTokenIntent['kind'][];

export const ADDON_SDK_CAPABILITIES = [
  'wallet:context:read',
  'wallet:addresses:read',
  'utxo:wallet:read',
  'utxo:address:read',
  'utxo:address:refresh',
  'chain:query',
  'bcmr:token:read',
  'tokenindex:holders:read',
  'tx:propose',
  'tx:execute',
  'tx:operation:read',
  'ui:confirm',
  'contracts:derive',
  'contracts:propose',
  'signing:message_sign',
  'http:fetch_json',
] as const;

export const ADDON_SDK_CASHTOKEN_LIMITS = {
  maxFungibleAmount: '9223372036854775807',
  maxNftCommitmentBytes: 40,
  tokenOutputMinimumSats: 1000,
} as const;

export const ADDON_SDK_METHODS = {
  meta: ['getInfo', 'getAuditTrail'],
  wallet: [
    'getContext',
    'listAddresses',
    'getPrimaryAddress',
    'toTokenAddress',
  ],
  utxos: ['listForAddress', 'listForWallet', 'refreshAndStore'],
  chain: ['getLatestBlock', 'queryUnspentByLockingBytecode'],
  bcmr: ['getTokenMetadata', 'getTokenMetadataState'],
  tokenIndex: ['listTokenHolders'],
  tx: ['propose', 'getProposal', 'requestExecution', 'getOperation'],
  contracts: ['instantiate', 'deriveAddress', 'deriveLockingBytecode', 'propose'],
  signing: ['signMessage'],
  http: ['fetchJson'],
  ui: ['confirmSensitiveAction'],
} as const;

export type AddonSDKModule = keyof typeof ADDON_SDK_METHODS;
export type AddonSDKMethod = {
  [M in AddonSDKModule]: `${M}.${(typeof ADDON_SDK_METHODS)[M][number]}`;
}[AddonSDKModule];

export function getAddonSDKInfo(capabilities: AddonCapability[]): AddonSDKInfo {
  return {
    version: ADDON_SDK_VERSION,
    protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
    modules: Object.keys(ADDON_SDK_METHODS),
    methods: ADDON_SDK_METHODS,
    cashTokenIntents: ADDON_SDK_CASHTOKEN_INTENTS,
    cashTokenLimits: ADDON_SDK_CASHTOKEN_LIMITS,
    limits: ADDON_SDK_LIMITS,
    capabilities,
  };
}
