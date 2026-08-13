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
  registerAddressSubscriptionsBulk,
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
const MAX_CACHE_ENTRIES = 500;

function evictStale<K, V extends { ts: number }>(
  map: Map<K, V>,
  ttlMs: number,
  maxEntries: number = MAX_CACHE_ENTRIES
) {
  const now = Date.now();
  if (map.size <= maxEntries) {
    for (const [k, v] of map) {
      if (now - v.ts > ttlMs) map.delete(k);
    }
    return;
  }
  const sorted = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toDelete = sorted.length - maxEntries;
  for (let i = 0; i < sorted.length; i++) {
    if (i < toDelete || now - sorted[i][1].ts > ttlMs) {
      map.delete(sorted[i][0]);
    }
  }
}
// 250 × 12s hard timeout produced live failures:
//   `requestMany(250) timed out after 12000ms`
// Smaller chunks + ElectrumServer.requestManyTimeoutMs(N) keep large wallets
// (hundreds of addresses) from blowing the batch budget.
const ELECTRUM_BATCH_SIZE = 50;
/**
 * How many listunspent chunks to fly at once on the same socket.
 * Fully serial was safe but slow on large wallets; unbounded parallel
 * overloaded Fulcrum (timeouts). Two in flight is the sweet spot we measured.
 */
const ELECTRUM_CHUNK_CONCURRENCY = 2;

type ElectrumBatchCall = {
  method: string;
  params?: RequestResponse[];
};

export function primeUTXOCache(address: string, utxos: UTXO[]) {
  evictStale(cacheByAddr, UTXO_TTL_MS);
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

async function requestManyInChunks(
  server: ReturnType<typeof ElectrumServer>,
  calls: ElectrumBatchCall[],
  onProgress?: (completedCount: number, totalCount: number) => void
): Promise<Array<RequestResponse | Error>> {
  if (calls.length === 0) return [];
  const chunks: ElectrumBatchCall[][] = [];
  for (let start = 0; start < calls.length; start += ELECTRUM_BATCH_SIZE) {
    chunks.push(calls.slice(start, start + ELECTRUM_BATCH_SIZE));
  }
  // Bounded parallel: keep slot order so results map back to addresses.
  // Concurrency 1 was correct but slow; unbounded parallel timed out.
  const out: Array<RequestResponse | Error> = new Array(calls.length);
  let nextChunk = 0;
  let completed = 0;

  const runWorker = async () => {
    // Claim the next chunk index (single-threaded JS; safe across concurrent awaits).
    for (
      let chunkIndex = nextChunk++;
      chunkIndex < chunks.length;
      chunkIndex = nextChunk++
    ) {
      const chunk = chunks[chunkIndex];
      const base = chunkIndex * ELECTRUM_BATCH_SIZE;
      const results = await server.requestMany(chunk);
      for (let i = 0; i < results.length; i++) {
        out[base + i] = results[i];
      }
      completed += chunk.length;
      onProgress?.(completed, calls.length);
    }
  };

  const workers = Math.min(ELECTRUM_CHUNK_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return out;
}

const ElectrumService = {
  async reconnect(customServer?: string) {
    const server = ElectrumServer();
    await server.electrumReconnect(customServer);
  },

  async ensureFreshConnection() {
    await ElectrumServer().ensureFreshConnection();
  },

  /**
   * Electrum address state (status hash). Same meaning as EC/Selene:
   * server fingerprint of address history for delta sync.
   */
  async getAddressState(address: string): Promise<string | null> {
    const many = await ElectrumService.getAddressStateMany([address]);
    return many[address] ?? null;
  },

  /**
   * Batch address-state probes via scripthash.subscribe.
   * Used by the ledger status-hash gate — must stay fast; callers should only
   * probe addresses that already have a local status to compare against.
   */
  async getAddressStateMany(
    addresses: string[]
  ): Promise<Record<string, string | null>> {
    const unique = Array.from(new Set(addresses.filter(Boolean)));
    const results: Record<string, string | null> = {};
    if (unique.length === 0) return results;

    const server = ElectrumServer();
    const pending: string[] = [];
    const calls: ElectrumBatchCall[] = [];

    for (const address of unique) {
      try {
        const scripthash = addressToElectrumScripthash(address);
        pending.push(address);
        calls.push({
          method: 'blockchain.scripthash.subscribe',
          params: [scripthash],
        });
      } catch {
        results[address] = null;
      }
    }

    if (calls.length === 0) return results;

    try {
      const batchResults = await requestManyInChunks(server, calls);
      batchResults.forEach((response, index) => {
        const address = pending[index];
        // Leave key absent on hard failure (do not confuse with unused=null).
        if (response instanceof Error) {
          return;
        }
        results[address] = typeof response === 'string' ? response : null;
      });
    } catch (error) {
      logError('ElectrumService.getAddressStateMany', error, {
        count: unique.length,
      });
      // Whole batch failed — leave keys absent (gate treats as dirty).
    }
    return results;
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
          evictStale(cacheByAddr, UTXO_TTL_MS);
          cacheByAddr.set(address, { ts: Date.now(), data: arr });
          return arr;
        }
        console.warn(
          '[ElectrumService] non-array listunspent for',
          address,
          res
        );
        // Prefer short TTL cache over inventing empty (empty wiped balances).
        const cachedFail = cacheByAddr.get(address);
        if (cachedFail) return cachedFail.data;
        throw new Error('listunspent non-array response');
      } catch (e) {
        logError('ElectrumService.getUTXOs', e, { address });
        const cachedFail = cacheByAddr.get(address);
        if (cachedFail) return cachedFail.data;
        throw e instanceof Error ? e : new Error(String(e));
      } finally {
        inflightByAddr.delete(address);
      }
    })();

    inflightByAddr.set(address, p);
    return p;
  },

  async getUTXOsMany(
    addresses: string[],
    onProgress?: (completedCount: number, totalCount: number) => void
  ): Promise<Record<string, UTXO[]>> {
    const server = ElectrumServer();
    const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
    const results: Record<string, UTXO[]> = {};
    const pending: string[] = [];
    const pendingCalls: Array<{ method: string; params: RequestResponse[] }> = [];
    const joinedInflight: Array<{ address: string; promise: Promise<UTXO[]> }> = [];
    const now = Date.now();

    // Prefer scripthash.* directly: `blockchain.address.*` is not implemented by
    // many ElectrumX/Fulcrum nodes (verified live: it returns {} or "Invalid
    // address"), which forced a serial fallback per address. Converting to
    // scripthash upfront is valid on every server and batches cleanly.
    //
    for (const address of uniqueAddresses) {
      const cached = cacheByAddr.get(address);
      if (cached && now - cached.ts < UTXO_TTL_MS) {
        results[address] = cached.data;
        continue;
      }

      const inflight = inflightByAddr.get(address);
      if (inflight) {
        joinedInflight.push({ address, promise: inflight });
        continue;
      }

      let scriptHash: string | null = null;
      try {
        scriptHash = addressToElectrumScripthash(address);
      } catch {
        scriptHash = null;
      }
      if (!scriptHash) {
        continue;
      }

      pending.push(address);
      pendingCalls.push({
        method: 'blockchain.scripthash.listunspent',
        params: [scriptHash],
      });
    }

    const cachedCount = uniqueAddresses.length - pending.length - joinedInflight.length;
    if (cachedCount > 0) {
      onProgress?.(cachedCount, uniqueAddresses.length);
    }
    if (pendingCalls.length === 0) {
      await Promise.all(
        joinedInflight.map(async ({ address, promise }) => {
          try {
            results[address] = await promise;
          } catch {
            // Failed listunspent — leave key absent (keep prior coins).
          }
        })
      );
      onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
      return results;
    }

    // Fire 0-progress immediately so callers (manual Sync) do not sit on a
    // frozen phase marker while the first Electrum batch is in flight.
    onProgress?.(cachedCount, uniqueAddresses.length);

    const batchPromise = (async () => {
      try {
        const batchResults = await requestManyInChunks(
          server,
          pendingCalls,
          (done) => {
            onProgress?.(cachedCount + done, uniqueAddresses.length);
          }
        );
        await Promise.all(batchResults.map(async (response, index) => {
          const address = pending[index];
          if (response instanceof Error) {
            logError('ElectrumService.getUTXOsMany', response, { address });
            // Do NOT write results[address] = [] — empty means "server said
            // zero coins". Missing key means "RPC failed; keep prior coins".
            return;
          }

          if (Array.isArray(response)) {
            const utxos = mapUtxoRows(
              address,
              response as Array<Record<string, unknown>>
            );
            evictStale(cacheByAddr, UTXO_TTL_MS);
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

    // CRITICAL: never resolve missing keys to []. Empty means "server said
    // zero coins"; missing key means "RPC failed — keep prior HOT UTXOs".
    for (const address of pending) {
      const p = batchPromise.then((resolved) => {
        if (Object.prototype.hasOwnProperty.call(resolved, address)) {
          return resolved[address] as UTXO[];
        }
        throw new Error('listunspent failed for address (no result)');
      });
      // Prevent unhandled rejection when no concurrent joiner awaits.
      void p.catch(() => undefined);
      inflightByAddr.set(address, p);
    }

    await Promise.all([
      batchPromise,
      ...joinedInflight.map(async ({ address, promise }) => {
        try {
          results[address] = await promise;
        } catch {
          // Failed listunspent — leave key absent (keep prior coins).
        }
      }),
    ]);
    onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
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

  /**
   * Fetch raw transaction hex (verbose=false). Used by the Option A ledger to
   * materialize full txi/txo from the wire format.
   */
  async getRawTransaction(txHash: string): Promise<string | null> {
    const server = ElectrumServer();
    try {
      const response = await server.request(
        'blockchain.transaction.get',
        txHash,
        false
      );
      if (isStringResponse(response) && response.length > 0) {
        return response;
      }
      return null;
    } catch (error) {
      logError('ElectrumService.getRawTransaction', error, { txHash });
      return null;
    }
  },

  /** Batch raw-tx hex fetch. Returns only successfully resolved txids. */
  async getRawTransactionMany(
    txHashes: string[]
  ): Promise<Record<string, string>> {
    const unique = Array.from(new Set(txHashes.filter(Boolean)));
    if (unique.length === 0) return {};

    const server = ElectrumServer();
    const results: Record<string, string> = {};
    try {
      const responses = await server.requestMany(
        unique.map((txid) => ({
          method: 'blockchain.transaction.get',
          params: [txid, false],
        }))
      );
      responses.forEach((response, index) => {
        const txid = unique[index];
        if (response instanceof Error) return;
        if (isStringResponse(response) && response.length > 0) {
          results[txid] = response;
        }
      });
    } catch (error) {
      logError('ElectrumService.getRawTransactionMany', error, {
        count: unique.length,
      });
    }
    return results;
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
          evictStale(historyCacheByAddr, HISTORY_TTL_MS);
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
    addresses: string[],
    onProgress?: (completedCount: number, totalCount: number) => void
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

      let scriptHash: string | null = null;
      try {
        scriptHash = addressToElectrumScripthash(address);
      } catch {
        scriptHash = null;
      }
      if (!scriptHash) continue;

      pending.push(address);
      pendingCalls.push({
        method: 'blockchain.scripthash.get_history',
        params: [scriptHash],
      });
    }

    const cachedCount = uniqueAddresses.length - pending.length;
    if (cachedCount > 0) {
      onProgress?.(cachedCount, uniqueAddresses.length);
    }

    if (pendingCalls.length === 0) {
      onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
      return results;
    }

    const batchPromise = (async () => {
      try {
        const batchResults = await requestManyInChunks(
          server,
          pendingCalls,
          (done) => {
            onProgress?.(cachedCount + done, uniqueAddresses.length);
          }
        );
        await Promise.all(batchResults.map(async (response, index) => {
          const address = pending[index];
          if (response instanceof Error) {
            logError('ElectrumService.getTransactionHistoryMany', response, {
              address,
            });
            results[address] = historyCacheByAddr.get(address)?.data ?? null;
            return;
          }

          if (isTransactionHistoryArray(response)) {
            evictStale(historyCacheByAddr, HISTORY_TTL_MS);
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

        evictStale(visibilityCacheByTxid, VISIBILITY_TTL_MS);
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
        const batchResults = await requestManyInChunks(server, pendingCalls);
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
          evictStale(visibilityCacheByTxid, VISIBILITY_TTL_MS);
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
            evictStale(visibilityCacheByTxid, VISIBILITY_TTL_MS);
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
          evictStale(detailsCacheByTxid, DETAILS_TTL_MS);
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
        const confs =
          typeof response.confirmations === 'number' && Number.isFinite(response.confirmations)
            ? response.confirmations
            : 0;
        let txHeight =
          typeof response.height === 'number' && Number.isFinite(response.height)
            ? response.height
            : undefined;
        // Some Electrum servers omit `height` in verbose tx response.  Derive
        // it from confirmations + current chain tip so the UI can display it.
        if (txHeight == null && confs > 0) {
          try {
            const tipResp = await server.request('blockchain.headers.get_tip');
            const tipObj = typeof tipResp === 'object' && tipResp !== null ? tipResp as Record<string, unknown> : null;
            const tipHeight =
              tipObj && typeof tipObj.height === 'number' && Number.isFinite(tipObj.height)
                ? tipObj.height
                : typeof tipResp === 'number'
                  ? tipResp
                  : undefined;
            if (tipHeight != null) txHeight = tipHeight - confs + 1;
          } catch {
            // non-fatal — height stays undefined
          }
        }
        const details: TransactionDetails = {
          txid:
            typeof response.txid === 'string' && response.txid.trim()
              ? response.txid
              : txHash,
          confirmations: confs,
          height: txHeight,
          feeSats: deriveFeeSats(response.fee, inputs, outputs),
          timestamp: extractTimestamp(response),
          inputs,
          outputs,
        };

        await persistTransactionDetails(details);
        evictStale(detailsCacheByTxid, DETAILS_TTL_MS);
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

  /** Bulk-subscribe addresses in one batched round-trip */
  async subscribeAddressesBulk(
    addresses: string[],
    callback?: (address: string, status: string) => void
  ) {
    try {
      await registerAddressSubscriptionsBulk(addresses, callback);
    } catch (error) {
      logError('ElectrumService.subscribeAddressesBulk', error, {
        addressCount: addresses.length,
      });
    }
  },

  /** Subscribe to block headers */
  async subscribeBlockHeaders(
    callback: (header: unknown) => void,
    options: { emitCurrent?: boolean } = {}
  ) {
    try {
      const latest = await registerBlockHeaderListener(callback);
      if (options.emitCurrent === false) return;
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
