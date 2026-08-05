// Option A hybrid ledger — durable chain state for one wallet.
//
// Truth: ledger_transactions + ledger_txo + ledger_txi + address_sync_status.
// UTXOs SQL table is a cache rebuilt from unspent ledger_txo.
// See docs/wallet-ledger-sync-design.md.

import { sha256 } from '@bitauth/libauth';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../../apis/UTXOManager/UTXOManager';
import type { TransactionHistoryItem, UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';
import { ensureDesktopLedgerTables } from './desktopSchema';

function hexFromHash(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function nowIso(): string {
  return new Date().toISOString();
}

/** EC / Selene style: sha256 of "txid:height:" for each history item. */
export function computeHistoryStatusHash(
  history: Array<{ tx_hash: string; height: number }>
): string | null {
  if (!history.length) return null;
  let status = '';
  for (const item of history) {
    const h = Number(item.height) || 0;
    status += `${item.tx_hash}:${h}:`;
  }
  const digest = sha256.hash(new TextEncoder().encode(status));
  return hexFromHash(digest);
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

/**
 * Apply a listunspent snapshot for one address into the ledger.
 * - Registers each unspent as ledger_txo
 * - Marks local coins for this address that vanished as spent (synthetic txi)
 *   so rebuildUtxosFromLedger matches the network set for this address.
 */
export async function applyAddressUtxoSnapshot(
  walletId: number,
  snapshot: AddressUtxoSnapshot
): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return;

  const { address, utxos } = snapshot;
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

    // External spend (or spent in another wallet copy): mark gone outpoints spent
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
): Promise<string | null> {
  await ensureDesktopLedgerTables();
  const status = computeHistoryStatusHash(history);
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return status;

  try {
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
  if (remoteStatus == null || remoteStatus === '') return false;
  const local = await getAddressHistoryStatus(walletId, address);
  return local != null && local === remoteStatus;
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
 * Rebuild the UTXOs cache table from unspent ledger_txo rows.
 * Ledger wins — this is the divergence fix.
 */
export async function rebuildUtxosFromLedger(walletId: number): Promise<number> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return 0;

  const utxos: UTXO[] = [];
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
      utxos.push({
        wallet_id: walletId,
        address: String(row.address),
        height: Number(row.height) || 0,
        tx_hash: String(row.tx_hash),
        tx_pos: Number(row.tx_pos),
        value,
        amount: value,
        prefix: typeof row.prefix === 'string' ? row.prefix : undefined,
        token,
      });
    }
    q.free();
  } catch (error) {
    logError('WalletLedgerService.rebuildUtxosFromLedger.read', error, {
      walletId,
    });
    return 0;
  }

  try {
    const mgr = UTXOManager();
    // Replace entire wallet UTXO cache with ledger projection
    await dbService.ensureDatabaseStarted();
    const d = dbService.getDatabase();
    if (d) {
      d.run(`DELETE FROM UTXOs WHERE wallet_id = ?`, [walletId]);
    }
    if (utxos.length > 0) {
      await mgr.storeUTXOs(utxos);
    }
  } catch (error) {
    logError('WalletLedgerService.rebuildUtxosFromLedger.write', error, {
      walletId,
    });
  }
  return utxos.length;
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

/** Store raw tx hex when known (for future full txi application). */
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

export async function recordHistoryItems(
  walletId: number,
  address: string,
  history: TransactionHistoryItem[]
): Promise<void> {
  for (const item of history) {
    await storeLedgerTransaction(walletId, item.tx_hash, item.height ?? 0, null);
  }
  await setAddressHistoryStatus(walletId, address, history);
}
