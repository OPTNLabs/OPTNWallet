import type { AddonCapability } from '../../types/addons';

export const ADDON_SDK_VERSION = '1.6.0' as const;
export const ADDON_SDK_PROTOCOL_VERSION = 1 as const;
export const ADDON_SDK_LIMITS = {
  maxProposalInputs: 200,
  maxProposalOutputs: 100,
  maxMessageLength: 8192,
  maxIdempotencyKeyLength: 256,
} as const;

export const ADDON_SDK_FEATURES = {
  meta: ['getInfo', 'getAuditTrail'] as const,
  wallet: [
    'getContext',
    'listAddresses',
    'getPrimaryAddress',
    'toTokenAddress',
  ] as const,
  utxos: ['listForAddress', 'listForWallet', 'refreshAndStore'] as const,
  chain: ['getLatestBlock', 'queryUnspentByLockingBytecode'] as const,
  bcmr: ['getTokenMetadata', 'getTokenMetadataState'] as const,
  tokenIndex: ['listTokenHolders'] as const,
  // Third-party integrations propose unsigned intent and ask the wallet-owned
  // runtime to execute it. Legacy build/broadcast are deliberately omitted.
  tx: [
    'propose',
    'getProposal',
    'requestExecution',
    'getOperation',
    'addOutput',
  ] as const,
  // Generic CashScript artifacts and ABI-typed calls are public. Contract
  // construction, signer resolution, transaction building, and broadcasting
  // remain wallet-owned runtime operations; no registry is required here.
  // `signatureTemplateForAddress` remains only as a host-private compatibility
  // method for the compiled FundMe prototype. It is intentionally absent from
  // the advertised third-party contract because CashScript SignatureTemplate
  // contains private key bytes.
  signing: ['signMessage'] as const,
  http: ['fetchJson'] as const,
  ui: ['confirmSensitiveAction'] as const,
} as const;

/** Explicit CashToken state transitions understood by tx.propose. */
export const ADDON_SDK_CASHTOKEN_INTENTS = [
  'transfer',
  'mint-fungible',
  'mint-nft',
  'mutate-nft',
  'burn',
] as const;

/** Public CashToken protocol limits used by proposal validation and builders. */
export const ADDON_SDK_CASHTOKEN_LIMITS = {
  maxFungibleAmount: '9223372036854775807',
  maxNftCommitmentBytes: 40,
  tokenOutputMinimumSats: 1000,
} as const;

export type AddonSDKModule = keyof typeof ADDON_SDK_FEATURES;

export type AddonSDKInfo = {
  version: typeof ADDON_SDK_VERSION;
  protocolVersion: typeof ADDON_SDK_PROTOCOL_VERSION;
  modules: AddonSDKModule[];
  methods: typeof ADDON_SDK_FEATURES;
  cashTokenIntents: typeof ADDON_SDK_CASHTOKEN_INTENTS;
  cashTokenLimits: typeof ADDON_SDK_CASHTOKEN_LIMITS;
  limits: typeof ADDON_SDK_LIMITS;
  capabilities: AddonCapability[];
};

export function getAddonSDKInfo(capabilities: AddonCapability[]): AddonSDKInfo {
  return {
    version: ADDON_SDK_VERSION,
    protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
    modules: Object.keys(ADDON_SDK_FEATURES) as AddonSDKModule[],
    methods: ADDON_SDK_FEATURES,
    cashTokenIntents: ADDON_SDK_CASHTOKEN_INTENTS,
    cashTokenLimits: ADDON_SDK_CASHTOKEN_LIMITS,
    limits: ADDON_SDK_LIMITS,
    capabilities,
  };
}
