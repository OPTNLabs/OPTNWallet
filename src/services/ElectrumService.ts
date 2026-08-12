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
import {
  TransactionDetails,
  TransactionDetailParticipant,
  TransactionHistoryItem,
  UTXO,
} from '../types/types';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import {
  cashAddressToLockingBytecode,
  lockingBytecodeToCashAddress,
  sha256,
} from '@bitauth/libauth';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { Network } from '../redux/networkSlice';
import { store } from '../redux/store';
import { binToHex, hexToBin } from '../utils/hex';
import { normalizeTokenField } from '../utils/tokenNormalization';
import { logError, toErrorMessage } from '../utils/errorHandling';

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
type BlockHeaderCallback = (header: unknown) => void;
const blockHeaderListeners = new Set<BlockHeaderCallback>();
let latestBlockHeader: unknown = null;

function getDbService() {
  return DatabaseService();
}

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

function isTransactionHistoryArray(
  response: RequestResponse
): response is TransactionHistoryItem[] {
  return (
    Array.isArray(response) &&
    response.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        'tx_hash' in item &&
        'height' in item
    )
  );
}

function isStringResponse(response: RequestResponse): response is string {
  return typeof response === 'string';
}

type ElectrumVin = {
  txid?: unknown;
  vout?: unknown;
  coinbase?: unknown;
};

type ElectrumVout = {
  value?: unknown;
  n?: unknown;
  scriptPubKey?: {
    address?: unknown;
    addresses?: unknown;
    hex?: unknown;
  };
};

type ElectrumVerboseTransaction = {
  txid?: unknown;
  confirmations?: unknown;
  blocktime?: unknown;
  time?: unknown;
  height?: unknown;
  fee?: unknown;
  vin?: ElectrumVin[];
  vout?: ElectrumVout[];
};

function isVerboseTransaction(
  response: RequestResponse
): response is ElectrumVerboseTransaction {
  return !!response && typeof response === 'object' && !Array.isArray(response);
}

export type TransactionVisibility = {
  seen: boolean;
  confirmed: boolean;
};

function currentAddressPrefix(): 'bitcoincash' | 'bchtest' {
  const network = selectCurrentNetwork(store.getState());
  return network === Network.CHIPNET ? 'bchtest' : 'bitcoincash';
}

function toSats(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100_000_000);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100_000_000) : undefined;
  }
  return undefined;
}

function decodeAddressFromScriptHex(scriptHex: unknown): string | null {
  if (typeof scriptHex !== 'string' || !scriptHex.trim()) return null;
  try {
    const result = lockingBytecodeToCashAddress({
      bytecode: hexToBin(scriptHex),
      prefix: currentAddressPrefix(),
    });
    return typeof result === 'string' ? result : result.address;
  } catch {
    return null;
  }
}

function isInvalidAddressError(error: unknown): boolean {
  return toErrorMessage(error).toLowerCase().includes('invalid address');
}

function addressToElectrumScripthash(address: string): string {
  const lockingBytecode = cashAddressToLockingBytecode(address);
  if (typeof lockingBytecode === 'string') {
    throw new Error(`Invalid address: ${address}`);
  }

  const digest = sha256.hash(lockingBytecode.bytecode);
  return binToHex(Uint8Array.from(digest).reverse());
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

function extractOutputAddress(vout: ElectrumVout): string {
  const script = vout.scriptPubKey;
  if (typeof script?.address === 'string' && script.address.trim()) {
    return script.address;
  }

  const addresses = Array.isArray(script?.addresses)
    ? script.addresses.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
      )
    : [];
  if (addresses.length > 0) {
    return addresses.join(', ');
  }

  return decodeAddressFromScriptHex(script?.hex) ?? 'Unknown / non-standard output';
}

function extractTimestamp(tx: ElectrumVerboseTransaction): string | undefined {
  const candidate =
    typeof tx.blocktime === 'number'
      ? tx.blocktime
      : typeof tx.time === 'number'
        ? tx.time
        : null;
  return candidate != null ? new Date(candidate * 1000).toISOString() : undefined;
}

function mapOutputParticipant(vout: ElectrumVout): TransactionDetailParticipant {
  return {
    address: extractOutputAddress(vout),
    amountSats: toSats(vout.value),
    outputIndex:
      typeof vout.n === 'number' && Number.isFinite(vout.n)
        ? vout.n
        : undefined,
  };
}

function sumKnownSats(rows: TransactionDetailParticipant[]): number | undefined {
  let total = 0;
  for (const row of rows) {
    if (row.amountSats == null || !Number.isFinite(row.amountSats)) {
      return undefined;
    }
    total += row.amountSats;
  }
  return total;
}

function deriveFeeSats(
  fee: unknown,
  inputs: TransactionDetailParticipant[],
  outputs: TransactionDetailParticipant[]
): number | undefined {
  const explicitFee = toSats(fee);
  if (explicitFee != null) return explicitFee;

  const totalInput = sumKnownSats(inputs);
  const totalOutput = sumKnownSats(outputs);
  if (totalInput == null || totalOutput == null) return undefined;

  const derived = totalInput - totalOutput;
  return derived >= 0 ? derived : undefined;
}

function currentWalletId(): number | null {
  return store.getState().wallet_id.currentWalletId ?? null;
}

function normalizeParticipantRows(raw: unknown): TransactionDetailParticipant[] {
  if (!Array.isArray(raw)) return [];
  const rows: TransactionDetailParticipant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    rows.push({
      address: typeof row.address === 'string' ? row.address : 'Unknown',
      amountSats:
        typeof row.amountSats === 'number' && Number.isFinite(row.amountSats)
          ? row.amountSats
          : undefined,
      outputIndex:
        typeof row.outputIndex === 'number' && Number.isFinite(row.outputIndex)
          ? row.outputIndex
          : undefined,
    });
  }
  return rows;
}

async function readTransactionDetailsFromDb(
  txHash: string
): Promise<TransactionDetails | null> {
  const walletId = currentWalletId();
  if (!walletId) return null;

  const dbService = getDbService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const stmt = db.prepare(`
    SELECT tx_hash, confirmations, height, fee_sats, timestamp, inputs_json, outputs_json
    FROM transaction_details
    WHERE wallet_id = ? AND tx_hash = ?
    LIMIT 1;
  `);

  try {
    stmt.bind([walletId, txHash]);
    if (!stmt.step()) return null;

    const row = stmt.getAsObject() as Record<string, unknown>;
    const inputs = normalizeParticipantRows(
      typeof row.inputs_json === 'string' ? JSON.parse(row.inputs_json) : []
    );
    const outputs = normalizeParticipantRows(
      typeof row.outputs_json === 'string' ? JSON.parse(row.outputs_json) : []
    );

    return {
      txid: typeof row.tx_hash === 'string' ? row.tx_hash : txHash,
      confirmations: Number(row.confirmations ?? 0),
      height:
        row.height === null || row.height === undefined
          ? undefined
          : Number(row.height),
      feeSats:
        row.fee_sats === null || row.fee_sats === undefined
          ? undefined
          : Number(row.fee_sats),
      timestamp:
        typeof row.timestamp === 'string' && row.timestamp.trim()
          ? row.timestamp
          : undefined,
      inputs,
      outputs,
    };
  } catch (error) {
    logError('ElectrumService.readTransactionDetailsFromDb', error, { txHash });
    return null;
  } finally {
    stmt.free();
  }
}

async function persistTransactionDetails(details: TransactionDetails): Promise<void> {
  const walletId = currentWalletId();
  if (!walletId) return;

  const dbService = getDbService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;

  try {
    const stmt = db.prepare(`
      INSERT INTO transaction_details (
        wallet_id, tx_hash, confirmations, height, fee_sats, timestamp,
        inputs_json, outputs_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
        confirmations = excluded.confirmations,
        height = excluded.height,
        fee_sats = excluded.fee_sats,
        timestamp = excluded.timestamp,
        inputs_json = excluded.inputs_json,
        outputs_json = excluded.outputs_json,
        updated_at = excluded.updated_at
    `);

    stmt.run([
      walletId,
      details.txid,
      details.confirmations,
      details.height ?? null,
      details.feeSats ?? null,
      details.timestamp ?? '',
      JSON.stringify(details.inputs),
      JSON.stringify(details.outputs),
      new Date().toISOString(),
    ]);
    stmt.free();
    dbService.scheduleDatabaseSave();
  } catch (error) {
    logError('ElectrumService.persistTransactionDetails', error, {
      txHash: details.txid,
    });
  }
}

async function fetchVerboseTransactions(
  server: ReturnType<typeof ElectrumServer>,
  txids: string[]
): Promise<Record<string, ElectrumVerboseTransaction>> {
  const uniqueTxids = Array.from(new Set(txids.filter(Boolean)));
  if (uniqueTxids.length === 0) return {};

  const responses = await server.requestMany(
    uniqueTxids.map((txid) => ({
      method: 'blockchain.transaction.get',
      params: [txid, true],
    }))
  );

  const resolved: Record<string, ElectrumVerboseTransaction> = {};
  responses.forEach((response, index) => {
    const txid = uniqueTxids[index];
    if (response instanceof Error) return;
    if (!isVerboseTransaction(response)) return;
    resolved[txid] = response;
  });
  return resolved;
}

async function resolveInputParticipants(
  server: ReturnType<typeof ElectrumServer>,
  tx: ElectrumVerboseTransaction
): Promise<TransactionDetailParticipant[]> {
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const prevTxids = vin
    .map((input) => (typeof input.txid === 'string' ? input.txid : ''))
    .filter(Boolean);
  const prevTxs = await fetchVerboseTransactions(server, prevTxids);

  return vin.map((input) => {
    if (typeof input.coinbase === 'string' && input.coinbase.length > 0) {
      return { address: 'Coinbase' };
    }

    const prevTxid = typeof input.txid === 'string' ? input.txid : '';
    const prevIndex =
      typeof input.vout === 'number' && Number.isFinite(input.vout)
        ? input.vout
        : Number(input.vout ?? -1);
    const prevTx = prevTxs[prevTxid];
    const prevOut =
      prevTx && Array.isArray(prevTx.vout) && prevIndex >= 0
        ? prevTx.vout.find((output) => Number(output.n ?? -1) === prevIndex)
        : undefined;

    if (!prevOut) {
      return {
        address: prevTxid ? `Prevout ${prevTxid.slice(0, 10)}...:${prevIndex}` : 'Unknown input',
      };
    }

    return {
      address: extractOutputAddress(prevOut),
      amountSats: toSats(prevOut.value),
      outputIndex: prevIndex >= 0 ? prevIndex : undefined,
    };
  });
}

function mapUtxoRows(address: string, rows: Array<Record<string, unknown>>): UTXO[] {
  return rows.map((u) => {
    const token = normalizeTokenField(u.token ?? u.token_data);

    const out: UTXO = {
      address: typeof u.address === 'string' ? u.address : address,
      height: Number(u.height ?? 0),
      tx_hash: String(u.tx_hash),
      tx_pos: Number(u.tx_pos),
      value: Number(u.value ?? 0),
      amount: Number(u.value ?? 0),
      prefix: undefined,
      token,
      token_data: undefined,
      id: `${u.tx_hash}:${u.tx_pos}`,
    };
    return out;
  });
}

function toVisibilityFromResponse(response: RequestResponse): TransactionVisibility {
  if (typeof response === 'string') {
    return {
      seen: response.length > 0,
      confirmed: false,
    };
  }

  if (response && typeof response === 'object') {
    const record = response as { confirmations?: unknown; height?: unknown };
    const confirmations = Number(record.confirmations ?? 0);
    const height = Number(record.height ?? 0);
    return {
      seen: true,
      confirmed: confirmations > 0 || height > 0,
    };
  }

  throw new Error('Invalid transaction visibility response');
}

// ---------- Notification Routing ----------
/**
 * Registry for active subscription callbacks.
 * Keys are RPC methods (e.g. blockchain.address.subscribe),
 * values are maps of subscription keys (address/txHash) to callbacks.
 */
const subscriptionRegistry: Record<string, Map<string, (data: unknown) => void>> = {
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
      latestBlockHeader = header;
      for (const cb of blockHeaderListeners) {
        cb(header);
      }
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
            results[address] = cacheByAddr.get(address)?.data ?? [];
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

          results[address] = cacheByAddr.get(address)?.data ?? [];
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
    const server = ElectrumServer();
    try {
      const reg = subscriptionRegistry['blockchain.address.subscribe'];
      if (!reg.has(address)) {
        await server.subscribe('blockchain.address.subscribe', [address]);
        await ensureNotificationRouter();
      }
      reg.set(address, callback);
    } catch (error) {
      logError('ElectrumService.subscribeAddress', error, { address });
    }
  },

  /** Subscribe to block headers */
  async subscribeBlockHeaders(callback: (header: unknown) => void) {
    const server = ElectrumServer();
    try {
      const reg = subscriptionRegistry['blockchain.headers.subscribe'];
      const shouldSubscribe = blockHeaderListeners.size === 0;
      blockHeaderListeners.add(callback);
      reg.set('tip', () => undefined);
      if (shouldSubscribe) {
        await server.subscribe('blockchain.headers.subscribe'); // no params
        await ensureNotificationRouter();
      }

      if (latestBlockHeader !== null) {
        callback(latestBlockHeader);
        return;
      }

      const latest = await this.getLatestBlock();
      if (latest !== null) {
        latestBlockHeader = latest;
        callback(latest);
      }
    } catch (error) {
      blockHeaderListeners.delete(callback);
      logError('ElectrumService.subscribeBlockHeaders', error);
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
      logError('ElectrumService.subscribeTransaction', error, { txHash });
    }
  },

  /** Subscribe to double-spend proofs for a transaction */
  async subscribeDoubleSpendProof(txHash: string, cb: (ds: unknown) => void) {
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
      logError('ElectrumService.subscribeDoubleSpendProof', error, { txHash });
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
      logError('ElectrumService.unsubscribeAddress', error, { address });
      return false;
    }
  },

  /** Unsubscribe from block headers */
  async unsubscribeBlockHeaders(callback?: (header: unknown) => void): Promise<boolean> {
    const server = ElectrumServer();
    try {
      if (callback) {
        blockHeaderListeners.delete(callback);
      } else {
        blockHeaderListeners.clear();
      }
      if (blockHeaderListeners.size === 0) {
        await server.unsubscribe('blockchain.headers.subscribe');
        subscriptionRegistry['blockchain.headers.subscribe'].delete('tip');
        latestBlockHeader = null;
      }
      return true;
    } catch (error) {
      logError('ElectrumService.unsubscribeBlockHeaders', error);
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
      logError('ElectrumService.unsubscribeTransaction', error, { txHash });
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
      logError('ElectrumService.unsubscribeDoubleSpendProof', error, { txHash });
      return false;
    }
  },
};

export default ElectrumService;
