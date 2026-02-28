// src/services/AddonsSDK.ts
import type { AddonCapability, AddonManifest } from '../types/addons';
import {
  assertUrlAllowedForAddon,
  getAddonGrantedCapabilities,
} from './AddonsAllowlist';

import ElectrumService from './ElectrumService';
import TransactionService from './TransactionService';
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
import { getAddonSDKInfo, type AddonSDKInfo } from './addons/SDKContract';

import TransactionManager from '../apis/TransactionManager/TransactionManager';

import KeyService from './KeyService';
import {
  SignatureTemplate,
  HashType,
  Contract,
  ElectrumNetworkProvider,
} from 'cashscript';
import parseInputValue from '../utils/parseInputValue';

import type { UTXO, TransactionOutput } from '../types/types';

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
  const ctorInputs = (artifact as { constructorInputs?: unknown }).constructorInputs;
  if (!Array.isArray(ctorInputs)) return undefined;
  const input = ctorInputs[index];
  if (!input || typeof input !== 'object') return undefined;
  const maybeType = (input as { type?: unknown }).type;
  return typeof maybeType === 'string' ? maybeType : undefined;
};

export type AddonSDKContext = {
  walletId: number;
  network?: string | null;
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

  /**
   * BCMR access is intentionally fail-closed for now.
   * We’ll wire it later via a permission-gated HTTP bridge.
   */
  bcmr: {
    enabled: false;
    whyDisabled: string;
  };

  chain: {
    getLatestBlock(): Promise<unknown>;
    queryUnspentByLockingBytecode(
      lockingBytecodeHex: string,
      tokenId: string
    ): Promise<GraphQLResponse>;
  };

  tx: {
    addOutput(params: {
      recipientAddress: string;
      transferAmount: number;
      tokenAmount: number | bigint;
      selectedTokenCategory?: string;
      selectedUtxos?: UTXO[];
      addresses?: { address: string; tokenAddress?: string }[];
      nftCapability?: undefined | 'none' | 'mutable' | 'minting';
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
    }>;
  };

  contracts: {
    deriveAddress(params: {
      artifact: unknown;
      constructorInputs?: unknown[];
    }): string;
    deriveLockingBytecodeHex(params: {
      artifact: unknown;
      constructorInputs?: unknown[];
    }): string;
  };

  signing: {
    // never return private keys; return SignatureTemplate only
    signatureTemplateForAddress(address: string): Promise<SignatureTemplate>;
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

function assertAddressAllowed(ctx: AddonSDKContext, address: string) {
  if (!address || typeof address !== 'string')
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
  const txMgr = TransactionManager();
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
    requireCapability(capability);
    await policy.authorizeCapability(capability);
  };

  const withPolicyTimeout = async <T,>(
    operation: string,
    timeoutMs: number,
    run: () => Promise<T>
  ) => {
    return await policy.withTimeout(operation, timeoutMs, run);
  };

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
          async () => await TransactionService.fetchAddressesAndUTXOs(ctx.walletId)
        );
        return addresses;
      },

      async getPrimaryAddress() {
        await authorizeCapability('wallet:addresses:read');
        const { addresses } = await withPolicyTimeout(
          'wallet.getPrimaryAddress',
          15_000,
          async () => await TransactionService.fetchAddressesAndUTXOs(ctx.walletId)
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
        return await withPolicyTimeout(
          'utxos.listForAddress',
          20_000,
          async () => await ElectrumService.getUTXOs(address)
        );
      },

      async listForWallet() {
        await authorizeCapability('utxo:wallet:read');
        return await withPolicyTimeout(
          'utxos.listForWallet',
          25_000,
          async () => await UTXOService.fetchAllWalletUtxos(ctx.walletId)
        );
      },

      async refreshAndStore(address: string) {
        await authorizeCapability('utxo:address:refresh');
        assertAddressAllowed(ctx, address);
        // DB write path (still safe; no secrets exposed)
        return await withPolicyTimeout(
          'utxos.refreshAndStore',
          30_000,
          async () => await UTXOService.fetchAndStoreUTXOs(ctx.walletId, address)
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

      async queryUnspentByLockingBytecode(lockingBytecodeHex: string, tokenId: string) {
        await authorizeCapability('chain:query');
        return await withPolicyTimeout(
          'chain.queryUnspentByLockingBytecode',
          20_000,
          async () =>
            await queryUnspentOutputsByLockingBytecode(lockingBytecodeHex, tokenId)
        );
      },
    },

    // Fail-closed BCMR for now (keeps marketplace rules simple)
    bcmr: {
      enabled: false,
      whyDisabled:
        'BCMR is not exposed to addons yet. Wire via permission-gated HTTP endpoints later.',
    },

    tx: {
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
          nftCommitment
        );
      },

      async build({ inputs, outputs, changeAddress }) {
        await authorizeCapability('tx:build');
        // Modules must provide any contract unlockers on the input UTXOs themselves.
        // contractFunctionInputs is intentionally `null` here.
        const res = await withPolicyTimeout(
          'tx.build',
          20_000,
          async () =>
            await txMgr.buildTransaction(outputs, null, changeAddress ?? '', inputs)
        );

        return {
          hex: res.finalTransaction,
          bytes: res.bytecodeSize,
          finalOutputs: res.finalOutputs,
          errorMsg: res.errorMsg,
        };
      },

      async broadcast(hex: string) {
        await authorizeCapability('tx:broadcast');
        return await withPolicyTimeout(
          'tx.broadcast',
          20_000,
          async () => await txMgr.sendTransaction(hex)
        );
      },
    },

    contracts: {
      deriveAddress({ artifact, constructorInputs }) {
        requireCapability('contracts:derive');
        const provider = new ElectrumNetworkProvider(
          toProviderNetwork(ctx.network)
        );
        const args = Array.isArray(constructorInputs)
          ? constructorInputs.map((raw, idx) =>
              parseInputValue(raw, getConstructorInputType(artifact, idx))
            )
          : [];
        const contract = new Contract(
          artifact as ConstructorParameters<typeof Contract>[0],
          args,
          {
          provider,
          addressType: 'p2sh32',
          }
        );
        return contract.tokenAddress || contract.address;
      },

      deriveLockingBytecodeHex({ artifact, constructorInputs }) {
        requireCapability('contracts:derive');
        const provider = new ElectrumNetworkProvider(
          toProviderNetwork(ctx.network)
        );
        const args = Array.isArray(constructorInputs)
          ? constructorInputs.map((raw, idx) =>
              parseInputValue(raw, getConstructorInputType(artifact, idx))
            )
          : [];
        const contract = new Contract(
          artifact as ConstructorParameters<typeof Contract>[0],
          args,
          {
          provider,
          addressType: 'p2sh32',
          }
        );
        if (typeof contract.bytecode === 'string') return contract.bytecode;
        return Array.from(contract.bytecode as Uint8Array, (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('');
      },
    },

    signing: {
      async signatureTemplateForAddress(address: string) {
        await authorizeCapability('signing:signature_template');
        assertAddressAllowed(ctx, address);
        const pk = await withPolicyTimeout(
          'signing.signatureTemplateForAddress',
          10_000,
          async () => await KeyService.fetchAddressPrivateKey(address)
        );
        if (!pk) throw new Error(`Missing private key for address: ${address}`);
        return new SignatureTemplate(pk, HashType.SIGHASH_ALL);
      },
    },

    http: {
      async fetchJson<T>(url: string, init?: RequestInit) {
        // HTTP is gated by domain permission and this explicit capability.
        // This keeps "network read" separate from wallet mutations/signing scopes.
        await authorizeCapability('http:fetch_json');
        // enforce addon permission + global allowlist
        assertUrlAllowedForAddon(manifest, url);

        const res = await withPolicyTimeout('http.fetchJson', 20_000, async () =>
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
      info: (...args) => console.log(`[addon:${manifest.id}]`, ...args),
      warn: (...args) => console.warn(`[addon:${manifest.id}]`, ...args),
      error: (...args) => console.error(`[addon:${manifest.id}]`, ...args),
    },
  };
}
