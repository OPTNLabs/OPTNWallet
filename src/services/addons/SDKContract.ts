import type { AddonCapability } from '../../types/addons';

export const ADDON_SDK_VERSION = '1.3.0' as const;

export const ADDON_SDK_FEATURES = {
  wallet: ['getContext', 'listAddresses'] as const,
  utxos: ['listForAddress', 'listForWallet', 'refreshAndStore'] as const,
  chain: ['getLatestBlock', 'queryUnspentByLockingBytecode'] as const,
  bcmr: ['getTokenMetadata'] as const,
  tokenIndex: ['listTokenHolders'] as const,
  tx: ['addOutput', 'build', 'broadcast'] as const,
  contracts: ['deriveAddress', 'deriveLockingBytecodeHex'] as const,
  signing: ['signMessage', 'signatureTemplateForAddress'] as const,
  http: ['fetchJson'] as const,
  ui: ['confirmSensitiveAction'] as const,
  logging: ['info', 'warn', 'error'] as const,
} as const;

export type AddonSDKModule = keyof typeof ADDON_SDK_FEATURES;

export type AddonSDKInfo = {
  version: typeof ADDON_SDK_VERSION;
  modules: AddonSDKModule[];
  methods: typeof ADDON_SDK_FEATURES;
  capabilities: AddonCapability[];
};

export function getAddonSDKInfo(
  capabilities: AddonCapability[]
): AddonSDKInfo {
  return {
    version: ADDON_SDK_VERSION,
    modules: Object.keys(ADDON_SDK_FEATURES) as AddonSDKModule[],
    methods: ADDON_SDK_FEATURES,
    capabilities,
  };
}
