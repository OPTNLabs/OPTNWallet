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
import { TransactionDetails, TransactionHistoryItem, UTXO } from '../types/types';
import { logError, toErrorMessage } from '../utils/errorHandling';
import {
  TransactionVisibility,
  addressToElectrumScripthash,
  deriveFeeSats,
  extractTimestamp,
  isInvalidAddressError,
  isStringResponse,
  isTransactionHistoryArray,
  isVerboseTransaction,
  mapOutputParticipant,
  mapUtxoRows,
  toVisibilityFromResponse,
} from './electrum/helpers';
import {
  persistTransactionDetails,
  readTransactionDetailsFromDb,
  resolveInputParticipants,
} from './electrum/transaction';
import {
  clearBlockHeaderListeners,
  registerAddressSubscription,
  registerBlockHeaderListener,
  registerDoubleSpendProofSubscription,
  registerTransactionSubscription,
  unregisterAddressSubscription,
  unregisterDoubleSpendProofSubscription,
  unregisterTransactionSubscription,
} from './electrum/subscriptions';

const inflightByAddr = new Map<string, Promise<UTXO[]>>();
const cacheByAddr = new Map<string, { ts: number; data: UTXO[] }>();
const UTXO_TTL_MS = 3000;
const inflightHistoryByAddr = new Map<string, Promise<TransactionHistoryItem[] | null>>();
const historyCacheByAddr = new Map<
  string,
  { ts: number; data: TransactionHistoryItem[] | null }
>();
const HISTORY_TTL_MS = 3000;
const inflightVisibilityByTxid = new Map<string, Promise<TransactionVisibility>>();
const visibilityCacheByTxid = new Map<
  string,
  { ts: number; data: TransactionVisibility }
>();
const VISIBILITY_TTL_MS = 5000;
const inflightDetailsByTxid = new Map<string, Promise<TransactionDetails | null>>();
const detailsCacheByTxid = new Map<
  string,
  { ts: number; data: TransactionDetails | null }
>();
const DETAILS_TTL_MS = 60000;

export function primeUTXOCache(address: string, utxos: UTXO[]) {
  cacheByAddr.set(address, { ts: Date.now(), data: utxos });
}

export function invalidateUTXOCache(address?: string) {
  if (address) {
    inflightByAddr.delete(address);
    cacheByAddr.delete(address);
    inflightHistoryByAddr.delete(address);
    historyCacheByAddr.delete(address);
  } else {
    inflightByAddr.clear();
    cacheByAddr.clear();
    inflightHistoryByAddr.clear();
    historyCacheByAddr.clear();
    inflightVisibilityByTxid.clear();
    visibilityCacheByTxid.clear();
    inflightDetailsByTxid.clear();
    detailsCacheByTxid.clear();
  }
}

async function requestWithAddressFallback(
  server: ReturnType<typeof ElectrumServer>,
  addressMethod: string,
  scripthashMethod: string,
  address: string,
  extraParams: RequestResponse[] = []
): Promise<RequestResponse> {
  try {
    return await server.request(addressMethod, address, ...extraParams);
  } catch (error) {
    if (!isInvalidAddressError(error)) {
      throw error;
    }

    const scripthash = addressToElectrumScripthash(address);
    return await server.request(scripthashMethod, scripthash, ...extraParams);
  }
}

const ElectrumService = {
  async reconnect(customServer?: string) {
    const server = ElectrumServer();
    invalidateUTXOCache();
    await server.electrumReconnect(customServer);
  },

  /** Fetch UTXOs for an address */
  async getUTXOs(address: string): Promise<UTXO[]> {
    const server = ElectrumServer();

    const now = Date.now();
    const cached = cacheByAddr.get(address);
    if (cached && now - cached.ts < UTXO_TTL_MS) {
      return cached.data;
    }

    const inflight = inflightByAddr.get(address);
    if (inflight) {
      return inflight;
    }

    const p = (async () => {
      try {
        const res = await requestWithAddressFallback(
          server,
          'blockchain.address.listunspent',
          'blockchain.scripthash.listunspent',
          address
        );
        if (Array.isArray(res)) {
          const arr = mapUtxoRows(address, res as Array<Record<string, unknown>>);
          cacheByAddr.set(address, { ts: Date.now(), data: arr });
          return arr;
        }
        console.warn(
          '[ElectrumService] non-array listunspent for',
          address,
          res
        );
        return cacheByAddr.get(address)?.data ?? [];
      } catch (e) {
        logError('ElectrumService.getUTXOs', e, { address });
        return cacheByAddr.get(address)?.data ?? [];
      } finally {
        inflightByAddr.delete(address);
      }
    })();

    inflightByAddr.set(address, p);
    return p;
  },

  async getUTXOsMany(addresses: string[]): Promise<Record<string, UTXO[]>> {
    const server = ElectrumServer();
    const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
    const results: Record<string, UTXO[]> = {};
    const pending: string[] = [];
    const pendingCalls: Array<{ method: string; params: RequestResponse[] }> = [];
    const now = Date.now();

    for (const address of uniqueAddresses) {
      const cached = cacheByAddr.get(address);
      if (cached && now - cached.ts < UTXO_TTL_MS) {
        results[address] = cached.data;
        continue;
      }

      const inflight = inflightByAddr.get(address);
      if (inflight) {
        results[address] = await inflight;
        continue;
      }

      pending.push(address);
      pendingCalls.push({
        method: 'blockchain.address.listunspent',
        params: [address],
      });
    }

    if (pendingCalls.length === 0) return results;

    const batchPromise = (async () => {
      try {
        const batchResults = await server.requestMany(pendingCalls);
        await Promise.all(batchResults.map(async (response, index) => {
          const address = pending[index];
          if (response instanceof Error) {
            if (isInvalidAddressError(response)) {
              try {
                const fallbackResponse = await requestWithAddressFallback(
                  server,
                  'blockchain.address.listunspent',
                  'blockchain.scripthash.listunspent',
                  address
                );
                if (Array.isArray(fallbackResponse)) {
                  const utxos = mapUtxoRows(
                    address,
                    fallbackResponse as Array<Record<string, unknown>>
                  );
                  cacheByAddr.set(address, { ts: Date.now(), data: utxos });
                  results[address] = utxos;
                  return;
                }
              } catch (fallbackError) {
                logError('ElectrumService.getUTXOsMany', fallbackError, { address });
              }
            }

            logError('ElectrumService.getUTXOsMany', response, { address });
            return;
          }

          if (Array.isArray(response)) {
            const utxos = mapUtxoRows(
              address,
              response as Array<Record<string, unknown>>
            );
            cacheByAddr.set(address, { ts: Date.now(), data: utxos });
            results[address] = utxos;
            return;
          }

          logError(
            'ElectrumService.getUTXOsMany.nonArrayResponse',
            new Error('Non-array Electrum response'),
            { address, response }
          );
        }));
      } finally {
        pending.forEach((address) => inflightByAddr.delete(address));
      }
      return results;
    })();

    for (const address of pending) {
      inflightByAddr.set(
        address,
        batchPromise.then((resolved) => resolved[address] ?? [])
      );
    }

    await batchPromise;
    return results;
  },

  /** Get total balance for an address */
  async getBalance(address: string): Promise<number> {
    const server = ElectrumServer();
    try {
      const response = (await requestWithAddressFallback(
        server,
        'blockchain.address.get_balance',
        'blockchain.scripthash.get_balance',
        address,
        ['include_tokens']
      )) as { confirmed?: unknown; unconfirmed?: unknown };
      if (
        response &&
        typeof response.confirmed === 'number' &&
        typeof response.unconfirmed === 'number'
      ) {
        return response.confirmed + response.unconfirmed;
      }
      throw new Error('Unexpected balance format');
    } catch (error) {
      logError('ElectrumService.getBalance', error, { address });
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
    } catch (error) {
      logError('ElectrumService.broadcastTransaction', error);
      return toErrorMessage(error);
    }
  },

  /** Fetch transaction history for an address */
  async getTransactionHistory(
    address: string
  ): Promise<TransactionHistoryItem[] | null> {
    const server = ElectrumServer();
    const now = Date.now();
    const cached = historyCacheByAddr.get(address);
    if (cached && now - cached.ts < HISTORY_TTL_MS) {
      return cached.data;
    }

    const inflight = inflightHistoryByAddr.get(address);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const history = await requestWithAddressFallback(
          server,
          'blockchain.address.get_history',
          'blockchain.scripthash.get_history',
          address
        );
        if (isTransactionHistoryArray(history)) {
          historyCacheByAddr.set(address, { ts: Date.now(), data: history });
          return history;
        }
        throw new Error('Invalid transaction history format');
      } catch (error) {
        logError('ElectrumService.getTransactionHistory', error, { address });
        return historyCacheByAddr.get(address)?.data ?? null;
      } finally {
        inflightHistoryByAddr.delete(address);
      }
    })();

    inflightHistoryByAddr.set(address, p);
    return p;
  },

  async getTransactionHistoryMany(
    addresses: string[]
  ): Promise<Record<string, TransactionHistoryItem[] | null>> {
    const server = ElectrumServer();
    const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
    const results: Record<string, TransactionHistoryItem[] | null> = {};
    const pending: string[] = [];
    const pendingCalls: Array<{ method: string; params: RequestResponse[] }> = [];
    const now = Date.now();

    for (const address of uniqueAddresses) {
      const cached = historyCacheByAddr.get(address);
      if (cached && now - cached.ts < HISTORY_TTL_MS) {
        results[address] = cached.data;
        continue;
      }

      const inflight = inflightHistoryByAddr.get(address);
      if (inflight) {
        results[address] = await inflight;
        continue;
      }

      pending.push(address);
      pendingCalls.push({
        method: 'blockchain.address.get_history',
        params: [address],
      });
    }

    if (pendingCalls.length === 0) return results;

    const batchPromise = (async () => {
      try {
        const batchResults = await server.requestMany(pendingCalls);
        await Promise.all(batchResults.map(async (response, index) => {
          const address = pending[index];
          if (response instanceof Error) {
            if (isInvalidAddressError(response)) {
              try {
                const fallbackResponse = await requestWithAddressFallback(
                  server,
                  'blockchain.address.get_history',
                  'blockchain.scripthash.get_history',
                  address
                );
                if (isTransactionHistoryArray(fallbackResponse)) {
                  historyCacheByAddr.set(address, {
                    ts: Date.now(),
                    data: fallbackResponse,
                  });
                  results[address] = fallbackResponse;
                  return;
                }
              } catch (fallbackError) {
                logError('ElectrumService.getTransactionHistoryMany', fallbackError, {
                  address,
                });
              }
            }

            logError('ElectrumService.getTransactionHistoryMany', response, {
              address,
            });
            results[address] = historyCacheByAddr.get(address)?.data ?? null;
            return;
          }

          if (isTransactionHistoryArray(response)) {
            historyCacheByAddr.set(address, {
              ts: Date.now(),
              data: response,
            });
            results[address] = response;
            return;
          }

          results[address] = historyCacheByAddr.get(address)?.data ?? null;
        }));
      } finally {
        pending.forEach((address) => inflightHistoryByAddr.delete(address));
      }
      return results;
    })();

    for (const address of pending) {
      inflightHistoryByAddr.set(
        address,
        batchPromise.then((resolved) => resolved[address] ?? null)
      );
    }

    await batchPromise;
    return results;
  },

  async getTransactionVisibility(txHash: string): Promise<TransactionVisibility> {
    const server = ElectrumServer();
    const now = Date.now();
    const cached = visibilityCacheByTxid.get(txHash);
    if (cached && now - cached.ts < VISIBILITY_TTL_MS) {
      return cached.data;
    }

    const inflight = inflightVisibilityByTxid.get(txHash);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const response: RequestResponse = await server.request(
          'blockchain.transaction.get',
          txHash,
          true
        );
        const visibility = toVisibilityFromResponse(response);

        visibilityCacheByTxid.set(txHash, {
          ts: Date.now(),
          data: visibility,
        });
        return visibility;
      } catch (error) {
        const message = toErrorMessage(error).toLowerCase();
        if (
          message.includes('no such mempool') ||
          message.includes('not found') ||
          message.includes('missing')
        ) {
          const visibility = { seen: false, confirmed: false };
          visibilityCacheByTxid.set(txHash, {
            ts: Date.now(),
            data: visibility,
          });
          return visibility;
        }
        logError('ElectrumService.getTransactionVisibility', error, { txHash });
        return visibilityCacheByTxid.get(txHash)?.data ?? {
          seen: false,
          confirmed: false,
        };
      } finally {
        inflightVisibilityByTxid.delete(txHash);
      }
    })();

    inflightVisibilityByTxid.set(txHash, p);
    return p;
  },

  async getTransactionVisibilityMany(
    txHashes: string[]
  ): Promise<Record<string, TransactionVisibility>> {
    const server = ElectrumServer();
    const uniqueTxHashes = Array.from(new Set(txHashes.filter(Boolean)));
    const results: Record<string, TransactionVisibility> = {};
    const pending: string[] = [];
    const pendingCalls: Array<{ method: string; params: RequestResponse[] }> = [];
    const now = Date.now();

    for (const txHash of uniqueTxHashes) {
      const cached = visibilityCacheByTxid.get(txHash);
      if (cached && now - cached.ts < VISIBILITY_TTL_MS) {
        results[txHash] = cached.data;
        continue;
      }

      const inflight = inflightVisibilityByTxid.get(txHash);
      if (inflight) {
        results[txHash] = await inflight;
        continue;
      }

      pending.push(txHash);
      pendingCalls.push({
        method: 'blockchain.transaction.get',
        params: [txHash, true],
      });
    }

    if (pendingCalls.length === 0) return results;

    const batchPromise = (async () => {
      try {
        const batchResults = await server.requestMany(pendingCalls);
        batchResults.forEach((response, index) => {
          const txHash = pending[index];

          if (response instanceof Error) {
            const message = toErrorMessage(response).toLowerCase();
            if (
              message.includes('no such mempool') ||
              message.includes('not found') ||
              message.includes('missing')
            ) {
              const visibility = { seen: false, confirmed: false };
              visibilityCacheByTxid.set(txHash, {
                ts: Date.now(),
                data: visibility,
              });
              results[txHash] = visibility;
              return;
            }

            logError('ElectrumService.getTransactionVisibilityMany', response, {
              txHash,
            });
            results[txHash] = visibilityCacheByTxid.get(txHash)?.data ?? {
              seen: false,
              confirmed: false,
            };
            return;
          }

          try {
            const visibility = toVisibilityFromResponse(response);
            visibilityCacheByTxid.set(txHash, {
              ts: Date.now(),
              data: visibility,
            });
            results[txHash] = visibility;
          } catch (error) {
            logError('ElectrumService.getTransactionVisibilityMany', error, {
              txHash,
            });
            results[txHash] = visibilityCacheByTxid.get(txHash)?.data ?? {
              seen: false,
              confirmed: false,
            };
          }
        });
      } finally {
        pending.forEach((txHash) => inflightVisibilityByTxid.delete(txHash));
      }
      return results;
    })();

    for (const txHash of pending) {
      inflightVisibilityByTxid.set(
        txHash,
        batchPromise.then(
          (resolved) =>
            resolved[txHash] ?? {
              seen: false,
              confirmed: false,
            }
        )
      );
    }

    await batchPromise;
    return results;
  },

  async getTransactionDetails(
    txHash: string,
    options?: { forceRefresh?: boolean }
  ): Promise<TransactionDetails | null> {
    const now = Date.now();
    const cached = detailsCacheByTxid.get(txHash);
    if (!options?.forceRefresh && cached && now - cached.ts < DETAILS_TTL_MS) {
      return cached.data;
    }

    const inflight = inflightDetailsByTxid.get(txHash);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const persisted = options?.forceRefresh
          ? null
          : await readTransactionDetailsFromDb(txHash);
        if (persisted) {
          detailsCacheByTxid.set(txHash, { ts: Date.now(), data: persisted });
          return persisted;
        }

        const server = ElectrumServer();
        const response = await server.request('blockchain.transaction.get', txHash, true);
        if (!isVerboseTransaction(response)) {
          throw new Error('Invalid transaction details response');
        }

        const outputs = Array.isArray(response.vout)
          ? response.vout.map(mapOutputParticipant)
          : [];
        const inputs = await resolveInputParticipants(server, response);
        const details: TransactionDetails = {
          txid:
            typeof response.txid === 'string' && response.txid.trim()
              ? response.txid
              : txHash,
          confirmations:
            typeof response.confirmations === 'number' && Number.isFinite(response.confirmations)
              ? response.confirmations
              : 0,
          height:
            typeof response.height === 'number' && Number.isFinite(response.height)
              ? response.height
              : undefined,
          feeSats: deriveFeeSats(response.fee, inputs, outputs),
          timestamp: extractTimestamp(response),
          inputs,
          outputs,
        };

        await persistTransactionDetails(details);
        detailsCacheByTxid.set(txHash, { ts: Date.now(), data: details });
        return details;
      } catch (error) {
        logError('ElectrumService.getTransactionDetails', error, { txHash });
        return detailsCacheByTxid.get(txHash)?.data ?? null;
      } finally {
        inflightDetailsByTxid.delete(txHash);
      }
    })();

    inflightDetailsByTxid.set(txHash, p);
    return p;
  },

  /** Fetch the latest block header */
  async getLatestBlock() {
    const server = ElectrumServer();
    try {
      return await server.request('blockchain.headers.get_tip');
    } catch (error) {
      logError('ElectrumService.getLatestBlock', error, {
        method: 'blockchain.headers.get_tip',
      });
      try {
        return await server.request('blockchain.headers.subscribe');
      } catch (fallbackError) {
        logError('ElectrumService.getLatestBlock', fallbackError, {
          method: 'blockchain.headers.subscribe',
        });
        return null;
      }
    }
  },

  /** Subscribe to address status updates */
  async subscribeAddress(address: string, callback: (status: string) => void) {
    try {
      await registerAddressSubscription(address, callback);
    } catch (error) {
      logError('ElectrumService.subscribeAddress', error, { address });
    }
  },

  /** Subscribe to block headers */
  async subscribeBlockHeaders(callback: (header: unknown) => void) {
    try {
      const latest = await registerBlockHeaderListener(callback);
      if (latest !== null) {
        callback(latest);
        return;
      }

      const fetchedLatest = await this.getLatestBlock();
      if (fetchedLatest !== null) {
        callback(fetchedLatest);
      }
    } catch (error) {
      logError('ElectrumService.subscribeBlockHeaders', error);
    }
  },

  /** Subscribe to a transaction’s confirmation updates */
  async subscribeTransaction(txHash: string, cb: (height: number) => void) {
    try {
      await registerTransactionSubscription(txHash, cb);
    } catch (error) {
      logError('ElectrumService.subscribeTransaction', error, { txHash });
    }
  },

  /** Subscribe to double-spend proofs for a transaction */
  async subscribeDoubleSpendProof(txHash: string, cb: (ds: unknown) => void) {
    try {
      await registerDoubleSpendProofSubscription(txHash, cb);
    } catch (error) {
      logError('ElectrumService.subscribeDoubleSpendProof', error, { txHash });
    }
  },

  /** Unsubscribe from address updates */
  async unsubscribeAddress(address: string): Promise<boolean> {
    try {
      await ElectrumServer().unsubscribe('blockchain.address.subscribe', [address]);
      unregisterAddressSubscription(address);
      return true;
    } catch (error) {
      logError('ElectrumService.unsubscribeAddress', error, { address });
      return false;
    }
  },

  /** Unsubscribe from block headers */
  async unsubscribeBlockHeaders(callback?: (header: unknown) => void): Promise<boolean> {
    try {
      return await clearBlockHeaderListeners(callback);
    } catch (error) {
      logError('ElectrumService.unsubscribeBlockHeaders', error);
      return false;
    }
  },

  /** Unsubscribe from transaction updates */
  async unsubscribeTransaction(txHash: string): Promise<boolean> {
    try {
      await ElectrumServer().unsubscribe('blockchain.transaction.subscribe', [txHash]);
      unregisterTransactionSubscription(txHash);
      return true;
    } catch (error) {
      logError('ElectrumService.unsubscribeTransaction', error, { txHash });
      return false;
    }
  },

  /** Unsubscribe from double-spend proofs */
  async unsubscribeDoubleSpendProof(txHash: string): Promise<boolean> {
    try {
      await ElectrumServer().unsubscribe('blockchain.transaction.dsproof.subscribe', [
        txHash,
      ]);
      unregisterDoubleSpendProofSubscription(txHash);
      return true;
    } catch (error) {
      logError('ElectrumService.unsubscribeDoubleSpendProof', error, { txHash });
      return false;
    }
  },
};

export default ElectrumService;
