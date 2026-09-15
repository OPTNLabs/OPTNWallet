import DatabaseService from '../apis/DatabaseManager/DatabaseService';

const WATCH_ONLY_WALLET_COLUMNS: Readonly<Record<string, string>> = {
  account_xpub: 'TEXT',
  master_fingerprint: 'TEXT',
  multisig_policy: 'TEXT',
};

let ensured = false;

/**
 * Ensure the public-only wallet columns required by watch-only wallets exist.
 *
 * These columns are shared because watch-only wallets are supported on desktop,
 * Android, and iOS. Hardware-only metadata (for example hw_type) remains owned
 * by the desktop hardware adapter.
 */
export async function ensureWatchOnlyWalletColumns(): Promise<void> {
  if (ensured) return;

  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');

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

  for (const [column, type] of Object.entries(WATCH_ONLY_WALLET_COLUMNS)) {
    if (existing.has(column)) continue;
    try {
      db.run(`ALTER TABLE wallets ADD COLUMN ${column} ${type};`);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
    existing.add(column);
  }

  ensured = Object.keys(WATCH_ONLY_WALLET_COLUMNS).every((column) =>
    existing.has(column)
  );
}

export function resetWatchOnlyWalletColumnsCache(): void {
  ensured = false;
}
