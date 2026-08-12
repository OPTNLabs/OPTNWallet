// src/services/AddonsSDK.ts

import type { AddonManifest } from '../types/addons';
import { assertUrlAllowedForAddon } from './AddonsAllowlist';

import ElectrumService from './ElectrumService';
import UTXOService from './UTXOService';

import TransactionManager from '../apis/TransactionManager/TransactionManager';

import KeyService from './KeyService';
import { SignatureTemplate, HashType } from 'cashscript';

import type { UTXO, TransactionOutput } from '../types/types';

export type AddonSDKContext = {
  walletId: number;
  /**
   * Optional hardening:
   * if provided, SDK will only allow addons to query addresses in this set.
   */
  walletAddresses?: Set<string>;
};

export type AddonSDK = {
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

  tx: {
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

  signing: {
    // never return private keys; return SignatureTemplate only
    signatureTemplateForAddress(address: string): Promise<SignatureTemplate>;
  };

  http: {
    fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  };

  logging: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
};

function assertAddressAllowed(ctx: AddonSDKContext, address: string) {
  if (!address || typeof address !== 'string')
    throw new Error('Invalid address');
  if (ctx.walletAddresses && !ctx.walletAddresses.has(address)) {
    throw new Error(`Addon attempted access to non-wallet address: ${address}`);
  }
}

export function createAddonSDK(
  manifest: AddonManifest,
  ctx: AddonSDKContext
): AddonSDK {
  const txMgr = TransactionManager();

  return {
    utxos: {
      async listForAddress(address: string) {
        assertAddressAllowed(ctx, address);
        // read-only electrum fetch (no DB)
        return await ElectrumService.getUTXOs(address);
      },

      async listForWallet() {
        return await UTXOService.fetchAllWalletUtxos(ctx.walletId);
      },

      async refreshAndStore(address: string) {
        assertAddressAllowed(ctx, address);
        // DB write path (still safe; no secrets exposed)
        return await UTXOService.fetchAndStoreUTXOs(ctx.walletId, address);
      },
    },

    // Fail-closed BCMR for now (keeps marketplace rules simple)
    bcmr: {
      enabled: false,
      whyDisabled:
        'BCMR is not exposed to addons yet. Wire via permission-gated HTTP endpoints later.',
    },

    tx: {
      async build({ inputs, outputs, changeAddress }) {
        // Modules must provide any contract unlockers on the input UTXOs themselves.
        // contractFunctionInputs is intentionally `null` here.
        const res = await txMgr.buildTransaction(
          outputs,
          null,
          changeAddress ?? '',
          inputs
        );

        return {
          hex: res.finalTransaction,
          bytes: res.bytecodeSize,
          finalOutputs: res.finalOutputs,
          errorMsg: res.errorMsg,
        };
      },

      async broadcast(hex: string) {
        return await txMgr.sendTransaction(hex);
      },
    },

    signing: {
      async signatureTemplateForAddress(address: string) {
        assertAddressAllowed(ctx, address);
        const pk = await KeyService.fetchAddressPrivateKey(address);
        if (!pk) throw new Error(`Missing private key for address: ${address}`);
        return new SignatureTemplate(pk, HashType.SIGHASH_ALL);
      },
    },

    http: {
      async fetchJson<T>(url: string, init?: RequestInit) {
        // enforce addon permission + global allowlist
        assertUrlAllowedForAddon(manifest, url);

        const res = await fetch(url, {
          ...init,
          // safety: avoid cookies/credentials leakage
          credentials: 'omit',
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return (await res.json()) as T;
      },
    },

    logging: {
      info: (...args) => console.log(`[addon:${manifest.id}]`, ...args),
      warn: (...args) => console.warn(`[addon:${manifest.id}]`, ...args),
      error: (...args) => console.error(`[addon:${manifest.id}]`, ...args),
    },
  };
}
