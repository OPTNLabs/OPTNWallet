// Option A hybrid ledger — durable chain state for one wallet.
//
// Truth: ledger_transactions + ledger_txo + ledger_txi + address_sync_status.
// UTXOs SQL table is a cache rebuilt from unspent ledger_txo.
// See docs/wallet-ledger-sync-design.md.

import {
  cashAddressToLockingBytecode,
  decodeTransaction,
  lockingBytecodeToCashAddress,
  sha256,
} from '@bitauth/libauth';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../../apis/UTXOManager/UTXOManager';
import type { TransactionHistoryItem, UTXO } from '../../types/types';
import { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import { logError } from '../../utils/errorHandling';
import { binToHex, hexToBin } from '../../utils/hex';
import { ensureDesktopLedgerTables } from './desktopSchema';

function hexFromHash(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function nowIso(): string {
  return new Date().toISOString();
}

function currentAddressPrefix(): 'bitcoincash' | 'bchtest' {
  try {
    return store.getState().network.currentNetwork === Network.CHIPNET
      ? 'bchtest'
      : 'bitcoincash';
  } catch {
    return 'bitcoincash';
  }
}

/** libauth stores outpoint txids internal-byte-order; Electrum uses RPC order. */
function outpointTxidHex(hash: Uint8Array): string {
  return binToHex(Uint8Array.from(hash).reverse());
}

function addressFromLockingBytecode(bytecode: Uint8Array): string | null {
  try {
    const result = lockingBytecodeToCashAddress({
      bytecode,
      prefix: currentAddressPrefix(),
    });
    return typeof result === 'string' ? result : result.address;
  } catch {
    return null;
  }
}

function tokenJsonFromDecodedOutput(output: {
  token?: {
    amount: bigint;
    category: Uint8Array;
    nft?: { capability: string; commitment: Uint8Array };
  };
}): string | null {
  if (!output.token) return null;
  const token: Record<string, unknown> = {
    amount: output.token.amount.toString(),
    category: binToHex(output.token.category),
  };
  if (output.token.nft) {
    token.nft = {
      capability: output.token.nft.capability,
      commitment: binToHex(output.token.nft.commitment),
    };
  }
  return JSON.stringify(token);
}

function buildWalletBytecodeMap(addresses: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const address of addresses) {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') continue;
    map.set(binToHex(decoded.bytecode), address);
  }
  return map;
}

/**
 * Stored when an address has been scanned and has zero history.
 * Electrum unused scripthash status is `null`; we persist this so the
 * status-hash gate can mark empty addresses clean (not forever dirty).
 */
export const EMPTY_HISTORY_STATUS = '';

/** EC / Selene style: sha256 of "txid:height:" for each history item. */
export function computeHistoryStatusHash(
  history: Array<{ tx_hash: string; height: number }>
): string {
  if (!history.length) return EMPTY_HISTORY_STATUS;
  let status = '';
  for (const item of history) {
    const h = Number(item.height) || 0;
    status += `${item.tx_hash}:${h}:`;
  }
  const digest = sha256.hash(new TextEncoder().encode(status));
  return hexFromHash(digest);
}

/** Local status matches Electrum scripthash status (null = unused). */
export function historyStatusesMatch(
  local: string,
  remote: string | null
): boolean {
  if (local === remote) return true;
  if (
    local === EMPTY_HISTORY_STATUS &&
    (remote === null || remote === '')
  ) {
    return true;
  }
  return false;
}

export type AddressUtxoSnapshot = {
  address: string;
  utxos: Array<{
    tx_hash: string;
    tx_pos: number;
    value: number;
    height?: number;
    token?: unknown;
    prefix?: string;
    tokenAddress?: string;
  }>;
};

export type ApplyAddressUtxoSnapshotOptions = {
  /**
   * When true (Manual Sync / force only): local unspents missing from remote
   * are marked spent via synthetic `external:` txi.
   *
   * When false (open / background / subscription): only upsert remote coins
   * and clear sticky external: when a coin reappears. Never invent spends.
   * Partial or empty listunspent on non-force was the wallet-5 re-corrupt path
   * (good Manual Sync → minutes later fake low).
   */
  allowMarkSyntheticSpends?: boolean;
};

/**
 * Apply a listunspent snapshot for one address into the ledger.
 *
 * Always:
 * - Registers each remote unspent as ledger_txo
 * - Clears synthetic `external:` txi when remote shows the outpoint again
 *
 * Only when `allowMarkSyntheticSpends` (force/Manual Sync):
 * - Marks local unspents missing from remote as `external:` spent
 *
 * Background must not mark spends: Electrum can return a partial set; EC
 * records spends from raw txs, not from incomplete listunspent diffs.
 */
export async function applyAddressUtxoSnapshot(
  walletId: number,
  snapshot: AddressUtxoSnapshot,
  options: ApplyAddressUtxoSnapshotOptions = {}
): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;

  const { address, utxos } = snapshot;
  const allowMarkSyntheticSpends = options.allowMarkSyntheticSpends === true;
  const remoteKeys = new Set(
    utxos.map((u) => `${u.tx_hash}:${u.tx_pos}`)
  );

  try {
    db.exec('BEGIN');

    // Existing unspent for this address (txo not in txi)
    const existing = db.prepare(`
      SELECT t.tx_hash, t.tx_pos, t.value
      FROM ledger_txo t
      LEFT JOIN ledger_txi i
        ON i.wallet_id = t.wallet_id
        AND i.prevout_hash = t.tx_hash
        AND i.prevout_n = t.tx_pos
      WHERE t.wallet_id = ? AND t.address = ? AND i.prevout_hash IS NULL
    `);
    existing.bind([walletId, address]);
    const toSpend: Array<{ tx_hash: string; tx_pos: number; value: number }> =
      [];
    while (existing.step()) {
      const row = existing.getAsObject() as Record<string, unknown>;
      const key = `${row.tx_hash}:${row.tx_pos}`;
      if (!remoteKeys.has(key)) {
        toSpend.push({
          tx_hash: String(row.tx_hash),
          tx_pos: Number(row.tx_pos),
          value: Number(row.value) || 0,
        });
      }
    }
    existing.free();

    const insertTxo = db.prepare(`
      INSERT INTO ledger_txo (wallet_id, tx_hash, tx_pos, address, value, height, token, prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id, tx_hash, tx_pos) DO UPDATE SET
        address = excluded.address,
        value = excluded.value,
        height = excluded.height,
        token = excluded.token,
        prefix = excluded.prefix
    `);
    for (const u of utxos) {
      insertTxo.run([
        walletId,
        u.tx_hash,
        u.tx_pos,
        address,
        u.value,
        u.height ?? 0,
        u.token ? JSON.stringify(u.token) : null,
        u.prefix ?? null,
      ]);
    }
    insertTxo.free();

    // Network says these outpoints are unspent again — drop synthetic external
    // spends only (never delete real spend txi from wallet-known txs).
    const clearExternalSpend = db.prepare(`
      DELETE FROM ledger_txi
      WHERE wallet_id = ?
        AND prevout_hash = ?
        AND prevout_n = ?
        AND spent_by_tx LIKE 'external:%'
    `);
    for (const u of utxos) {
      clearExternalSpend.run([walletId, u.tx_hash, u.tx_pos]);
    }
    clearExternalSpend.free();

    // Synthetic spends: Manual Sync / force only. Background partial listunspent
    // was marking real coins external: → fake low after a good Manual Sync.
    if (allowMarkSyntheticSpends && toSpend.length > 0) {
      const insertTxi = db.prepare(`
        INSERT OR IGNORE INTO ledger_txi
          (wallet_id, spent_by_tx, prevout_hash, prevout_n, address, value)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const spent of toSpend) {
        insertTxi.run([
          walletId,
          `external:${spent.tx_hash}:${spent.tx_pos}`,
          spent.tx_hash,
          spent.tx_pos,
          address,
          spent.value,
        ]);
      }
      insertTxi.free();
    } else if (toSpend.length > 0 && !allowMarkSyntheticSpends) {
      console.info(
        '[WalletLedger] skip synthetic external spends (non-force)',
        {
          walletId,
          address,
          missingFromRemote: toSpend.length,
          remoteCount: utxos.length,
        }
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    logError('WalletLedgerService.applyAddressUtxoSnapshot', error, {
      walletId,
      address,
    });
  }
}

export async function setAddressHistoryStatus(
  walletId: number,
  address: string,
  history: Array<{ tx_hash: string; height: number }>
): Promise<string> {
  await ensureDesktopLedgerTables();
  const status = computeHistoryStatusHash(history);
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return status;

  try {
    // Persist including EMPTY_HISTORY_STATUS so gap addresses become clean.
    db.run(
      `INSERT INTO address_sync_status (wallet_id, address, history_status, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet_id, address) DO UPDATE SET
         history_status = excluded.history_status,
         updated_at = excluded.updated_at`,
      [walletId, address, status, nowIso()]
    );
  } catch (error) {
    logError('WalletLedgerService.setAddressHistoryStatus', error, {
      walletId,
      address,
    });
  }
  return status;
}

export async function getAddressHistoryStatus(
  walletId: number,
  address: string
): Promise<string | null> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  try {
    const q = db.prepare(
      `SELECT history_status FROM address_sync_status
       WHERE wallet_id = ? AND address = ?`
    );
    q.bind([walletId, address]);
    let status: string | null = null;
    if (q.step()) {
      const row = q.getAsObject() as { history_status?: string };
      status = row.history_status ?? null;
    }
    q.free();
    return status;
  } catch {
    return null;
  }
}

/** True if local status matches remote Electrum address state (no history re-fetch needed). */
export async function addressHistoryIsFresh(
  walletId: number,
  address: string,
  remoteStatus: string | null | undefined
): Promise<boolean> {
  const local = await getAddressHistoryStatus(walletId, address);
  if (local == null) return false;
  // remoteStatus undefined = probe missing; null/'' = Electrum unused.
  if (remoteStatus === undefined) return false;
  return historyStatusesMatch(local, remoteStatus);
}

/** Bulk-load local history status hashes for a wallet (one SQL query). */
export async function getAddressHistoryStatusMap(
  walletId: number
): Promise<Map<string, string>> {
  await ensureDesktopLedgerTables();
  const map = new Map<string, string>();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return map;
  try {
    // Include empty-string statuses (scanned-empty addresses).
    const q = db.prepare(
      `SELECT address, history_status FROM address_sync_status
       WHERE wallet_id = ? AND history_status IS NOT NULL`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as {
        address?: string;
        history_status?: string | null;
      };
      if (
        typeof row.address === 'string' &&
        typeof row.history_status === 'string'
      ) {
        map.set(row.address, row.history_status);
      }
    }
    q.free();
  } catch (error) {
    logError('WalletLedgerService.getAddressHistoryStatusMap', error, {
      walletId,
    });
  }
  return map;
}

export type StatusPartition = {
  /** Must re-fetch history / listunspent from the network. */
  dirty: string[];
  /** Local status matched remote — safe to skip network for this address. */
  clean: string[];
  /** How many remote status probes were issued (0 when nothing was stored). */
  probed: number;
};

/**
 * Partition addresses into dirty/clean using EC/Selene status hashes.
 *
 * Critical performance rule: addresses with **no local status** are dirty
 * immediately — do NOT call Electrum for them. Manual Sync clears statuses
 * first; without this rule the bar freezes at ~20% while we subscribe every
 * address only to learn we already knew they were dirty.
 */
export async function partitionAddressesByStatus(
  walletId: number,
  addresses: string[]
): Promise<StatusPartition> {
  const unique = Array.from(new Set(addresses.filter(Boolean)));
  if (unique.length === 0) {
    return { dirty: [], clean: [], probed: 0 };
  }

  const localMap = await getAddressHistoryStatusMap(walletId);
  const dirty: string[] = [];
  const maybeClean: string[] = [];

  for (const address of unique) {
    if (localMap.has(address)) {
      maybeClean.push(address);
    } else {
      dirty.push(address);
    }
  }

  // Nothing stored yet (first open, post-rebuild, post-manual-clear): all dirty,
  // zero network probes — go straight to listunspent / history.
  if (maybeClean.length === 0) {
    return { dirty, clean: [], probed: 0 };
  }

  let remoteByAddress: Record<string, string | null> = {};
  try {
    const Electrum = (await import('../../services/ElectrumService')).default;
    remoteByAddress = await Electrum.getAddressStateMany(maybeClean);
  } catch (error) {
    logError('WalletLedgerService.partitionAddressesByStatus', error, {
      walletId,
      count: maybeClean.length,
    });
    // Soft-fail (Option A): keep addresses that already have a local status as
    // clean. Marking ALL dirty after "Connection lost" storms listunspent into
    // Electrum reconnect backoff and flashes fake/failed balance. Never-scanned
    // addresses (in `dirty` already) still re-fetch when the socket recovers.
    return { dirty, clean: maybeClean, probed: 0 };
  }

  const clean: string[] = [];
  for (const address of maybeClean) {
    const local = localMap.get(address);
    // Missing key = per-address probe failure (or whole-batch drop). Soft-fail:
    // trust local status rather than dirtying 300+ addresses into a dead socket.
    if (local == null || !(address in remoteByAddress)) {
      if (local != null) clean.push(address);
      else dirty.push(address);
      continue;
    }
    if (historyStatusesMatch(local, remoteByAddress[address])) {
      clean.push(address);
    } else {
      dirty.push(address);
    }
  }

  return { dirty, clean, probed: maybeClean.length };
}

export async function clearAddressStatuses(walletId: number): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;
  try {
    db.run(`DELETE FROM address_sync_status WHERE wallet_id = ?`, [walletId]);
  } catch (error) {
    logError('WalletLedgerService.clearAddressStatuses', error, { walletId });
  }
}

/**
 * Drop synthetic external spends for a wallet so the next listunspent pass can
 * repopulate unspents cleanly. Used by Manual Sync to heal ledgers that marked
 * coins spent after a bad empty snapshot (wallet 5-style fake low balance).
 * Does NOT delete real spend rows from known wallet transactions.
 */
export async function clearSyntheticExternalSpends(
  walletId: number
): Promise<number> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return 0;
  try {
    db.run(
      `DELETE FROM ledger_txi
       WHERE wallet_id = ? AND spent_by_tx LIKE 'external:%'`,
      [walletId]
    );
    // sql.js rowsModified is not always available — return 1 if we ran OK.
    return 1;
  } catch (error) {
    logError('WalletLedgerService.clearSyntheticExternalSpends', error, {
      walletId,
    });
    return 0;
  }
}

/**
 * Electron Cash style: unspent coins = ledger_txo whose outpoint is not in
 * ledger_txi (same idea as get_addr_utxo / get_addr_balance from txi+txo).
 * This is the balance source of truth — not a parallel listunspent Redux boss.
 */
export async function listUnspentFromLedger(
  walletId: number
): Promise<{ byAddress: Record<string, UTXO[]>; totalSats: number; count: number }> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  const byAddress: Record<string, UTXO[]> = {};
  let totalSats = 0;
  let count = 0;
  if (!db) return { byAddress, totalSats, count };

  try {
    const q = db.prepare(`
      SELECT t.tx_hash, t.tx_pos, t.address, t.value, t.height, t.token, t.prefix
      FROM ledger_txo t
      LEFT JOIN ledger_txi i
        ON i.wallet_id = t.wallet_id
        AND i.prevout_hash = t.tx_hash
        AND i.prevout_n = t.tx_pos
      WHERE t.wallet_id = ? AND i.prevout_hash IS NULL
    `);
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as Record<string, unknown>;
      let token: UTXO['token'] = undefined;
      if (typeof row.token === 'string' && row.token) {
        try {
          token = JSON.parse(row.token) as UTXO['token'];
        } catch {
          token = undefined;
        }
      }
      const value = Number(row.value) || 0;
      const address = String(row.address);
      const utxo: UTXO = {
        wallet_id: walletId,
        address,
        height: Number(row.height) || 0,
        tx_hash: String(row.tx_hash),
        tx_pos: Number(row.tx_pos),
        value,
        amount: value,
        prefix: typeof row.prefix === 'string' ? row.prefix : undefined,
        token,
      };
      if (!byAddress[address]) byAddress[address] = [];
      byAddress[address].push(utxo);
      totalSats += value;
      count += 1;
    }
    q.free();
  } catch (error) {
    logError('WalletLedgerService.listUnspentFromLedger', error, { walletId });
  }
  return { byAddress, totalSats, count };
}

/**
 * Rebuild the SQL UTXOs cache from ledger unspents (EC: ledger wins).
 * Returns coin count written.
 */
export async function rebuildUtxosFromLedger(walletId: number): Promise<number> {
  const { byAddress, count } = await listUnspentFromLedger(walletId);
  const utxos = Object.values(byAddress).flat();

  try {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const d = dbService.getDatabase();
    if (d) {
      d.run(`DELETE FROM UTXOs WHERE wallet_id = ?`, [walletId]);
    }
    if (utxos.length > 0) {
      const mgr = UTXOManager();
      await mgr.storeUTXOs(utxos);
    }
  } catch (error) {
    logError('WalletLedgerService.rebuildUtxosFromLedger.write', error, {
      walletId,
    });
  }
  return count;
}

/**
 * Nuclear rebuild: wipe chain data for this wallet, keep keys/seed.
 * Caller must re-run bootstrap + history after.
 */
export async function clearWalletChainData(walletId: number): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database not started');

  const tables = [
    'address_sync_status',
    'ledger_transactions',
    'ledger_txo',
    'ledger_txi',
    'wallet_ledger_meta',
    'UTXOs',
    'transactions',
    'transaction_details',
  ];

  try {
    db.exec('BEGIN');
    for (const table of tables) {
      try {
        db.run(`DELETE FROM ${table} WHERE wallet_id = ?`, [walletId]);
      } catch {
        // table may not exist on older DBs
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    logError('WalletLedgerService.clearWalletChainData', error, { walletId });
    throw error;
  }

  // Clear in-memory Electrum caches for a true from-scratch network rebuild
  try {
    const { invalidateUTXOCache } = await import('../../services/ElectrumService');
    invalidateUTXOCache();
  } catch {
    /* optional */
  }
}

/** Store raw tx hex when known. */
export async function storeLedgerTransaction(
  walletId: number,
  txHash: string,
  height: number,
  rawHex?: string | null
): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;
  try {
    db.run(
      `INSERT INTO ledger_transactions (wallet_id, tx_hash, height, raw_hex, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
         height = excluded.height,
         raw_hex = COALESCE(excluded.raw_hex, ledger_transactions.raw_hex),
         updated_at = excluded.updated_at`,
      [walletId, txHash, height, rawHex ?? null, nowIso()]
    );
  } catch (error) {
    logError('WalletLedgerService.storeLedgerTransaction', error, {
      walletId,
      txHash,
    });
  }
}

export async function getLedgerTransactionRawHex(
  walletId: number,
  txHash: string
): Promise<string | null> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  try {
    const q = db.prepare(
      `SELECT raw_hex FROM ledger_transactions
       WHERE wallet_id = ? AND tx_hash = ?`
    );
    q.bind([walletId, txHash]);
    let raw: string | null = null;
    if (q.step()) {
      const row = q.getAsObject() as { raw_hex?: string | null };
      raw =
        typeof row.raw_hex === 'string' && row.raw_hex.length > 0
          ? row.raw_hex
          : null;
    }
    q.free();
    return raw;
  } catch {
    return null;
  }
}

/** Txids that still lack raw hex (candidates for full txi/txo apply). */
export async function listTxidsMissingRawHex(
  walletId: number,
  limit = 200
): Promise<Array<{ tx_hash: string; height: number }>> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return [];
  const out: Array<{ tx_hash: string; height: number }> = [];
  try {
    const q = db.prepare(
      `SELECT tx_hash, height FROM ledger_transactions
       WHERE wallet_id = ?
         AND (raw_hex IS NULL OR raw_hex = '')
       ORDER BY ABS(height) DESC
       LIMIT ?`
    );
    q.bind([walletId, limit]);
    while (q.step()) {
      const row = q.getAsObject() as { tx_hash?: string; height?: number };
      if (typeof row.tx_hash === 'string' && row.tx_hash) {
        out.push({
          tx_hash: row.tx_hash,
          height: Number(row.height) || 0,
        });
      }
    }
    q.free();
  } catch (error) {
    logError('WalletLedgerService.listTxidsMissingRawHex', error, { walletId });
  }
  return out;
}

export type ApplyTransactionResult = {
  applied: boolean;
  inputsRecorded: number;
  outputsRecorded: number;
  error?: string;
};

/**
 * Decode full raw hex into ledger_txi (wallet spends) + ledger_txo (wallet receives).
 * Owns only outputs matching walletAddresses (bytecode map) and inputs that
 * spend an existing ledger_txo (or any prevout when markAllInputs is set).
 */
export async function applyRawTransaction(
  walletId: number,
  txHash: string,
  height: number,
  rawHex: string,
  walletAddresses: ReadonlySet<string> | string[]
): Promise<ApplyTransactionResult> {
  await ensureDesktopLedgerTables();
  if (!rawHex || !txHash) {
    return { applied: false, inputsRecorded: 0, outputsRecorded: 0, error: 'missing' };
  }

  const decoded = decodeTransaction(hexToBin(rawHex));
  if (typeof decoded === 'string') {
    return {
      applied: false,
      inputsRecorded: 0,
      outputsRecorded: 0,
      error: decoded,
    };
  }

  const addressSet =
    walletAddresses instanceof Set
      ? walletAddresses
      : new Set(walletAddresses);
  const bytecodeMap = buildWalletBytecodeMap(addressSet);

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) {
    return { applied: false, inputsRecorded: 0, outputsRecorded: 0, error: 'no-db' };
  }

  let inputsRecorded = 0;
  let outputsRecorded = 0;

  try {
    db.exec('BEGIN');

    db.run(
      `INSERT INTO ledger_transactions (wallet_id, tx_hash, height, raw_hex, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
         height = excluded.height,
         raw_hex = COALESCE(excluded.raw_hex, ledger_transactions.raw_hex),
         updated_at = excluded.updated_at`,
      [walletId, txHash, height, rawHex, nowIso()]
    );

    // Known unspent ledger coins (for spend detection)
    const knownTxo = new Map<string, { address: string; value: number }>();
    const knownQ = db.prepare(
      `SELECT tx_hash, tx_pos, address, value FROM ledger_txo WHERE wallet_id = ?`
    );
    knownQ.bind([walletId]);
    while (knownQ.step()) {
      const row = knownQ.getAsObject() as Record<string, unknown>;
      knownTxo.set(`${row.tx_hash}:${row.tx_pos}`, {
        address: String(row.address),
        value: Number(row.value) || 0,
      });
    }
    knownQ.free();

    const insertTxi = db.prepare(`
      INSERT INTO ledger_txi
        (wallet_id, spent_by_tx, prevout_hash, prevout_n, address, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id, prevout_hash, prevout_n) DO UPDATE SET
        spent_by_tx = CASE
          WHEN ledger_txi.spent_by_tx LIKE 'external:%' THEN excluded.spent_by_tx
          ELSE excluded.spent_by_tx
        END,
        address = COALESCE(excluded.address, ledger_txi.address),
        value = COALESCE(excluded.value, ledger_txi.value)
    `);

    for (const input of decoded.inputs) {
      const prevHash = outpointTxidHex(
        input.outpointTransactionHash instanceof Uint8Array
          ? input.outpointTransactionHash
          : new Uint8Array(input.outpointTransactionHash as ArrayLike<number>)
      );
      const prevN = Number(input.outpointIndex) || 0;
      const known = knownTxo.get(`${prevHash}:${prevN}`);
      if (!known) continue;
      insertTxi.run([
        walletId,
        txHash,
        prevHash,
        prevN,
        known.address,
        known.value,
      ]);
      inputsRecorded += 1;
    }
    insertTxi.free();

    const insertTxo = db.prepare(`
      INSERT INTO ledger_txo (wallet_id, tx_hash, tx_pos, address, value, height, token, prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_id, tx_hash, tx_pos) DO UPDATE SET
        address = excluded.address,
        value = excluded.value,
        height = excluded.height,
        token = excluded.token,
        prefix = excluded.prefix
    `);

    const prefix = currentAddressPrefix();
    decoded.outputs.forEach((output, index) => {
      const lockingHex = binToHex(output.lockingBytecode);
      let address = bytecodeMap.get(lockingHex);
      if (!address) {
        // Fallback: decode and check set (token-aware addresses may differ form)
        const decodedAddr = addressFromLockingBytecode(output.lockingBytecode);
        if (decodedAddr && addressSet.has(decodedAddr)) {
          address = decodedAddr;
        }
      }
      if (!address) return;

      insertTxo.run([
        walletId,
        txHash,
        index,
        address,
        Number(output.valueSatoshis ?? 0n),
        height,
        tokenJsonFromDecodedOutput(output),
        prefix,
      ]);
      outputsRecorded += 1;
    });
    insertTxo.free();

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    logError('WalletLedgerService.applyRawTransaction', error, {
      walletId,
      txHash,
    });
    return {
      applied: false,
      inputsRecorded: 0,
      outputsRecorded: 0,
      error: error instanceof Error ? error.message : 'apply failed',
    };
  }

  if (height > 0) {
    void noteWalletHeights(walletId, [height]);
  }

  return { applied: true, inputsRecorded, outputsRecorded };
}

/**
 * Fetch missing raw hex from Electrum and apply into the ledger.
 * Bounded batch so open/sync stays snappy.
 */
export async function fetchAndApplyMissingTransactions(
  walletId: number,
  walletAddresses: ReadonlySet<string> | string[],
  options?: { limit?: number }
): Promise<{ fetched: number; applied: number }> {
  const missing = await listTxidsMissingRawHex(walletId, options?.limit ?? 100);
  if (missing.length === 0) return { fetched: 0, applied: 0 };

  let Electrum: {
    getRawTransactionMany: (
      hashes: string[]
    ) => Promise<Record<string, string>>;
  };
  try {
    Electrum = (await import('../../services/ElectrumService')).default;
  } catch {
    return { fetched: 0, applied: 0 };
  }

  const heightByTx = new Map(missing.map((m) => [m.tx_hash, m.height]));
  const rawByTx = await Electrum.getRawTransactionMany(
    missing.map((m) => m.tx_hash)
  );
  let applied = 0;
  for (const [txHash, rawHex] of Object.entries(rawByTx)) {
    const result = await applyRawTransaction(
      walletId,
      txHash,
      heightByTx.get(txHash) ?? 0,
      rawHex,
      walletAddresses
    );
    if (result.applied) applied += 1;
  }
  return { fetched: Object.keys(rawByTx).length, applied };
}

// ── Genesis height / scan window ───────────────────────────────────────────

export async function getWalletGenesisHeight(
  walletId: number
): Promise<number | null> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  try {
    const q = db.prepare(
      `SELECT genesis_height FROM wallet_ledger_meta WHERE wallet_id = ?`
    );
    q.bind([walletId]);
    let height: number | null = null;
    if (q.step()) {
      const row = q.getAsObject() as { genesis_height?: number | null };
      if (row.genesis_height != null && Number(row.genesis_height) > 0) {
        height = Number(row.genesis_height);
      }
    }
    q.free();
    return height;
  } catch {
    return null;
  }
}

/**
 * Lowest positive confirmation height seen for this wallet.
 * Used as the SPV/deep-scan window start (scan from genesis, not block 0).
 */
export async function noteWalletHeights(
  walletId: number,
  heights: number[]
): Promise<number | null> {
  const positives = heights
    .map((h) => Number(h) || 0)
    .filter((h) => h > 0);
  if (positives.length === 0) return getWalletGenesisHeight(walletId);

  const minSeen = Math.min(...positives);
  const maxSeen = Math.max(...positives);

  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  try {
    const existing = await getWalletGenesisHeight(walletId);
    let tip: number | null = null;
    const tipQ = db.prepare(
      `SELECT tip_height FROM wallet_ledger_meta WHERE wallet_id = ?`
    );
    tipQ.bind([walletId]);
    if (tipQ.step()) {
      const row = tipQ.getAsObject() as { tip_height?: number | null };
      tip =
        row.tip_height != null && Number(row.tip_height) > 0
          ? Number(row.tip_height)
          : null;
    }
    tipQ.free();

    const genesis =
      existing != null && existing > 0 ? Math.min(existing, minSeen) : minSeen;
    const nextTip = tip != null ? Math.max(tip, maxSeen) : maxSeen;

    db.run(
      `INSERT INTO wallet_ledger_meta (wallet_id, genesis_height, tip_height, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet_id) DO UPDATE SET
         genesis_height = excluded.genesis_height,
         tip_height = excluded.tip_height,
         updated_at = excluded.updated_at`,
      [walletId, genesis, nextTip, nowIso()]
    );
    return genesis;
  } catch (error) {
    logError('WalletLedgerService.noteWalletHeights', error, { walletId });
    return null;
  }
}

/** Scan window start height (0 if unknown — full history). */
export async function getScanFromHeight(walletId: number): Promise<number> {
  return (await getWalletGenesisHeight(walletId)) ?? 0;
}

export async function recordHistoryItems(
  walletId: number,
  address: string,
  history: TransactionHistoryItem[]
): Promise<void> {
  for (const item of history) {
    await storeLedgerTransaction(walletId, item.tx_hash, item.height ?? 0, null);
  }
  await setAddressHistoryStatus(walletId, address, history);
  await noteWalletHeights(
    walletId,
    history.map((h) => h.height ?? 0)
  );
}

// ── Send-time live outpoint verification ───────────────────────────────────

export type OutpointRef = {
  tx_hash: string;
  tx_pos: number;
  address?: string;
};

export type VerifyOutpointsResult =
  | { ok: true }
  | { ok: false; missing: string[]; message: string };

/**
 * Live check that selected outpoints still appear in Electrum listunspent.
 * Durable ledger cache ≠ trust forever — call before broadcast.
 */
export async function verifyOutpointsStillUnspent(
  outpoints: OutpointRef[]
): Promise<VerifyOutpointsResult> {
  if (!outpoints.length) return { ok: true };

  let Electrum: {
    getUTXOsMany: (addresses: string[]) => Promise<Record<string, UTXO[]>>;
  };
  try {
    Electrum = (await import('../../services/ElectrumService')).default;
  } catch {
    // Non-desktop / offline build — skip live gate rather than block send.
    return { ok: true };
  }

  const addresses = Array.from(
    new Set(outpoints.map((o) => o.address).filter((a): a is string => !!a))
  );
  if (addresses.length === 0) {
    // No addresses to probe — cannot prove spent/unspent; let the node decide.
    return { ok: true };
  }

  let many: Record<string, UTXO[]>;
  try {
    many = await Electrum.getUTXOsMany(addresses);
  } catch (error) {
    logError('WalletLedgerService.verifyOutpointsStillUnspent', error, {
      addressCount: addresses.length,
    });
    // Network failure: do not hard-fail send; broadcast will fail if spent.
    return { ok: true };
  }

  // Only treat an address as authoritative when getUTXOsMany returned a key.
  // Failed Electrum calls omit the address (or return nothing) — soft-pass those.
  const liveKeysByAddress = new Map<string, Set<string>>();
  for (const [address, list] of Object.entries(many)) {
    const keys = new Set<string>();
    for (const u of list ?? []) {
      keys.add(`${u.tx_hash}:${u.tx_pos}`);
    }
    liveKeysByAddress.set(address, keys);
  }

  const missing: string[] = [];
  for (const o of outpoints) {
    if (!o.address) continue;
    const live = liveKeysByAddress.get(o.address);
    if (!live) continue; // no authoritative response for this address
    const key = `${o.tx_hash}:${o.tx_pos}`;
    if (!live.has(key)) missing.push(key);
  }

  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    missing,
    message:
      missing.length === 1
        ? `Selected coin is no longer unspent (${missing[0]}). Refresh UTXOs and try again.`
        : `${missing.length} selected coins are no longer unspent. Refresh UTXOs and try again.`,
  };
}

/**
 * Load wallet receive addresses from SQL (keys/addresses tables).
 * Used when applying raw txs so we only record outputs we own.
 */
export async function loadWalletAddressSet(
  walletId: number
): Promise<Set<string>> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  const set = new Set<string>();
  if (!db) return set;

  try {
    const q = db.prepare(
      `SELECT address FROM addresses WHERE wallet_id = ?`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as { address?: string };
      if (typeof row.address === 'string' && row.address) set.add(row.address);
    }
    q.free();
  } catch {
    /* addresses table shape may vary */
  }

  try {
    const q = db.prepare(
      `SELECT address FROM keys WHERE wallet_id = ? AND address IS NOT NULL`
    );
    q.bind([walletId]);
    while (q.step()) {
      const row = q.getAsObject() as { address?: string };
      if (typeof row.address === 'string' && row.address) set.add(row.address);
    }
    q.free();
  } catch {
    /* keys table may not have address column on all builds */
  }

  return set;
}
