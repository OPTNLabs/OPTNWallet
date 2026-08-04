import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { setWalletSpecialActivity } from '../state/slices/walletSpecialActivitySlice';
import { store } from '../state/store';
import { Network } from '../state/slices/networkSlice';
import type { UTXO } from '../types/types';
import { hexToBin } from '../utils/hex';
import getElectrumAdapter, { type ElectrumAdapter } from './ElectrumAdapter';
import {
  computeSharedSecret,
  deriveAndEncodePaycode,
  derivePaymentAddress,
  deriveRpaKeys,
  RPA_PREFIX_BITS,
} from './RpaService';
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

/**
 * Turn Electrum/network failures into short user-facing copy.
 *
 * `rpa.getaddresshistory` is **not** standard ElectrumX — only Fulcrum builds
 * with the RPA plugin answer it. Ordinary chipnet/mainnet servers reply
 * "Unsupported request: rpa.getaddresshistory", which is accurate protocol
 * text but useless in the Assets card.
 */
function normalizeActivityError(error: unknown): string {
  const message = toErrorMessage(error).trim();
  const lower = message.toLowerCase();
  if (
    lower.includes('rpa.getaddresshistory') ||
    (lower.includes('unsupported request') && lower.includes('rpa')) ||
    lower.includes('method not found') && lower.includes('rpa')
  ) {
    return (
      'This Electrum server does not support RPA scanning. ' +
      'Connect to a Fulcrum-RPA server (or turn off Experimental → RPA).'
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
    ...(error ? { error } : {}),
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
}): Promise<{
  status: WalletSpecialActivityStatus;
  payload: RpaActivityPayload;
}> {
  const { mnemonic, passphrase, network, accountPath } = params;
  const adapter = params.adapter ?? getElectrumAdapter();
  const keys = await deriveRpaKeys(mnemonic, passphrase, network, accountPath);
  const paycode = await deriveAndEncodePaycode(
    mnemonic,
    passphrase,
    network,
    RPA_PREFIX_BITS,
    accountPath
  );

  let history: RpaHistoryEntry[];
  try {
    history = (await adapter.request(
      'rpa.getaddresshistory',
      paycode
    )) as RpaHistoryEntry[];
  } catch (error) {
    return {
      status: 'unavailable',
      payload: {
        ...emptyRpaPayload(true),
        error: normalizeActivityError(error),
      },
    };
  }

  const candidates = Array.from(
    new Set(
      (Array.isArray(history) ? history : [])
        .map(
          (entry) =>
            toNonEmptyString(entry.tx_hash) ?? toNonEmptyString(entry.txid)
        )
        .filter((txid): txid is string => Boolean(txid))
    )
  );
  const matchedOutputKeys = new Set<string>();
  const unspentOutputs: RpaUnspentOutput[] = [];
  let detectedPaymentCount = 0;

  await mapWithConcurrency(candidates, 4, async (txid) => {
    try {
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
                toNonEmptyString(utxo.tx_hash) === txid &&
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
    status: 'complete',
    payload: {
      enabled: true,
      serverSupported: true,
      detectedPaymentCount,
      unspentOutputCount: unspentOutputs.length,
      unspentSats: unspentOutputs.reduce(
        (total, output) => total + output.valueSats,
        0
      ),
      unspentOutputs,
    },
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
    params.network,
    32,
    0
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
    if (!rpaEnabled) {
      status = 'unavailable';
      payload = emptyRpaPayload(
        false,
        'RPA scanning is disabled in Experimental settings.'
      );
    } else {
      try {
        ({ status, payload } = await scanRpaActivity({
          mnemonic: context.mnemonic,
          passphrase: context.passphrase,
          network: context.network,
          accountPath: context.derivationPath,
        }));
      } catch (error) {
        status = 'error';
        payload = emptyRpaPayload(true, normalizeActivityError(error));
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
