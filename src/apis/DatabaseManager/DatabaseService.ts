// src/apis/DatabaseManager/DatabaseService.ts

import initSqlJs, { Database } from 'sql.js';
import {
  createTables,
  createTransactionDetailsTable,
  createMultisigTables,
} from '../../utils/schema/schema';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { logError } from '../../utils/errorHandling';
import SecretCryptoService, {
  SECRET_ENC_PREFIX,
  isEncryptedPayload,
} from '../../services/SecretCryptoService';
/**
 * The BIP44 account paths this app used before derivation paths became
 * configurable. Frozen here on purpose — see the migration below.
 *
 * Deliberately NOT named "legacy": the chipnet value here is also the current
 * network default. These constants record history, and history does not move
 * when the default does — in either direction.
 */
const PRE_CONFIGURABLE_CHIPNET_ACCOUNT_PATH = "m/44'/1'/0'";
const PRE_CONFIGURABLE_MAINNET_ACCOUNT_PATH = "m/44'/145'/0'";
import { Network } from '../../state/slices/networkSlice';
import {
  deleteWalletScope,
  mergeGlobalChanges,
  mergeWalletScope,
  remapWalletScopeId,
  snapshotGlobalTables,
  walletScopeFingerprint,
  type GlobalTableSnapshot,
} from './DatabaseMerge';

// Single shared DB handle
let db: Database | null = null;
// The initialised sql.js module, kept so saves can merge into the latest
// IndexedDB snapshot without replacing this window's live database handle.
let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;
// In-flight start, so concurrent ensureDatabaseStarted() calls share ONE
// startDatabase() instead of each loading a snapshot and racing to save it
// back — that race silently dropped freshly-created wallets (a stale parallel
// load would overwrite IndexedDB after a newer write).
let startPromise: Promise<Database | null> | null = null;

// ** Debounce state **
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSavePromise: Promise<void> | null = null;
let resolvePendingSave: (() => void) | null = null;
let rejectPendingSave: ((reason?: unknown) => void) | null = null;
let firstQueuedSaveTs: number | null = null;
let pendingGenericSave = false;
const pendingWalletSaveIds = new Set<number>();
let localSaveQueue: Promise<void> = Promise.resolve();
let queuedSaveRun: Promise<void> | null = null;
let globalBaseline: GlobalTableSnapshot = {};
let walletBaselines = new Map<number, string>();

const SAVE_DEBOUNCE_MS = 500;
const SAVE_MAX_DELAY_MS = 3000;

function isWalletId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function withExclusiveSaveLock(task: () => Promise<void>): Promise<void> {
  const lockManager = (
    globalThis.navigator as
      | (Navigator & {
          locks?: {
            request: (
              name: string,
              callback: () => Promise<void>
            ) => Promise<void>;
          };
        })
      | undefined
  )?.locks;
  if (lockManager?.request) {
    await lockManager.request('optn-shared-wallet-database-v1', task);
    return;
  }

  const run = localSaveQueue.then(task, task);
  localSaveQueue = run.catch(() => undefined);
  await run;
}

// ** Migrations Array **
const migrations: Array<(db: Database) => Promise<void>> = [
  async (db) => {
    createTables(db);
  },
  async (db) => {
    createTransactionDetailsTable(db);
  },
  async (db) => {
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('walletType')) {
      db.run(
        "ALTER TABLE wallets ADD COLUMN walletType TEXT DEFAULT 'standard';"
      );
    }
  },
  async (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS quantumroot_vaults (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INT NOT NULL,
        account_index INT NOT NULL,
        address_index INT NOT NULL,
        receive_address VARCHAR(255) NOT NULL UNIQUE,
        quantum_lock_address VARCHAR(255) NOT NULL UNIQUE,
        receive_locking_bytecode TEXT NOT NULL,
        quantum_lock_locking_bytecode TEXT NOT NULL,
        quantum_public_key TEXT NOT NULL,
        quantum_key_identifier TEXT NOT NULL,
        vault_token_category TEXT NOT NULL,
        online_quantum_signer INT NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(wallet_id) REFERENCES wallets(id),
        UNIQUE(wallet_id, account_index, address_index)
      );
    `);
  },
  async (db) => {
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(bcmr_metadata);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('lastFetch')) {
      db.run('ALTER TABLE bcmr_metadata ADD COLUMN lastFetch TEXT;');
    }
    if (!columns.has('registryUri')) {
      db.run('ALTER TABLE bcmr_metadata ADD COLUMN registryUri TEXT;');
    }
    if (!columns.has('registryHash')) {
      db.run('ALTER TABLE bcmr_metadata ADD COLUMN registryHash TEXT;');
    }
  },
  async (db) => {
    // Desktop-only per-wallet encryption key support (Electron Cash model: each
    // wallet has its own password/key, not one shared app-wide key). Column is
    // unused on mobile — NULL there, harmless.
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('kdf_salt')) {
      db.run('ALTER TABLE wallets ADD COLUMN kdf_salt TEXT;');
    }
  },
  async (db) => {
    // Birth height: the chain tip when this wallet was created. A BIP37 node
    // scan costs one merkleblock round-trip PER BLOCK, so scanning the whole
    // chain is impractical; knowing the wallet cannot have coins before its
    // birth lets a node scan only birth..tip. NULL for wallets created before
    // this column (and on mobile), where the scan falls back to a recent window.
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('birth_height')) {
      db.run('ALTER TABLE wallets ADD COLUMN birth_height INT;');
    }
  },
  async (db) => {
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('derivation_path')) {
      db.run('ALTER TABLE wallets ADD COLUMN derivation_path TEXT;');
    }
    if (!columns.has('derivation_path_source')) {
      db.run(
        "ALTER TABLE wallets ADD COLUMN derivation_path_source TEXT DEFAULT 'default';"
      );
    }

    // Materialize the legacy path before any wallet is opened. This preserves
    // the path that the pre-customization code used for each wallet's network.
    db.run(
      `UPDATE wallets
       SET derivation_path = CASE
         WHEN networkType = ? THEN ?
         ELSE ?
       END,
       derivation_path_source = ?
       WHERE derivation_path IS NULL OR derivation_path = ''`,
      [
        Network.CHIPNET,
        // Literals, NOT getBchAccountPath(). This migration exists to record
        // the path a wallet was ALREADY using, so it has to keep saying what
        // the old code said. Asking the current default would rewrite history
        // every time that default moves — and the chipnet default has now
        // moved twice (1 -> 145 -> 1) — silently re-deriving every address of
        // any wallet that had not been migrated yet.
        PRE_CONFIGURABLE_CHIPNET_ACCOUNT_PATH,
        PRE_CONFIGURABLE_MAINNET_ACCOUNT_PATH,
        'default',
      ]
    );
  },
  async (db) => {
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
  },
  async (db) => {
    // The desktop wallet used to scan six derived-data tables on every unlock
    // to repair rows left behind by an old network-switch bug. Record that the
    // one-time repair has run for this wallet/network so normal unlocks do not
    // repeat a migration forever. Mobile ignores these nullable columns.
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.name === 'string') columns.add(row.name);
    }
    statement.free();

    if (!columns.has('network_cleanup_version')) {
      db.run(
        'ALTER TABLE wallets ADD COLUMN network_cleanup_version INT DEFAULT 0;'
      );
    }
    if (!columns.has('network_cleanup_network')) {
      db.run('ALTER TABLE wallets ADD COLUMN network_cleanup_network TEXT;');
    }
  },
  async (db) => {
    // Multisig is a shared wallet capability. Keep its policy, address
    // inventory, derived-key mapping, and resumable PSBT sessions in the
    // common database so desktop and Capacitor/mobile use the same model.
    createMultisigTables(db);
  },
  async (db) => {
    // Migrate persisted merge targets too: local-only lazy columns otherwise
    // lose watch-only public metadata during wallet-scoped saves.
    const columns = new Set<string>();
    const statement = db.prepare('PRAGMA table_info(wallets);');
    try {
      while (statement.step()) {
        const row = statement.getAsObject() as Record<string, unknown>;
        if (typeof row.name === 'string') columns.add(row.name);
      }
    } finally {
      statement.free();
    }

    for (const column of ['account_xpub', 'master_fingerprint', 'multisig_policy']) {
      if (!columns.has(column)) {
        db.run(`ALTER TABLE wallets ADD COLUMN ${column} TEXT;`);
      }
    }
  },
  // Add future migrations here as needed
];

function databaseVersion(database: Database): number {
  const result = database.exec('PRAGMA user_version;');
  return Number(result?.[0]?.values?.[0]?.[0] ?? 0);
}

async function applyPendingMigrations(database: Database): Promise<boolean> {
  const currentVersion = databaseVersion(database);
  let changed = false;
  for (
    let version = currentVersion + 1;
    version <= migrations.length;
    version++
  ) {
    await migrations[version - 1](database);
    database.run(`PRAGMA user_version = ${version};`);
    changed = true;
  }
  return changed;
}

function walletIds(database: Database): number[] {
  const ids: number[] = [];
  const statement = database.prepare('SELECT id FROM wallets ORDER BY id');
  while (statement.step()) {
    const id = Number(statement.getAsObject().id);
    if (isWalletId(id)) ids.push(id);
  }
  statement.free();
  return ids;
}

function replaceWalletBaselines(database: Database): void {
  walletBaselines = new Map(
    walletIds(database).flatMap((walletId) => {
      const fingerprint = walletScopeFingerprint(database, walletId);
      return fingerprint ? [[walletId, fingerprint] as const] : [];
    })
  );
}

function nextAvailableWalletId(
  latest: Database,
  localDatabase: Database
): number {
  return Math.max(0, ...walletIds(latest), ...walletIds(localDatabase)) + 1;
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || value instanceof Uint8Array;
}

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function migrateSecretColumnsAtRest(
  database: Database | null = db
): Promise<boolean> {
  if (!database) return false;
  if (
    typeof (database as unknown as { prepare?: unknown }).prepare !== 'function'
  ) {
    // Unit tests may provide minimal DB mocks without SQL prepare/iteration support.
    return false;
  }
  let changed = false;

  // wallets.mnemonic / wallets.passphrase
  const walletRows = database.prepare(
    `SELECT id, mnemonic, passphrase FROM wallets
      WHERE (typeof(mnemonic) = 'text' AND mnemonic <> '' AND mnemonic NOT LIKE ?)
         OR (typeof(passphrase) = 'text' AND passphrase <> '' AND passphrase NOT LIKE ?);`
  );
  const encryptedPattern = `${SECRET_ENC_PREFIX}%`;
  walletRows.bind([encryptedPattern, encryptedPattern]);
  const walletUpdates: Array<{
    id: number;
    mnemonic: string;
    passphrase: string;
  }> = [];

  while (walletRows.step()) {
    const row = walletRows.getAsObject() as Record<string, unknown>;
    const id = Number(row.id);
    const mnemonicRaw = typeof row.mnemonic === 'string' ? row.mnemonic : '';
    const passphraseRaw =
      typeof row.passphrase === 'string' ? row.passphrase : '';
    const mnemonic =
      mnemonicRaw && !isEncryptedPayload(mnemonicRaw)
        ? await SecretCryptoService.encryptText(mnemonicRaw)
        : mnemonicRaw;
    const passphrase =
      passphraseRaw && !isEncryptedPayload(passphraseRaw)
        ? await SecretCryptoService.encryptText(passphraseRaw)
        : passphraseRaw;

    if (mnemonic !== mnemonicRaw || passphrase !== passphraseRaw) {
      walletUpdates.push({ id, mnemonic, passphrase });
      changed = true;
    }
  }
  walletRows.free();

  if (walletUpdates.length > 0) {
    const updateWalletStmt = database.prepare(
      'UPDATE wallets SET mnemonic = ?, passphrase = ? WHERE id = ?;'
    );
    for (const item of walletUpdates) {
      updateWalletStmt.run([item.mnemonic, item.passphrase, item.id]);
    }
    updateWalletStmt.free();
  }

  // keys.private_key
  const keyRows = database.prepare(
    `SELECT id, private_key FROM keys
      WHERE private_key IS NOT NULL
        AND (
          typeof(private_key) <> 'text'
          OR (private_key <> '' AND private_key NOT LIKE ?)
        );`
  );
  keyRows.bind([encryptedPattern]);
  const keyUpdates: Array<{ id: number; privateKey: string }> = [];

  while (keyRows.step()) {
    const row = keyRows.getAsObject() as Record<string, unknown>;
    const id = Number(row.id);
    const raw = row.private_key;

    if (typeof raw === 'string') {
      if (isEncryptedPayload(raw)) continue;
      const decoded = decodeBase64ToBytes(raw);
      if (!decoded) continue;
      const encrypted = await SecretCryptoService.encryptBytes(decoded);
      keyUpdates.push({ id, privateKey: encrypted });
      changed = true;
      continue;
    }

    if (isArrayBufferLike(raw)) {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const encrypted = await SecretCryptoService.encryptBytes(bytes);
      keyUpdates.push({ id, privateKey: encrypted });
      changed = true;
    }
  }
  keyRows.free();

  if (keyUpdates.length > 0) {
    const updateKeyStmt = database.prepare(
      'UPDATE keys SET private_key = ? WHERE id = ?;'
    );
    for (const item of keyUpdates) {
      updateKeyStmt.run([item.privateKey, item.id]);
    }
    updateKeyStmt.free();
  }

  return changed;
}

/** Write into IndexedDB instead of localStorage. */
async function realSaveDatabase(
  force = false,
  walletId?: number
): Promise<void> {
  await withExclusiveSaveLock(async () => {
    if (!db) return;
    const localDatabase = db;
    const existing = await idbGet('OPTNDatabase');
    const bytes =
      existing instanceof Uint8Array
        ? existing
        : existing instanceof ArrayBuffer
          ? new Uint8Array(existing)
          : null;

    if (bytes && sqlModule && (!force || isWalletId(walletId))) {
      const latest = new sqlModule.Database(bytes);
      try {
        await applyPendingMigrations(latest);
        await migrateSecretColumnsAtRest(latest);

        if (isWalletId(walletId)) {
          const baseline = walletBaselines.get(walletId) ?? null;
          const latestFingerprint = walletScopeFingerprint(latest, walletId);
          const localFingerprint = walletScopeFingerprint(
            localDatabase,
            walletId
          );
          if (
            latestFingerprint !== baseline &&
            latestFingerprint !== localFingerprint
          ) {
            throw new Error(
              `Wallet ${walletId} changed in another window. Reopen it before saving again.`
            );
          }
          if (latestFingerprint === localFingerprint && localFingerprint) {
            walletBaselines.set(walletId, localFingerprint);
            return;
          }

          mergeWalletScope(latest, localDatabase, walletId);
        } else {
          const nextGlobalBaseline = snapshotGlobalTables(localDatabase);
          mergeGlobalChanges(latest, localDatabase, globalBaseline);
          const merged = latest.export();
          await idbSet('OPTNDatabase', merged);
          globalBaseline = nextGlobalBaseline;
          // The latest snapshot may have normalized legacy encrypted secrets
          // with fresh IVs. Baselines must describe what was actually
          // persisted, otherwise the next wallet-scoped save can mistake a
          // migration-only ciphertext difference for a concurrent edit.
          replaceWalletBaselines(latest);
          return;
        }

        const merged = latest.export();
        await idbSet('OPTNDatabase', merged);
        if (isWalletId(walletId)) {
          const fingerprint = walletScopeFingerprint(latest, walletId);
          if (fingerprint) walletBaselines.set(walletId, fingerprint);
        }
      } finally {
        latest.close();
      }
      return;
    }

    await idbSet('OPTNDatabase', localDatabase.export());
    globalBaseline = snapshotGlobalTables(localDatabase);
    if (force) replaceWalletBaselines(localDatabase);
  });
}

function clearScheduledSaveState(): void {
  if (saveTimeout !== null) {
    globalThis.clearTimeout(saveTimeout);
  }
  pendingSavePromise = null;
  resolvePendingSave = null;
  rejectPendingSave = null;
  saveTimeout = null;
  firstQueuedSaveTs = null;
  pendingGenericSave = false;
  pendingWalletSaveIds.clear();
}

async function performQueuedSave(): Promise<void> {
  if (queuedSaveRun) return queuedSaveRun;

  queuedSaveRun = (async () => {
    let firstError: unknown = null;
    try {
      while (pendingGenericSave || pendingWalletSaveIds.size > 0) {
        const walletIds = [...pendingWalletSaveIds];
        const saveGeneric = pendingGenericSave;
        pendingWalletSaveIds.clear();
        pendingGenericSave = false;

        for (const walletId of walletIds) {
          try {
            await realSaveDatabase(false, walletId);
          } catch (error) {
            firstError ??= error;
            logError('DatabaseService.performQueuedSave', error, { walletId });
          }
        }
        if (saveGeneric) {
          try {
            await realSaveDatabase();
          } catch (error) {
            firstError ??= error;
            logError('DatabaseService.performQueuedSave', error, {
              scope: 'global',
            });
          }
        }
      }
    } finally {
      const resolve = resolvePendingSave;
      const reject = rejectPendingSave;
      clearScheduledSaveState();
      queuedSaveRun = null;
      if (firstError) reject?.(firstError);
      else resolve?.();
    }
  })();

  return queuedSaveRun;
}

/**
 * Re-read the shared database from disk and rebase this window's save
 * baselines on it. Safe only while no wallet is open.
 *
 * A window keeps ONE sql.js `Database` for its entire life — `startDatabase`
 * loads it once and nothing ever reloads it. Locking or closing a wallet wipes
 * the keys and the redux state but leaves those rows, and the baselines taken
 * from them, in place. The moment another window writes that wallet, this
 * window's copy is stale in a way it cannot detect.
 *
 * Reopening the wallet then fails the concurrent-edit check in
 * `realSaveDatabase` *permanently*, because neither side of that comparison is
 * ever refreshed: on-disk differs from both our baseline and our local rows, so
 * every save is refused with "changed in another window" — including the UTXO
 * write. The wallet reports a successful sync and shows no balance, and only
 * restarting the app clears it.
 *
 * Adopting the on-disk copy wholesale is correct here precisely because no
 * wallet is open: there is nothing unsaved to lose, and disk is by definition
 * at least as new as what we held.
 */
const resyncDatabaseFromDisk = async (): Promise<void> => {
  const SQLModule = sqlModule;
  if (!SQLModule) return;

  const saved = await idbGet('OPTNDatabase');
  const savedBytes =
    saved instanceof Uint8Array
      ? saved
      : saved instanceof ArrayBuffer
        ? new Uint8Array(saved)
        : null;
  if (!savedBytes) return;

  // Under the save lock: swapping `db` out from under an in-flight save would
  // export a half-replaced database.
  await withExclusiveSaveLock(async () => {
    const latest = new SQLModule.Database(savedBytes);
    try {
      await applyPendingMigrations(latest);
    } catch (error) {
      latest.close();
      throw error;
    }
    db?.close();
    db = latest;
    globalBaseline = snapshotGlobalTables(db);
    replaceWalletBaselines(db);
  });
};

const startDatabase = async (): Promise<Database | null> => {
  const SQLModule = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  });
  sqlModule = SQLModule;
  const saved = await idbGet('OPTNDatabase');
  const savedBytes =
    saved instanceof Uint8Array
      ? saved
      : saved instanceof ArrayBuffer
        ? new Uint8Array(saved)
        : null;
  if (savedBytes) {
    db = new SQLModule.Database(savedBytes);
  } else {
    db = new SQLModule.Database();
    db.run('PRAGMA user_version = 0;'); // New databases start at version 0
  }

  const schemaChanged = await applyPendingMigrations(db);
  const secretsChanged = await migrateSecretColumnsAtRest();
  globalBaseline = snapshotGlobalTables(db);
  replaceWalletBaselines(db);
  // Starting another wallet window must be read-only when the persisted
  // database is already current. Re-exporting and rewriting the whole shared
  // snapshot here serialized every window behind the save lock and visibly
  // blocked wallet listing/unlock.
  if (!savedBytes || schemaChanged || secretsChanged) {
    await realSaveDatabase();
  }

  return db;
};

const ensureDatabaseStarted = async (): Promise<void> => {
  if (db) return;
  if (!startPromise) {
    startPromise = startDatabase();
    // Allow a retry if the very first start fails, but never run two at once.
    startPromise.catch(() => {
      startPromise = null;
    });
  }
  await startPromise;
};

const queueSave = async (
  delayMs = SAVE_DEBOUNCE_MS,
  walletId?: number
): Promise<void> => {
  await ensureDatabaseStarted();
  if (!db) return;

  if (isWalletId(walletId)) {
    pendingWalletSaveIds.add(walletId);
  } else {
    pendingGenericSave = true;
  }

  const now = Date.now();
  if (!pendingSavePromise) {
    pendingSavePromise = new Promise((resolve, reject) => {
      resolvePendingSave = resolve;
      rejectPendingSave = reject;
    });
    firstQueuedSaveTs = now;
  }

  if (saveTimeout !== null) {
    globalThis.clearTimeout(saveTimeout);
  }

  const queuedAt = firstQueuedSaveTs ?? now;
  const elapsed = now - queuedAt;
  const remainingMaxDelay = Math.max(0, SAVE_MAX_DELAY_MS - elapsed);
  const waitMs = Math.min(delayMs, remainingMaxDelay);

  saveTimeout = globalThis.setTimeout(() => {
    void performQueuedSave();
  }, waitMs);

  return pendingSavePromise;
};

/**
 * Debounced save: schedule a real save 500ms in the future,
 * coalescing multiple calls into one. Returns a promise that
 * resolves after the actual save finishes.
 */
const saveDatabaseToFile = async (walletId?: number): Promise<void> => {
  return queueSave(SAVE_DEBOUNCE_MS, walletId);
};

const scheduleDatabaseSave = (walletId?: number): void => {
  void queueSave(SAVE_DEBOUNCE_MS, walletId).catch((error) => {
    logError('DatabaseService.scheduleDatabaseSave', error, { walletId });
  });
};

const flushDatabaseToFile = async (walletId?: number): Promise<void> => {
  await ensureDatabaseStarted();
  if (!db) return;

  if (saveTimeout !== null) {
    globalThis.clearTimeout(saveTimeout);
    saveTimeout = null;
  }

  if (pendingSavePromise) {
    const pending = pendingSavePromise;
    if (isWalletId(walletId)) {
      pendingWalletSaveIds.add(walletId);
    } else {
      pendingGenericSave = true;
    }
    void performQueuedSave();
    await pending;
    return;
  }

  try {
    await realSaveDatabase(false, walletId);
  } catch (error) {
    logError('DatabaseService.flushDatabaseToFile', error);
    throw error;
  }
};

// Persist immediately. A wallet id remains wallet-scoped; force without one is
// reserved for intentional whole-database replacement (for example clear).
const forceSaveDatabase = async (walletId?: number): Promise<void> => {
  await ensureDatabaseStarted();
  await realSaveDatabase(true, walletId);
};

/**
 * Persist the wallet row immediately after it is inserted locally. If another
 * window allocated the same SQLite id first, reassign this still-empty wallet
 * row under the shared save lock before publishing it.
 */
const persistNewWalletToFile = async (
  localWalletId: number
): Promise<number> => {
  if (!isWalletId(localWalletId)) {
    throw new Error('Invalid newly-created wallet id.');
  }
  await ensureDatabaseStarted();
  if (!db) throw new Error('Database is not available.');

  let persistedWalletId = localWalletId;
  await withExclusiveSaveLock(async () => {
    if (!db) throw new Error('Database is not available.');
    const localDatabase = db;
    if (!walletScopeFingerprint(localDatabase, localWalletId)) {
      throw new Error(`New wallet ${localWalletId} is missing locally.`);
    }

    const existing = await idbGet('OPTNDatabase');
    const bytes =
      existing instanceof Uint8Array
        ? existing
        : existing instanceof ArrayBuffer
          ? new Uint8Array(existing)
          : null;

    if (bytes && sqlModule) {
      const latest = new sqlModule.Database(bytes);
      try {
        await applyPendingMigrations(latest);
        await migrateSecretColumnsAtRest(latest);
        if (walletScopeFingerprint(latest, localWalletId)) {
          if (walletBaselines.has(localWalletId)) {
            throw new Error(
              `Wallet ${localWalletId} already existed before this creation.`
            );
          }
          persistedWalletId = nextAvailableWalletId(latest, localDatabase);
          remapWalletScopeId(localDatabase, localWalletId, persistedWalletId);
        }

        mergeWalletScope(latest, localDatabase, persistedWalletId);
        await idbSet('OPTNDatabase', latest.export());
      } finally {
        latest.close();
      }
    } else {
      await idbSet('OPTNDatabase', localDatabase.export());
    }

    const fingerprint = walletScopeFingerprint(
      localDatabase,
      persistedWalletId
    );
    if (!fingerprint) {
      throw new Error(
        `New wallet ${persistedWalletId} disappeared before persistence.`
      );
    }
    walletBaselines.set(persistedWalletId, fingerprint);
  });

  return persistedWalletId;
};

const deleteWalletFromFile = async (walletId: number): Promise<void> => {
  if (!isWalletId(walletId)) {
    throw new Error('Invalid wallet id for database deletion.');
  }
  await ensureDatabaseStarted();
  await withExclusiveSaveLock(async () => {
    const existing = await idbGet('OPTNDatabase');
    const bytes =
      existing instanceof Uint8Array
        ? existing
        : existing instanceof ArrayBuffer
          ? new Uint8Array(existing)
          : null;
    if (!bytes || !sqlModule) return;

    const latest = new sqlModule.Database(bytes);
    try {
      await applyPendingMigrations(latest);
      await migrateSecretColumnsAtRest(latest);
      deleteWalletScope(latest, walletId);
      await idbSet('OPTNDatabase', latest.export());
      walletBaselines.delete(walletId);
    } finally {
      latest.close();
    }
  });
};

const getDatabase = (): Database | null => db;

const clearDatabase = async (): Promise<void> => {
  await ensureDatabaseStarted();
  if (db) {
    // Drop all tables
    db.exec(`
      DROP TABLE IF EXISTS wallets;
      DROP TABLE IF EXISTS keys;
      DROP TABLE IF EXISTS addresses;
      DROP TABLE IF EXISTS UTXOs;
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS transaction_details;
      DROP TABLE IF EXISTS cashscript_artifacts;
      DROP TABLE IF EXISTS cashscript_addresses;
      DROP TABLE IF EXISTS instantiated_contracts;
      DROP TABLE IF EXISTS bcmr;
      DROP TABLE IF EXISTS bcmr_tokens;
      DROP TABLE IF EXISTS multisig_spend_sessions;
      DROP TABLE IF EXISTS multisig_address_keys;
      DROP TABLE IF EXISTS multisig_addresses;
      DROP TABLE IF EXISTS multisig_cosigners;
      DROP TABLE IF EXISTS multisig_policies;
    `);
    // Reset schema version to 0
    db.run('PRAGMA user_version = 0;');
    // Apply all migrations
    const targetVersion = migrations.length;
    for (let v = 1; v <= targetVersion; v++) {
      await migrations[v - 1](db);
      db.run(`PRAGMA user_version = ${v};`);
    }
    // Save immediately
    await realSaveDatabase(true);
  }
};

const resultToJSON = (
  result: (string | undefined)[]
): { mnemonic: string; passphrase: string } => {
  if (!result || result.length === 0) {
    return { mnemonic: '', passphrase: '' };
  }
  return {
    mnemonic: result[0] as string,
    passphrase: result[1] ? (result[1] as string) : '',
  };
};

export default function DatabaseService() {
  return {
    startDatabase,
    ensureDatabaseStarted,
    resyncDatabaseFromDisk,
    saveDatabaseToFile,
    scheduleDatabaseSave,
    flushDatabaseToFile,
    forceSaveDatabase,
    persistNewWalletToFile,
    deleteWalletFromFile,
    getDatabase,
    clearDatabase,
    resultToJSON,
  };
}
