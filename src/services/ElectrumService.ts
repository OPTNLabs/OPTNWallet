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
import { RequestResponse } from '@electrum-cash/network'; // <-- fix package
import { TransactionHistoryItem, UTXO } from '../types/types';

// ---------- Type Guards ----------
function isUTXOArray(response: RequestResponse): response is UTXO[] {
  return (
    Array.isArray(response) &&
    response.every(
      (item) => 'tx_hash' in item && 'height' in item && 'value' in item
    )
  );
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
    try {
      const UTXOs: RequestResponse = await server.request(
        'blockchain.address.listunspent',
        address
      );
      if (isUTXOArray(UTXOs)) {
        return UTXOs.map((utxo) => {
          if ((utxo as any).token_data) {
            (utxo as any).token = (utxo as any).token_data;
            delete (utxo as any).token_data;
          }
          return utxo;
        });
      }
      throw new Error('Invalid UTXO response format');
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
      return [];
    }
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
      // Initial status comes back from subscribe; notifications arrive later
      await server.subscribe('blockchain.address.subscribe', [address]);
      await ensureNotificationRouter();
      subscriptionRegistry['blockchain.address.subscribe'].set(
        address,
        callback
      );
    } catch (error) {
      console.error('Error subscribing to address:', error);
    }
  },

  /** Subscribe to block headers */
  async subscribeBlockHeaders(callback: (header: any) => void) {
    const server = ElectrumServer();
    try {
      await server.subscribe('blockchain.headers.subscribe'); // no params
      await ensureNotificationRouter();
      subscriptionRegistry['blockchain.headers.subscribe'].set('tip', callback);
    } catch (error) {
      console.error('Error subscribing to block headers:', error);
    }
  },

  /** Subscribe to a transaction’s confirmation updates */
  async subscribeTransaction(
    txHash: string,
    callback: (height: number) => void
  ) {
    const server = ElectrumServer();
    try {
      await server.subscribe('blockchain.transaction.subscribe', [txHash]);
      await ensureNotificationRouter();
      subscriptionRegistry['blockchain.transaction.subscribe'].set(
        txHash,
        callback
      );
    } catch (error) {
      console.error('Error subscribing to transaction:', error);
    }
  },

  /** Subscribe to double-spend proofs for a transaction */
  async subscribeDoubleSpendProof(
    txHash: string,
    callback: (dsProof: any) => void
  ) {
    const server = ElectrumServer();
    try {
      await server.subscribe('blockchain.transaction.dsproof.subscribe', [
        txHash,
      ]);
      await ensureNotificationRouter();
      subscriptionRegistry['blockchain.transaction.dsproof.subscribe'].set(
        txHash,
        callback
      );
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
      // Most servers don’t support an RPC unsubscribe for headers; our server wrapper
      // simply stops resubscribing after reconnect by removing local registry entries.
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
