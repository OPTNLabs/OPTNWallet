/**
 * ElectrumService.ts
 *
 * High-level wrapper around ElectrumServer that provides:
 *  - Request helpers for UTXOs, balances, transactions
 *  - Broadcasting transactions
 *  - Subscriptions (address, blocks, transactions, double-spend proofs)
 *  - Unsubscribe helpers
 *
 * Uses type guards to validate Electrum responses.
 * Maintains a central notification router to avoid duplicate listeners.
 */

import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import { RequestResponse } from '@electrum-cash/network';
import { TransactionHistoryItem, UTXO, Token } from '../types/types';

const inflightByAddr = new Map<string, Promise<UTXO[]>>();
const cacheByAddr = new Map<string, { ts: number; data: UTXO[] }>();
const UTXO_TTL_MS = 3000;

export function primeUTXOCache(address: string, utxos: UTXO[]) {
  cacheByAddr.set(address, { ts: Date.now(), data: utxos });
}

export function invalidateUTXOCache(address?: string) {
  if (address) {
    inflightByAddr.delete(address);
    cacheByAddr.delete(address);
  } else {
    inflightByAddr.clear();
    cacheByAddr.clear();
  }
}

/** Normalize any electrum token shape into our canonical Token */
function normalizeTokenField(raw: any): Token | null {
  if (!raw) return null;

  // Accept several common shapes:
  // - raw.token_data
  // - raw.token
  // - raw (already token-like)
  const t = raw.token ?? raw.token_data ?? raw;
  if (!t) return null;

  const category = t.category ?? t.tokenCategory ?? t.categoryId;
  if (!category) return null;

  let amount: number | bigint = t.amount ?? 0;
  if (typeof amount === 'string') {
    const n = Number(amount);
    amount = Number.isFinite(n) ? n : 0;
  }

  const nft = t.nft
    ? {
        capability: t.nft.capability as 'none' | 'mutable' | 'minting',
        commitment: t.nft.commitment ?? '',
      }
    : undefined;

  return {
    category: String(category),
    amount,
    nft,
    // BCMR metadata is added later in UTXOService
  };
}

function isTransactionHistoryArray(
  response: RequestResponse
): response is TransactionHistoryItem[] {
  return (
    Array.isArray(response) &&
    response.every((item) => 'tx_hash' in item && 'height' in item)
  );
}

function isStringResponse(response: RequestResponse): response is string {
  return typeof response === 'string';
}

// ---------- Notification Routing ----------
/**
 * Registry for active subscription callbacks.
 * Keys are RPC methods (e.g. blockchain.address.subscribe),
 * values are maps of subscription keys (address/txHash) to callbacks.
 */
const subscriptionRegistry: Record<string, Map<string, (data: any) => void>> = {
  'blockchain.address.subscribe': new Map(),
  'blockchain.headers.subscribe': new Map(),
  'blockchain.transaction.subscribe': new Map(),
  'blockchain.transaction.dsproof.subscribe': new Map(),
  // If later you add scripthash-based flow, just add:
  // 'blockchain.scripthash.subscribe': new Map(),
};

let routerInstalled = false;

/**
 * Sets up a single notification router via ElectrumServer.onNotification.
 * Ensures we only bind one listener no matter how many subscriptions exist.
 */
async function ensureNotificationRouter() {
  if (routerInstalled) return;

  const { onNotification } = ElectrumServer();
  onNotification((n) => {
    const { method, params } = n; // n = { jsonrpc, method, params }
    const registry = subscriptionRegistry[method];
    if (!registry) return;

    // Headers: params = [header]
    if (method === 'blockchain.headers.subscribe') {
      const header = params?.[0];
      const cb = registry.get('tip');
      if (cb) cb(header);
      return;
    }

    // Address/Tx/DSP: params = [key, data]
    const key = String(params?.[0] ?? '');
    const data = params?.[1];
    const cb = registry.get(key);
    if (cb) cb(data);
  });

  routerInstalled = true;
}

// ---------- Service ----------
const ElectrumService = {
  /** Fetch UTXOs for an address */
  async getUTXOs(address: string): Promise<UTXO[]> {
    const server = ElectrumServer();

    const now = Date.now();
    const cached = cacheByAddr.get(address);
    if (cached && now - cached.ts < UTXO_TTL_MS) {
      console.log(
        '[ElectrumService] cache hit for',
        address,
        'len=',
        cached.data.length
      );
      return cached.data;
    }

    const inflight = inflightByAddr.get(address);
    if (inflight) {
      console.log('[ElectrumService] coalesced inflight for', address);
      return inflight;
    }

    const p = (async () => {
      try {
        const res: RequestResponse = await server.request(
          'blockchain.address.listunspent',
          address
        );
        if (Array.isArray(res)) {
          const arr: UTXO[] = (res as any[]).map((u) => {
            const token = normalizeTokenField(u.token ?? u.token_data);

            const out: UTXO = {
              address: u.address ?? address,
              height: Number(u.height ?? 0),
              tx_hash: String(u.tx_hash),
              tx_pos: Number(u.tx_pos),
              value: Number(u.value ?? 0),
              amount: Number(u.value ?? 0),
              prefix: undefined, // set later in UTXOService if needed
              token, // canonical field our app expects
              token_data: undefined, // avoid carrying alternate field
              id: `${u.tx_hash}:${u.tx_pos}`,
            };
            return out;
          });

          cacheByAddr.set(address, { ts: Date.now(), data: arr });
          console.log(
            '[ElectrumService] network OK for',
            address,
            'len=',
            arr.length
          );
          return arr;
        }
        console.warn(
          '[ElectrumService] non-array listunspent for',
          address,
          res
        );
        return cacheByAddr.get(address)?.data ?? [];
      } catch (e) {
        console.error('[ElectrumService] error listunspent for', address, e);
        return cacheByAddr.get(address)?.data ?? [];
      } finally {
        inflightByAddr.delete(address);
      }
    })();

    inflightByAddr.set(address, p);
    return p;
  },

  /** Get total balance for an address */
  async getBalance(address: string): Promise<number> {
    const server = ElectrumServer();
    try {
      const response: any = await server.request(
        'blockchain.address.get_balance',
        address,
        'include_tokens'
      );
      if (
        response &&
        typeof response.confirmed === 'number' &&
        typeof response.unconfirmed === 'number'
      ) {
        return response.confirmed + response.unconfirmed;
      }
      throw new Error('Unexpected balance format');
    } catch (error) {
      console.error('Error getting balance:', error);
      return 0;
    }
  },

  /** Broadcast a raw transaction */
  async broadcastTransaction(txHex: string): Promise<string> {
    const server = ElectrumServer();
    try {
      const txHash: RequestResponse = await server.request(
        'blockchain.transaction.broadcast',
        txHex
      );
      if (isStringResponse(txHash)) return txHash;
      throw new Error('Invalid transaction hash response');
    } catch (error: any) {
      console.error('Error broadcasting transaction:', error);
      return error.message || 'Unknown error';
    }
  },

  /** Fetch transaction history for an address */
  async getTransactionHistory(
    address: string
  ): Promise<TransactionHistoryItem[] | null> {
    const server = ElectrumServer();
    try {
      const history: RequestResponse = await server.request(
        'blockchain.address.get_history',
        address
      );
      if (isTransactionHistoryArray(history)) return history;
      throw new Error('Invalid transaction history format');
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      return null;
    }
  },

  /** Fetch the latest block header */
  async getLatestBlock() {
    const server = ElectrumServer();
    try {
      return await server.request('blockchain.headers.get_tip');
    } catch (error) {
      console.error('Error fetching block tip:', error);
      return null;
    }
  },

  /** Subscribe to address status updates */
  async subscribeAddress(address: string, callback: (status: string) => void) {
    const server = ElectrumServer();
    try {
      const reg = subscriptionRegistry['blockchain.address.subscribe'];
      if (!reg.has(address)) {
        await server.subscribe('blockchain.address.subscribe', [address]);
        await ensureNotificationRouter();
      }
      reg.set(address, callback);
    } catch (error) {
      console.error('Error subscribing to address:', error);
    }
  },

  /** Subscribe to block headers */
  async subscribeBlockHeaders(callback: (header: any) => void) {
    const server = ElectrumServer();
    try {
      const reg = subscriptionRegistry['blockchain.headers.subscribe'];
      if (!reg.has('tip')) {
        await server.subscribe('blockchain.headers.subscribe'); // no params
        await ensureNotificationRouter();
      }
      reg.set('tip', callback);
    } catch (error) {
      console.error('Error subscribing to block headers:', error);
    }
  },

  /** Subscribe to a transaction’s confirmation updates */
  async subscribeTransaction(txHash: string, cb: (height: number) => void) {
    const server = ElectrumServer();
    try {
      const reg = subscriptionRegistry['blockchain.transaction.subscribe'];
      if (!reg.has(txHash)) {
        await server.subscribe('blockchain.transaction.subscribe', [txHash]);
        await ensureNotificationRouter();
      }
      reg.set(txHash, cb);
    } catch (error) {
      console.error('Error subscribing to transaction:', error);
    }
  },

  /** Subscribe to double-spend proofs for a transaction */
  async subscribeDoubleSpendProof(txHash: string, cb: (ds: any) => void) {
    const server = ElectrumServer();
    try {
      const reg =
        subscriptionRegistry['blockchain.transaction.dsproof.subscribe'];
      if (!reg.has(txHash)) {
        await server.subscribe('blockchain.transaction.dsproof.subscribe', [
          txHash,
        ]);
        await ensureNotificationRouter();
      }
      reg.set(txHash, cb);
    } catch (error) {
      console.error('Error subscribing to double-spend proof:', error);
    }
  },

  /** Unsubscribe from address updates */
  async unsubscribeAddress(address: string): Promise<boolean> {
    const server = ElectrumServer();
    try {
      await server.unsubscribe('blockchain.address.subscribe', [address]);
      subscriptionRegistry['blockchain.address.subscribe'].delete(address);
      return true;
    } catch (error) {
      console.error('Error unsubscribing from address:', error);
      return false;
    }
  },

  /** Unsubscribe from block headers */
  async unsubscribeBlockHeaders(): Promise<boolean> {
    const server = ElectrumServer();
    try {
      await server.unsubscribe('blockchain.headers.subscribe');
      subscriptionRegistry['blockchain.headers.subscribe'].delete('tip');
      return true;
    } catch (error) {
      console.error('Error unsubscribing from block headers:', error);
      return false;
    }
  },

  /** Unsubscribe from transaction updates */
  async unsubscribeTransaction(txHash: string): Promise<boolean> {
    const server = ElectrumServer();
    try {
      await server.unsubscribe('blockchain.transaction.subscribe', [txHash]);
      subscriptionRegistry['blockchain.transaction.subscribe'].delete(txHash);
      return true;
    } catch (error) {
      console.error('Error unsubscribing from transaction:', error);
      return false;
    }
  },

  /** Unsubscribe from double-spend proofs */
  async unsubscribeDoubleSpendProof(txHash: string): Promise<boolean> {
    const server = ElectrumServer();
    try {
      await server.unsubscribe('blockchain.transaction.dsproof.subscribe', [
        txHash,
      ]);
      subscriptionRegistry['blockchain.transaction.dsproof.subscribe'].delete(
        txHash
      );
      return true;
    } catch (error) {
      console.error('Error unsubscribing from double-spend proof:', error);
      return false;
    }
  },
};

export default ElectrumService;
