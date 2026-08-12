// src/services/AddonsSDK.ts
import type { AddonCapability, AddonManifest } from '../types/addons';
import {
  assertUrlAllowedForAddon,
  getAddonGrantedCapabilities,
} from './AddonsAllowlist';

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
import { getAddonSDKInfo, type AddonSDKInfo } from './addons/SDKContract';

import TransactionManager from '../apis/TransactionManager/TransactionManager';

import KeyService from './KeyService';
import BcmrService from './BcmrService';
import {
  SignatureTemplate,
  HashType,
  Contract,
  ElectrumNetworkProvider,
} from 'cashscript';
import parseInputValue from '../utils/parseInputValue';

import type {
  BcmrTokenMetadata,
  SignedMessageResponseI,
  UTXO,
  TransactionOutput,
} from '../types/types';

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

function outpointKey(utxo: { tx_hash: string; tx_pos: number }): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

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

  bcmr: {
    getTokenMetadata(category: string): Promise<BcmrTokenMetadata | null>;
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
      broadcastState?: BroadcastResult['broadcastState'];
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
    signMessage(args: {
      address: string;
      message: string;
    }): Promise<SignedMessageResponseI & {
      address: string;
      encoding: 'bch-signed-message';
    }>;
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

  const getReservedOutpointKeys = async (): Promise<Set<string>> => {
    const reserved = await OutboundTransactionTracker.listReservedOutpoints(
      ctx.walletId
    );
    return new Set(reserved.map((outpoint) => outpointKey(outpoint)));
  };

  const filterReservedUtxos = async (utxos: UTXO[]): Promise<UTXO[]> => {
    const reservedKeys = await getReservedOutpointKeys();
    if (reservedKeys.size === 0) return utxos;
    return utxos.filter((utxo) => !reservedKeys.has(outpointKey(utxo)));
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

    bcmr: {
      async getTokenMetadata(category: string) {
        await authorizeCapability('bcmr:token:read');
        const normalized = String(category ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(normalized)) {
          throw new Error('Invalid token category');
        }

        return await withPolicyTimeout(
          'bcmr.getTokenMetadata',
          20_000,
          async () => {
            let snapshot = await bcmr.getSnapshot(normalized);
            if (snapshot) return snapshot;

            try {
              const authbase = await bcmr.getCategoryAuthbase(normalized);
              await bcmr.resolveIdentityRegistry(authbase);
              snapshot = await bcmr.getSnapshot(normalized);
            } catch {
              return null;
            }
            return snapshot;
          }
        );
      },
    },

    tokenIndex: {
      async listTokenHolders({ category, limit, cursor }) {
        await authorizeCapability('tokenindex:holders:read');
        const normalized = String(category ?? '').trim().toLowerCase();
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
            const response = await fetch(url.toString(), {
              headers: {
                Accept: 'application/json',
              },
            });

            if (!response.ok) {
              throw new Error(
                `TokenIndex ${response.status}: ${await response.text()}`
              );
            }

            return (await response.json()) as {
              holders: Array<{
                locking_bytecode: string;
                locking_address?: string | null;
                ft_balance: string;
                utxo_count: number;
                updated_height: number;
              }>;
              next_cursor?: string | null;
            };
          }
        );
      },
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
          nftCommitment,
          false
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
          async () =>
            await TransactionService.sendTransaction(hex, undefined, {
              source: 'addon',
              sourceLabel: manifest.name
                ? `App: ${manifest.name}`
                : `App: ${manifest.id}`,
            })
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
      async signMessage({ address, message }) {
        await authorizeCapability('signing:message_sign');
        assertAddressAllowed(ctx, address);
        const signed = await withPolicyTimeout(
          'signing.signMessage',
          10_000,
          async () => await KeyService.signMessageForAddress(address, message)
        );
        return {
          ...signed,
          address,
          encoding: 'bch-signed-message' as const,
        };
      },

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
