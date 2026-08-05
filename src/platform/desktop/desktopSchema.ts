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
  // Watch-only wallets have no mnemonic. Addresses derive from this account
  // xPub, so losing it means the wallet cannot rebuild its own addresses and
  // reads as empty after a restart.
  account_xpub: 'TEXT',
  // 8 hex chars from the signing device (SeedCash shows it with the account
  // xPub). Written into PSBT BIP32 derivation metadata so the signer can
  // claim the inputs; without it the signer refuses.
  master_fingerprint: 'TEXT',
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

    ledgerEnsured = true;
  } catch (error) {
    logError('desktopSchema.ensureDesktopLedgerTables', error);
  }
}

/**
 * Make sure the desktop-only wallet columns exist.
 *
 * Safe to call repeatedly and from several windows: it checks before altering,
 * and a column that already exists is left alone. Failure is logged rather than
 * thrown — a missing column breaks the feature that needs it, which will say so
 * itself, but must not stop the app from opening.
 */
export async function ensureDesktopWalletColumns(): Promise<void> {
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
        db.run(`ALTER TABLE wallets ADD COLUMN ${column} ${type};`);
      }
    }
    ensured = true;
  } catch (error) {
    logError('desktopSchema.ensureDesktopWalletColumns', error);
  }
}
