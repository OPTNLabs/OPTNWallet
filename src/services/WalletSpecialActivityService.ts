import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { setWalletSpecialActivity } from '../state/slices/walletSpecialActivitySlice';
import { store } from '../state/store';
import { Network } from '../state/slices/networkSlice';
import type { UTXO } from '../types/types';
import { hexToBin } from '../utils/hex';
import getElectrumAdapter, { type ElectrumAdapter } from './ElectrumAdapter';
import {
  computeSharedSecret,
  derivePaymentAddress,
  deriveRpaKeys,
  rpaGrindString,
  RPA_PREFIX_BITS,
} from './RpaService';
import {
  matchRpaPaymentsInRawTx,
  normalizeRpaTxid,
} from './RpaDetect';
import type {
  CauldronPool,
  CauldronWalletPoolPosition,
} from './cauldron/types';
import { getBchAccountPath, normalizeBchAccountPath } from './HdWalletService';

export type WalletSpecialActivityType = 'rpa' | 'cauldron';
export type WalletSpecialActivityStatus = 'complete' | 'unavailable' | 'error';

export type RpaUnspentOutput = {
  txHash: string;
  outputIndex: number;
  address: string;
  valueSats: number;
  height: number;
};

export type RpaActivityPayload = {
  enabled: boolean;
  serverSupported: boolean;
  detectedPaymentCount: number;
  unspentOutputCount: number;
  unspentSats: number;
  unspentOutputs: RpaUnspentOutput[];
  /** Txids already proven to be ours (Check). Sync must not drop these. */
  knownTxids?: string[];
  error?: string;
};

export type CauldronActivityPosition = {
  poolId: string;
  txHash: string;
  outputIndex: number;
  ownerAddress: string | null;
  sats: string;
  tokenCategory: string;
  tokenAmount: string;
  detectionSource: CauldronWalletPoolPosition['detectionSource'];
};

export type CauldronActivityPayload = {
  derivedAddressCount: number;
  positionCount: number;
  totalSats: string;
  tokenAmountsByCategory: Record<string, string>;
  positions: CauldronActivityPosition[];
  error?: string;
};

export type WalletSpecialActivityPayload =
  | RpaActivityPayload
  | CauldronActivityPayload;

export type WalletSpecialActivityRecord = {
  walletId: number;
  activityType: WalletSpecialActivityType;
  network: Network;
  derivationPath: string;
  status: WalletSpecialActivityStatus;
  payload: WalletSpecialActivityPayload;
  updatedAt: string;
};

type WalletSpecialActivityRow = {
  activity_type?: unknown;
  network_type?: unknown;
  derivation_path?: unknown;
  status?: unknown;
  payload_json?: unknown;
  updated_at?: unknown;
};

type RpaHistoryEntry = {
  tx_hash?: unknown;
  txid?: unknown;
};

type RpaRawInput = {
  prevout_hash?: unknown;
  prevout_n?: unknown;
  pubkeys?: unknown;
};

type RpaRawOutput = {
  address?: unknown;
  value?: unknown;
  scriptPubKey?: {
    address?: unknown;
    addresses?: unknown;
  };
};

type RpaRawTransaction = {
  inputs?: RpaRawInput[];
  outputs?: RpaRawOutput[];
};

function isActivityType(value: unknown): value is WalletSpecialActivityType {
  return value === 'rpa' || value === 'cauldron';
}

function isNetwork(value: unknown): value is Network {
  return value === Network.MAINNET || value === Network.CHIPNET;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function isRawTxHex(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    /^[0-9a-f]+$/i.test(value.trim())
  );
}

async function fetchRawTxHex(
  adapter: ElectrumAdapter,
  txid: string
): Promise<string | null> {
  const result = await adapter.request(
    'blockchain.transaction.get',
    txid,
    false
  );
  if (isRawTxHex(result)) return result.trim();
  if (result && typeof result === 'object') {
    const hex = (result as { hex?: unknown }).hex;
    if (isRawTxHex(hex)) return hex.trim();
  }
  return null;
}

function asHistoryList(value: unknown): RpaHistoryEntry[] {
  return Array.isArray(value) ? (value as RpaHistoryEntry[]) : [];
}

function rpaFeatureLimit(features: unknown): number | null {
  if (!features || typeof features !== 'object') return null;
  const rpa = (features as { rpa?: unknown }).rpa;
  if (!rpa || typeof rpa !== 'object') return null;
  const limit = toSafeNumber(
    (rpa as { history_block_limit?: unknown }).history_block_limit,
    60
  );
  return Math.max(1, Math.min(limit || 60, 200));
}

/**
 * Official Fulcrum / Selene bch-rpa: blockchain.rpa.get_history(prefix, from, to).
 * Electron Cash 4.4.6 still uses deprecated blockchain.reusable.get_history.
 */
async function fetchRpaCandidateHistory(
  adapter: ElectrumAdapter,
  grind: string,
  tip: number
): Promise<RpaHistoryEntry[]> {
  const prefix = grind.toLowerCase();
  let windowBlocks = 60;
  try {
    const features = await adapter.request('server.features');
    const limit = rpaFeatureLimit(features);
    if (limit) windowBlocks = limit;
  } catch {
    /* features is optional; try the RPCs anyway */
  }

  const fromHeight = tip > 0 ? Math.max(0, tip - windowBlocks) : 0;
  try {
    const confirmed = await adapter.request(
      'blockchain.rpa.get_history',
      prefix,
      fromHeight,
      -1
    );
    let mempool: RpaHistoryEntry[] = [];
    try {
      mempool = asHistoryList(
        await adapter.request('blockchain.rpa.get_mempool', prefix)
      );
    } catch {
      mempool = [];
    }
    return [...asHistoryList(confirmed), ...mempool];
  } catch {
    /* fall through to Electron Cash 4.4.6 reusable.* */
  }

  const count = 200;
  const startHeight = tip > 0 ? Math.max(0, tip - count) : 0;
  const confirmed = await adapter.request(
    'blockchain.reusable.get_history',
    startHeight,
    count + 1,
    grind
  );
  let mempool: RpaHistoryEntry[] = [];
  try {
    mempool = asHistoryList(
      await adapter.request('blockchain.reusable.get_mempool', grind)
    );
  } catch {
    mempool = [];
  }
  return [...asHistoryList(confirmed), ...mempool];
}

/**
 * Turn Electrum/network failures into short user-facing copy.
 *
 * Electron Cash talks to Fulcrum-RPA via `blockchain.reusable.get_history`
 * (not `rpa.getaddresshistory`). Ordinary ElectrumX replies "unsupported".
 */
function normalizeActivityError(error: unknown): string {
  const message = toErrorMessage(error).trim();
  const lower = message.toLowerCase();
  if (
    lower.includes('blockchain.reusable') ||
    lower.includes('blockchain.rpa') ||
    lower.includes('rpa.getaddresshistory') ||
    (lower.includes('unsupported request') &&
      (lower.includes('rpa') || lower.includes('reusable'))) ||
    (lower.includes('method not found') &&
      (lower.includes('rpa') || lower.includes('reusable')))
  ) {
    return (
      'This Electrum server does not have Fulcrum RPA. ' +
      'On Chipnet, switch Servers to chipnet.bch.ninja, then Sync.'
    );
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function emptyRpaPayload(enabled: boolean, error?: string): RpaActivityPayload {
  return {
    enabled,
    serverSupported: false,
    detectedPaymentCount: 0,
    unspentOutputCount: 0,
    unspentSats: 0,
    unspentOutputs: [],
    knownTxids: [],
    ...(error ? { error } : {}),
  };
}

function readStoredRpaPayload(walletId: number): RpaActivityPayload {
  const existing =
    store.getState().walletSpecialActivity?.byWallet?.[walletId]?.rpa ?? null;
  if (
    existing?.activityType === 'rpa' &&
    existing.payload &&
    'unspentOutputs' in existing.payload
  ) {
    return existing.payload as RpaActivityPayload;
  }
  return emptyRpaPayload(true);
}

function collectKnownTxids(payload: RpaActivityPayload): string[] {
  const ids = new Set<string>();
  for (const txid of payload.knownTxids ?? []) {
    const normalized = toNonEmptyString(txid)?.toLowerCase();
    if (normalized) ids.add(normalized);
  }
  for (const output of payload.unspentOutputs) {
    const normalized = toNonEmptyString(output.txHash)?.toLowerCase();
    if (normalized) ids.add(normalized);
  }
  return [...ids];
}

function withRpaTotals(
  payload: Omit<
    RpaActivityPayload,
    'unspentOutputCount' | 'unspentSats' | 'detectedPaymentCount'
  > & {
    detectedPaymentCount?: number;
  }
): RpaActivityPayload {
  return {
    ...payload,
    detectedPaymentCount: Math.max(
      payload.detectedPaymentCount ?? 0,
      payload.unspentOutputs.length,
      (payload.knownTxids ?? []).length
    ),
    unspentOutputCount: payload.unspentOutputs.length,
    unspentSats: payload.unspentOutputs.reduce(
      (total, output) => total + output.valueSats,
      0
    ),
  };
}

function emptyCauldronPayload(error?: string): CauldronActivityPayload {
  return {
    derivedAddressCount: 0,
    positionCount: 0,
    totalSats: '0',
    tokenAmountsByCategory: {},
    positions: [],
    ...(error ? { error } : {}),
  };
}

function ensureActivityTable(): void {
  const db = DatabaseService().getDatabase();
  if (!db) throw new Error('Database is not available.');
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_special_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT NOT NULL,
      activity_type TEXT NOT NULL,
      network_type TEXT NOT NULL,
      derivation_path TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      UNIQUE(wallet_id, activity_type)
    );
  `);
}

function persistActivity(record: WalletSpecialActivityRecord): void {
  ensureActivityTable();
  const db = DatabaseService().getDatabase();
  if (!db) throw new Error('Database is not available.');

  db.run(
    'DELETE FROM wallet_special_activities WHERE wallet_id = ? AND activity_type = ?',
    [record.walletId, record.activityType]
  );
  db.run(
    `INSERT INTO wallet_special_activities
      (wallet_id, activity_type, network_type, derivation_path, status, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.walletId,
      record.activityType,
      record.network,
      record.derivationPath,
      record.status,
      JSON.stringify(record.payload),
      record.updatedAt,
    ]
  );
  DatabaseService().scheduleDatabaseSave(record.walletId);
}

function rowToActivityRecord(
  walletId: number,
  row: WalletSpecialActivityRow
): WalletSpecialActivityRecord | null {
  const activityType = row.activity_type;
  const network = row.network_type;
  const status = row.status;
  if (
    !isActivityType(activityType) ||
    !isNetwork(network) ||
    (status !== 'complete' && status !== 'unavailable' && status !== 'error') ||
    typeof row.derivation_path !== 'string' ||
    typeof row.payload_json !== 'string'
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      row.payload_json
    ) as WalletSpecialActivityPayload;
    return {
      walletId,
      activityType,
      network,
      derivationPath: row.derivation_path,
      status,
      payload,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    };
  } catch {
    return null;
  }
}

export async function loadStoredWalletSpecialActivities(
  walletId: number
): Promise<WalletSpecialActivityRecord[]> {
  await DatabaseService().ensureDatabaseStarted();
  const state = store.getState() as unknown as {
    wallet_id?: { currentWalletId?: number | null };
  };
  // A route can unmount while the database is starting. Do not publish the
  // previous wallet's activity into a newly selected wallet (or after lock).
  if (
    state.wallet_id &&
    Object.prototype.hasOwnProperty.call(state.wallet_id, 'currentWalletId') &&
    state.wallet_id.currentWalletId !== walletId
  ) {
    return [];
  }
  ensureActivityTable();
  const db = DatabaseService().getDatabase();
  if (!db) return [];

  const query = db.prepare(`
    SELECT activity_type, network_type, derivation_path, status, payload_json, updated_at
    FROM wallet_special_activities
    WHERE wallet_id = ?
    ORDER BY activity_type ASC
  `);
  query.bind([walletId]);
  const records: WalletSpecialActivityRecord[] = [];
  while (query.step()) {
    const record = rowToActivityRecord(
      walletId,
      query.getAsObject() as WalletSpecialActivityRow
    );
    if (record) records.push(record);
  }
  query.free();

  for (const record of records) {
    const currentState = store.getState() as unknown as {
      wallet_id?: { currentWalletId?: number | null };
    };
    if (
      currentState.wallet_id &&
      Object.prototype.hasOwnProperty.call(
        currentState.wallet_id,
        'currentWalletId'
      ) &&
      currentState.wallet_id.currentWalletId !== walletId
    ) {
      break;
    }
    if (record.activityType === 'rpa') {
      const existing =
        store.getState().walletSpecialActivity?.byWallet?.[walletId]?.rpa ??
        null;
      const existingSats = existing
        ? Number(
            'unspentSats' in existing.payload
              ? existing.payload.unspentSats
              : 0
          ) ||
          (existing.payload &&
          'unspentOutputs' in existing.payload
            ? existing.payload.unspentOutputs.reduce(
                (sum, output) => sum + (Number(output.valueSats) || 0),
                0
              )
            : 0)
        : 0;
      const incomingSats =
        'unspentSats' in record.payload
          ? Number(record.payload.unspentSats) ||
            record.payload.unspentOutputs.reduce(
              (sum, output) => sum + (Number(output.valueSats) || 0),
              0
            )
          : 0;
      // Home reloads storage on mount. Never replace a live Check result
      // with an older empty Sync row.
      if (existingSats > incomingSats) continue;
    }
    store.dispatch(setWalletSpecialActivity({ walletId, record }));
  }
  return records;
}

export async function clearWalletSpecialActivities(
  walletId: number
): Promise<void> {
  await DatabaseService().ensureDatabaseStarted();
  const db = DatabaseService().getDatabase();
  if (!db) return;
  ensureActivityTable();
  db.run('DELETE FROM wallet_special_activities WHERE wallet_id = ?', [
    walletId,
  ]);
  DatabaseService().scheduleDatabaseSave(walletId);
}

function outputAddress(output: RpaRawOutput): string | null {
  const direct = toNonEmptyString(output.address);
  if (direct) return direct;
  const scriptAddress = toNonEmptyString(output.scriptPubKey?.address);
  if (scriptAddress) return scriptAddress;
  if (Array.isArray(output.scriptPubKey?.addresses)) {
    return toNonEmptyString(output.scriptPubKey.addresses[0]);
  }
  return null;
}

function outputValueSats(output: RpaRawOutput): number {
  return Math.max(0, Math.trunc(toSafeNumber(output.value)));
}

function inputPubkeys(input: RpaRawInput): string[] {
  if (!Array.isArray(input.pubkeys)) return [];
  return input.pubkeys.filter(
    (value): value is string => typeof value === 'string' && value.length === 66
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
      worker
    )
  );
  return results;
}

export async function scanRpaActivity(params: {
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath: string;
  adapter?: ElectrumAdapter;
  knownTxids?: string[];
}): Promise<{
  status: WalletSpecialActivityStatus;
  payload: RpaActivityPayload;
}> {
  const { mnemonic, passphrase, network, accountPath } = params;
  const adapter = params.adapter ?? getElectrumAdapter();
  const keys = await deriveRpaKeys(mnemonic, passphrase, network, accountPath);
  // Official Fulcrum / Selene: blockchain.rpa.get_history(prefix, from, to).
  // EC 4.4.6 still uses deprecated blockchain.reusable.get_history.
  const grind = rpaGrindString(keys.scanPubkey, RPA_PREFIX_BITS);
  const rememberedTxids = (params.knownTxids ?? [])
    .map((txid) => toNonEmptyString(txid)?.toLowerCase())
    .filter((txid): txid is string => Boolean(txid));

  let history: RpaHistoryEntry[] = [];
  let serverSupported = true;
  let serverError: string | undefined;
  try {
    let tip = 0;
    try {
      const header = (await adapter.request(
        'blockchain.headers.subscribe'
      )) as { height?: number };
      tip = toSafeNumber(header?.height, 0);
    } catch {
      tip = 0;
    }
    history = await fetchRpaCandidateHistory(adapter, grind, tip);
  } catch (error) {
    serverSupported = false;
    serverError = normalizeActivityError(error);
    if (rememberedTxids.length === 0) {
      return {
        status: 'unavailable',
        payload: {
          ...emptyRpaPayload(true),
          error: serverError,
        },
      };
    }
  }

  const candidates = Array.from(
    new Set([
      ...(Array.isArray(history) ? history : [])
        .map(
          (entry) =>
            (
              toNonEmptyString(entry.tx_hash) ?? toNonEmptyString(entry.txid)
            )?.toLowerCase() ?? null
        )
        .filter((txid): txid is string => Boolean(txid)),
      ...rememberedTxids,
    ])
  );
  const matchedOutputKeys = new Set<string>();
  const unspentOutputs: RpaUnspentOutput[] = [];
  let detectedPaymentCount = 0;

  await mapWithConcurrency(candidates, 4, async (txid) => {
    try {
      let rawHex: string | null = null;
      try {
        rawHex = await fetchRawTxHex(adapter, txid);
      } catch {
        rawHex = null;
      }
      if (rawHex) {
        const matched = matchRpaPaymentsInRawTx(rawHex, keys, network);
        for (const match of matched) {
          const outputKey = `${txid}:${match.outputIndex}`;
          if (matchedOutputKeys.has(outputKey)) continue;
          matchedOutputKeys.add(outputKey);
          detectedPaymentCount += 1;
          let listUnspent: unknown;
          try {
            listUnspent = await adapter.request(
              'blockchain.address.listunspent',
              match.address
            );
          } catch {
            continue;
          }
          if (!Array.isArray(listUnspent)) continue;
          const current = (
            listUnspent as Array<Record<string, unknown>>
          ).find(
            (utxo) =>
              toNonEmptyString(utxo.tx_hash)?.toLowerCase() === txid &&
              toSafeNumber(utxo.tx_pos, -1) === match.outputIndex
          );
          if (!current) continue;
          unspentOutputs.push({
            txHash: txid,
            outputIndex: match.outputIndex,
            address: match.address,
            valueSats: Math.max(
              0,
              Math.trunc(toSafeNumber(current.value, match.valueSats))
            ),
            height: Math.trunc(toSafeNumber(current.height)),
          });
        }
        if (matched.length > 0) return undefined;
      }

      const transaction = (await adapter.request(
        'blockchain.transaction.get',
        txid,
        true
      )) as RpaRawTransaction;
      const inputs = Array.isArray(transaction?.inputs)
        ? transaction.inputs
        : [];
      const outputs = Array.isArray(transaction?.outputs)
        ? transaction.outputs
        : [];

      for (const input of inputs) {
        const prevoutHash = toNonEmptyString(input.prevout_hash);
        const prevoutIndex = toSafeNumber(input.prevout_n, -1);
        if (!prevoutHash || prevoutIndex < 0) continue;

        for (const pubkeyHex of inputPubkeys(input)) {
          const senderPubkey = hexToBin(pubkeyHex);
          if (typeof senderPubkey === 'string') continue;
          let sharedSecret: Uint8Array;
          try {
            sharedSecret = computeSharedSecret(
              keys.scanPrivkey,
              senderPubkey,
              prevoutHash,
              prevoutIndex
            );
          } catch {
            continue;
          }
          const expectedAddress = derivePaymentAddress(
            keys.spendPubkey,
            sharedSecret,
            network,
            0
          );

          for (
            let outputIndex = 0;
            outputIndex < outputs.length;
            outputIndex += 1
          ) {
            const output = outputs[outputIndex];
            if (outputAddress(output) !== expectedAddress) continue;
            const outputKey = `${txid}:${outputIndex}`;
            if (matchedOutputKeys.has(outputKey)) continue;
            matchedOutputKeys.add(outputKey);
            detectedPaymentCount += 1;

            let listUnspent: unknown;
            try {
              listUnspent = await adapter.request(
                'blockchain.address.listunspent',
                expectedAddress
              );
            } catch {
              continue;
            }
            if (!Array.isArray(listUnspent)) continue;
            const current = (
              listUnspent as Array<Record<string, unknown>>
            ).find(
              (utxo) =>
                toNonEmptyString(utxo.tx_hash)?.toLowerCase() === txid &&
                toSafeNumber(utxo.tx_pos, -1) === outputIndex
            );
            if (!current) continue;

            unspentOutputs.push({
              txHash: txid,
              outputIndex,
              address: expectedAddress,
              valueSats: Math.max(
                0,
                Math.trunc(toSafeNumber(current.value, outputValueSats(output)))
              ),
              height: Math.trunc(toSafeNumber(current.height)),
            });
          }
        }
      }
    } catch {
      // A malformed or unavailable candidate must not prevent other candidates
      // from producing a current unspent snapshot.
    }
    return undefined;
  });

  return {
    status: serverSupported || unspentOutputs.length > 0 ? 'complete' : 'unavailable',
    payload: withRpaTotals({
      enabled: true,
      serverSupported,
      detectedPaymentCount,
      unspentOutputs,
      knownTxids: Array.from(
        new Set([
          ...rememberedTxids,
          ...unspentOutputs.map((output) => output.txHash.toLowerCase()),
        ])
      ),
      ...(serverError ? { error: serverError } : {}),
    }),
  };
}

function poolId(pool: CauldronPool): string {
  return pool.poolId?.trim() || `${pool.txHash}:${pool.outputIndex}`;
}

function positionToActivity(
  position: CauldronWalletPoolPosition
): CauldronActivityPosition {
  return {
    poolId: poolId(position.pool),
    txHash: position.pool.txHash,
    outputIndex: position.pool.outputIndex,
    ownerAddress: position.ownerAddress,
    sats: position.pool.output.amountSatoshis.toString(),
    tokenCategory: position.pool.output.tokenCategory,
    tokenAmount: position.pool.output.tokenAmount.toString(),
    detectionSource: position.detectionSource,
  };
}

export async function scanCauldronActivity(params: {
  walletId: number;
  network: Network;
  baseUtxos?: UTXO[];
}): Promise<{
  status: WalletSpecialActivityStatus;
  payload: CauldronActivityPayload;
}> {
  const {
    detectCauldronWalletPoolPositions,
    fetchCauldronDerivedWalletAddresses,
    fetchNormalizedCauldronUserPools,
  } = await import('./cauldron/planner');
  const walletAddresses = await fetchCauldronDerivedWalletAddresses(
    params.walletId,
    params.network
  );
  const userPools = await fetchNormalizedCauldronUserPools(
    params.network,
    walletAddresses
  );
  const tokenUtxos = (params.baseUtxos ?? []).filter((utxo) =>
    Boolean(utxo.token)
  );
  const detectedPositions = detectCauldronWalletPoolPositions(
    userPools,
    tokenUtxos
  );
  const byPoolId = new Map<string, CauldronWalletPoolPosition>();

  for (const pool of userPools) {
    byPoolId.set(poolId(pool), {
      pool,
      ownerAddress: pool.ownerAddress ?? null,
      matchingNftUtxos: [],
      hasMatchingTokenNft: false,
      detectionSource: 'owner_pkh',
    });
  }
  for (const position of detectedPositions) {
    byPoolId.set(poolId(position.pool), position);
  }

  const positions = [...byPoolId.values()].map(positionToActivity);
  let totalSats = 0n;
  const tokenAmountsByCategory: Record<string, bigint> = {};
  for (const position of positions) {
    totalSats += BigInt(position.sats);
    tokenAmountsByCategory[position.tokenCategory] =
      (tokenAmountsByCategory[position.tokenCategory] ?? 0n) +
      BigInt(position.tokenAmount);
  }

  return {
    status: 'complete',
    payload: {
      derivedAddressCount: walletAddresses.length,
      positionCount: positions.length,
      totalSats: totalSats.toString(),
      tokenAmountsByCategory: Object.fromEntries(
        Object.entries(tokenAmountsByCategory).map(([category, amount]) => [
          category,
          amount.toString(),
        ])
      ),
      positions,
    },
  };
}

async function getWalletContext(walletId: number) {
  const { default: WalletManager } = await import(
    '../apis/WalletManager/WalletManager'
  );
  const walletInfo = await WalletManager().getWalletInfo(walletId);
  if (!walletInfo?.mnemonic) throw new Error('Wallet is not unlocked.');
  const network = isNetwork(walletInfo.networkType)
    ? walletInfo.networkType
    : Network.MAINNET;
  const derivationPath = normalizeBchAccountPath(
    walletInfo.derivation_path || getBchAccountPath(network)
  );
  return {
    mnemonic: walletInfo.mnemonic,
    passphrase: walletInfo.passphrase ?? '',
    network,
    derivationPath,
  };
}

export async function syncWalletSpecialActivities(params: {
  walletId: number;
  baseUtxos?: UTXO[];
  activityTypes?: WalletSpecialActivityType[];
  isCurrent?: () => boolean;
}): Promise<WalletSpecialActivityRecord[]> {
  const isCurrent = params.isCurrent ?? (() => true);
  if (!isCurrent()) return [];

  const context = await getWalletContext(params.walletId);
  if (!isCurrent()) return [];
  const requestedTypes = new Set(
    params.activityTypes ?? (['rpa', 'cauldron'] as WalletSpecialActivityType[])
  );
  const rpaEnabled = store.getState().experimental.rpaEnabled === true;
  const records: WalletSpecialActivityRecord[] = [];

  if (requestedTypes.has('rpa')) {
    if (!isCurrent()) return records;
    let status: WalletSpecialActivityStatus;
    let payload: RpaActivityPayload;
    const previous = readStoredRpaPayload(params.walletId);
    if (!rpaEnabled) {
      status = 'unavailable';
      payload = withRpaTotals({
        ...previous,
        enabled: false,
        serverSupported: false,
        error: 'RPA scanning is disabled in Experimental settings.',
      });
    } else {
      try {
        ({ status, payload } = await scanRpaActivity({
          mnemonic: context.mnemonic,
          passphrase: context.passphrase,
          network: context.network,
          accountPath: context.derivationPath,
          knownTxids: collectKnownTxids(previous),
        }));
        if (!payload.serverSupported && previous.unspentOutputs.length > 0) {
          payload = withRpaTotals({
            ...payload,
            unspentOutputs: mergeRpaOutputs(
              previous.unspentOutputs,
              payload.unspentOutputs
            ),
            knownTxids: collectKnownTxids({
              ...previous,
              ...payload,
              unspentOutputs: mergeRpaOutputs(
                previous.unspentOutputs,
                payload.unspentOutputs
              ),
            }),
          });
          status = 'complete';
        }
      } catch (error) {
        status = previous.unspentOutputs.length > 0 ? 'complete' : 'error';
        payload = withRpaTotals({
          ...previous,
          enabled: true,
          serverSupported: false,
          error: normalizeActivityError(error),
        });
      }
    }
    const record: WalletSpecialActivityRecord = {
      walletId: params.walletId,
      activityType: 'rpa',
      network: context.network,
      derivationPath: context.derivationPath,
      status,
      payload,
      updatedAt: new Date().toISOString(),
    };
    if (!isCurrent()) return records;
    persistActivity(record);
    store.dispatch(
      setWalletSpecialActivity({ walletId: params.walletId, record })
    );
    records.push(record);
  }

  if (requestedTypes.has('cauldron')) {
    if (!isCurrent()) return records;
    let status: WalletSpecialActivityStatus;
    let payload: CauldronActivityPayload;
    try {
      ({ status, payload } = await scanCauldronActivity({
        walletId: params.walletId,
        network: context.network,
        baseUtxos: params.baseUtxos,
      }));
    } catch (error) {
      status = 'error';
      payload = emptyCauldronPayload(normalizeActivityError(error));
    }
    const record: WalletSpecialActivityRecord = {
      walletId: params.walletId,
      activityType: 'cauldron',
      network: context.network,
      derivationPath: context.derivationPath,
      status,
      payload,
      updatedAt: new Date().toISOString(),
    };
    if (!isCurrent()) return records;
    persistActivity(record);
    store.dispatch(
      setWalletSpecialActivity({ walletId: params.walletId, record })
    );
    records.push(record);
  }

  return records;
}

function mergeRpaOutputs(
  existing: RpaUnspentOutput[],
  incoming: RpaUnspentOutput[]
): RpaUnspentOutput[] {
  const byKey = new Map<string, RpaUnspentOutput>();
  for (const output of [...existing, ...incoming]) {
    byKey.set(`${output.txHash}:${output.outputIndex}`, output);
  }
  return [...byKey.values()];
}

/**
 * Check one transaction the user already knows about. Ordinary Electrum can
 * fetch the hex; we verify locally with the scan key. Does not query
 * blockchain.reusable.* and does not send the grind prefix to the server.
 */
export async function claimRpaTransaction(params: {
  walletId: number;
  txid: string;
  adapter?: ElectrumAdapter;
}): Promise<WalletSpecialActivityRecord> {
  const txid = normalizeRpaTxid(params.txid);
  if (!txid) {
    throw new Error('That does not look like a transaction id.');
  }

  const context = await getWalletContext(params.walletId);
  const keys = await deriveRpaKeys(
    context.mnemonic,
    context.passphrase,
    context.network,
    context.derivationPath
  );
  const adapter = params.adapter ?? getElectrumAdapter();

  let rawHex: string | null;
  try {
    rawHex = await fetchRawTxHex(adapter, txid);
  } catch (error) {
    throw new Error(normalizeActivityError(error));
  }
  if (!rawHex) {
    throw new Error(
      'Could not download that transaction from the Electrum server.'
    );
  }

  const matched = matchRpaPaymentsInRawTx(rawHex, keys, context.network);
  if (matched.length === 0) {
    throw new Error(
      'This transaction is not a reusable-address payment to this wallet.'
    );
  }

  const incoming: RpaUnspentOutput[] = [];
  for (const match of matched) {
    let height = 0;
    let valueSats = match.valueSats;
    let listed = false;
    try {
      const listUnspent = await adapter.request(
        'blockchain.address.listunspent',
        match.address
      );
      if (Array.isArray(listUnspent)) {
        const current = (listUnspent as Array<Record<string, unknown>>).find(
          (utxo) =>
            toNonEmptyString(utxo.tx_hash)?.toLowerCase() === txid &&
            toSafeNumber(utxo.tx_pos, -1) === match.outputIndex
        );
        if (current) {
          listed = true;
          valueSats = Math.max(
            0,
            Math.trunc(toSafeNumber(current.value, match.valueSats))
          );
          height = Math.trunc(toSafeNumber(current.height));
        }
      }
    } catch {
      listed = false;
    }
    incoming.push({
      txHash: txid,
      outputIndex: match.outputIndex,
      address: match.address,
      valueSats,
      height: listed ? height : 0,
    });
  }

  const existingPayload = readStoredRpaPayload(params.walletId);
  const unspentOutputs = mergeRpaOutputs(
    existingPayload.unspentOutputs,
    incoming
  );
  const payload = withRpaTotals({
    enabled: true,
    serverSupported: existingPayload.serverSupported,
    unspentOutputs,
    knownTxids: collectKnownTxids({
      ...existingPayload,
      unspentOutputs,
      knownTxids: [...(existingPayload.knownTxids ?? []), txid],
    }),
    ...(existingPayload.serverSupported
      ? {}
      : existingPayload.error
        ? { error: existingPayload.error }
        : {}),
  });

  const record: WalletSpecialActivityRecord = {
    walletId: params.walletId,
    activityType: 'rpa',
    network: context.network,
    derivationPath: context.derivationPath,
    status: 'complete',
    payload,
    updatedAt: new Date().toISOString(),
  };
  persistActivity(record);
  store.dispatch(
    setWalletSpecialActivity({ walletId: params.walletId, record })
  );
  return record;
}
