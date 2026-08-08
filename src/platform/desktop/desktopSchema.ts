// Schema the DESKTOP build needs, added without editing the shared schema.
//
// The wallets table and its migration list belong to the original author. A
// desktop-only feature must not force a change into them — that is what causes
// a conflict on every upstream pull, and a migration written there also runs on
// mobile where the column means nothing.
//
// So the columns are added here, idempotently, at the point the desktop feature
// that needs them is first used. ALTER TABLE ADD COLUMN on SQLite is cheap and
// rewrites nothing; adding a column no other build reads is invisible to them.

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { logError } from '../../utils/errorHandling';

/** Columns this build adds to `wallets`, with the type SQLite should give them. */
const DESKTOP_WALLET_COLUMNS: Record<string, string> = {
  // Shared by hardware + watch-only: account-level xPub for address rebuild.
  // EC Hardware_KeyStore / watch-only both keep an xpub; private keys never
  // live here for either type.
  account_xpub: 'TEXT',
  // Watch-only only (air-gap / SeedCash): 8 hex BIP32 fingerprint for PSBT
  // BIP32 derivation metadata. NOT used for USB hardware wallets.
  master_fingerprint: 'TEXT',
  // Hardware only — Electron Cash keystore dump field `hw_type`
  // (ledger | trezor | onekey). See electroncash.keystore.Hardware_KeyStore.dump.
  // The device signs; this only picks which plugin/path to open on Send.
  hw_type: 'TEXT',
  // Multisig watch-only policy as JSON: { name, m, signers[{name, xpub,
  // masterFingerprintHex?}] }.
  multisig_policy: 'TEXT',
};

let ensured = false;
let ledgerEnsured = false;

/**
 * Desktop HOT helpers only: address history status for the listunspent gate.
 * Idempotent CREATE IF NOT EXISTS. Not in shared schema.ts (zero-touch).
 *
 * Legacy Option-A tables (ledger_txo/txi/…) are no longer created. Rebuild
 * still DELETEs them if present so old poisoned DBs clean up.
 */
export async function ensureDesktopLedgerTables(): Promise<void> {
  if (ledgerEnsured) return;
  try {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) return;

    db.run(`
      CREATE TABLE IF NOT EXISTS address_sync_status (
        wallet_id INT NOT NULL,
        address TEXT NOT NULL,
        history_status TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (wallet_id, address)
      );
    `);

    // COLD: user labels for coins/txs/addresses — never used for balance.
    db.run(`
      CREATE TABLE IF NOT EXISTS coin_labels (
        wallet_id INT NOT NULL,
        kind TEXT NOT NULL,
        ref_key TEXT NOT NULL,
        label TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (wallet_id, kind, ref_key)
      );
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_coin_labels_wallet ON coin_labels(wallet_id);`
    );

    // CashFusion CoinJoin txids for Home / history "Fused" labels.
    // Must survive reload, multi-window, and localStorage flakiness — depth can
    // live in memory/LS, but the Fused badge must not.
    db.run(`
      CREATE TABLE IF NOT EXISTS fusion_txids (
        wallet_id INT NOT NULL,
        txid TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (wallet_id, txid)
      );
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_fusion_txids_wallet ON fusion_txids(wallet_id);`
    );

    ledgerEnsured = true;
  } catch (error) {
    logError('desktopSchema.ensureDesktopLedgerTables', error);
  }
}

/**
 * Make sure the desktop-only wallet columns exist.
 *
 * Safe to call repeatedly and from several windows: it checks before altering,
 * and a column that already exists is left alone. Concurrent windows may both
 * observe a missing column; a duplicate-column response means another window
 * completed that same migration and is therefore treated as success.
 */
export async function ensureDesktopWalletColumns(): Promise<void> {
  // Fast path only after a prior successful pass confirmed every column.
  // New columns (e.g. hw_type) force a re-scan when `ensured` is false.
  if (ensured) return;
  try {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) return;

    const existing = new Set<string>();
    const info = db.prepare('PRAGMA table_info(wallets);');
    try {
      while (info.step()) {
        const row = info.getAsObject() as Record<string, unknown>;
        if (typeof row.name === 'string') existing.add(row.name);
      }
    } finally {
      info.free();
    }

    for (const [column, type] of Object.entries(DESKTOP_WALLET_COLUMNS)) {
      if (!existing.has(column)) {
        try {
          db.run(`ALTER TABLE wallets ADD COLUMN ${column} ${type};`);
        } catch (error) {
          if (!/duplicate column name/i.test(String(error))) {
            throw error;
          }
        }
        existing.add(column);
      }
    }
    ensured = Object.keys(DESKTOP_WALLET_COLUMNS).every((c) => existing.has(c));
  } catch (error) {
    ensured = false;
    logError('desktopSchema.ensureDesktopWalletColumns', error);
    // Rethrow: callers (create/sign) must not pretend the column exists.
    throw error;
  }
}

/** Reset ensure cache (tests / after schema list changes in same process). */
export function resetDesktopWalletColumnsCache(): void {
  ensured = false;
}
