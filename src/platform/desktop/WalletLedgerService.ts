// Desktop HOT helpers — NOT a second balance boss.
//
// Keep:
//   • address history status hashes (skip listunspent when unchanged)
//   • send-time live outpoint verify
//   • rebuild wipe of chain cache tables
//
// Removed (bad dual-boss path):
//   • ledger_txo / ledger_txi as balance source
//   • applyAddressUtxoSnapshot + synthetic external: spends
//   • listUnspentFromLedger / rebuildUtxosFromLedger for Redux
//
// See docs/wallet-hot-cold-design.md

import { sha256 } from '@bitauth/libauth';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
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

/** True if local status matches remote Electrum address state. */
export async function addressHistoryIsFresh(
  walletId: number,
  address: string,
  remoteStatus: string | null | undefined
): Promise<boolean> {
  const local = await getAddressHistoryStatus(walletId, address);
  if (local == null) return false;
  if (remoteStatus === undefined) return false;
  return historyStatusesMatch(local, remoteStatus);
}

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
  dirty: string[];
  clean: string[];
  probed: number;
};

/**
 * Partition addresses into dirty/clean using status hashes.
 * No local status → dirty immediately (no probe).
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
    // Soft-fail: keep local status as clean rather than storm listunspent.
    return { dirty, clean: maybeClean, probed: 0 };
  }

  const clean: string[] = [];
  for (const address of maybeClean) {
    const local = localMap.get(address);
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

/** After history fetch: persist status hash so the HOT gate can skip clean addrs. */
export async function recordHistoryItems(
  walletId: number,
  address: string,
  history: TransactionHistoryItem[]
): Promise<void> {
  await setAddressHistoryStatus(walletId, address, history);
}

/**
 * Nuclear rebuild: wipe chain cache for this wallet, keep keys/seed.
 * Caller must re-run bootstrap + history after.
 */
export async function clearWalletChainData(walletId: number): Promise<void> {
  await ensureDesktopLedgerTables();
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database not started');

  // Include legacy Option-A tables so rebuild clears poisoned dual-boss data.
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
        /* table may not exist */
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

  try {
    const { invalidateUTXOCache } = await import('../../services/ElectrumService');
    invalidateUTXOCache();
  } catch {
    /* optional */
  }
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
 * Durable HOT cache ≠ trust forever — call before broadcast.
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
    return { ok: true };
  }

  const addresses = Array.from(
    new Set(outpoints.map((o) => o.address).filter((a): a is string => !!a))
  );
  if (addresses.length === 0) {
    return { ok: true };
  }

  let many: Record<string, UTXO[]>;
  try {
    many = await Electrum.getUTXOsMany(addresses);
  } catch (error) {
    logError('WalletLedgerService.verifyOutpointsStillUnspent', error, {
      addressCount: addresses.length,
    });
    return { ok: true };
  }

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
    if (!live) continue;
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
