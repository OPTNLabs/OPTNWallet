// src/apis/DatabaseManager/DatabaseService.ts

import initSqlJs, { Database } from 'sql.js';
import { createTables } from '../../utils/schema/schema';
import { get as idbGet, set as idbSet } from 'idb-keyval';

/**
 * DatabaseService
 *
 * Wrapper around sql.js (SQLite in WASM) with IndexedDB persistence.
 * Handles:
 *   - Database initialization and migrations
 *   - Enforcing schema (createTables)
 *   - Debounced persistence
 *   - Clearing and resetting schema
 *
 * ⚠️ Entire DB is persisted as a single binary blob into IndexedDB.
 * Suitable for wallets, but may grow large with BCMR and contract metadata.
 */

let db: Database | null = null;
let saveTimeout: number | null = null;
let pendingSavePromise: Promise<void> | null = null;

/**
 * Array of schema migrations to apply sequentially.
 * Each migration is an async function that accepts a Database handle.
 */
const migrations: Array<(db: Database) => Promise<void>> = [
  async (db) => {
    createTables(db);
  },
  // Add new migrations here
];

/**
 * Persists the database into IndexedDB.
 * @returns {Promise<void>} Resolves once the DB has been successfully saved.
 */
async function realSaveDatabase(): Promise<void> {
  if (!db) return;
  try {
    const data = db.export();
    await idbSet('OPTNDatabase', data);
  } catch (e) {
    console.error("Database save failed:", e);
  }
}

/**
 * Initializes the database:
 *  - Loads from IndexedDB if available
 *  - Creates a new DB otherwise
 *  - Applies pending migrations
 *  - Enforces foreign key constraints
 *
 * @returns {Promise<Database | null>} Active Database instance or null on failure
 */
const startDatabase = async (): Promise<Database | null> => {
  const SQLModule = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  });

  const saved = await idbGet('OPTNDatabase');
  if (saved) {
    db = new SQLModule.Database(new Uint8Array(saved as any));
  } else {
    db = new SQLModule.Database();
    db.run('PRAGMA user_version = 0;');
  }

  // Enforce FK constraints
  db.run("PRAGMA foreign_keys = ON;");

  try {
    const versionResult = db.exec('PRAGMA user_version;');
    let currentVersion = versionResult[0].values[0][0] as number;
    const targetVersion = migrations.length;

    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      await migrations[v - 1](db);
      db.run(`PRAGMA user_version = ${v};`);
    }
  } catch (e) {
    console.error("Migration failed:", e);
  }

  await realSaveDatabase();
  return db;
};

/**
 * Ensures the database is initialized before usage.
 * @returns {Promise<void>}
 */
const ensureDatabaseStarted = async (): Promise<void> => {
  if (!db) {
    await startDatabase();
  }
};

/**
 * Debounced save: coalesces multiple save calls into one within 500ms.
 * Always resolves, even if saving fails, to prevent hanging awaits.
 *
 * @returns {Promise<void>} Resolves after save completes or errors out.
 */
const saveDatabaseToFile = async (): Promise<void> => {
  await ensureDatabaseStarted();
  if (!db) return;

  if (!pendingSavePromise) {
    pendingSavePromise = new Promise((resolve) => {
      if (saveTimeout !== null) clearTimeout(saveTimeout);

      saveTimeout = window.setTimeout(async () => {
        try {
          await realSaveDatabase();
        } finally {
          pendingSavePromise = null;
          saveTimeout = null;
          resolve();
        }
      }, 500);
    });
  }
  return pendingSavePromise;
};

/**
 * Retrieves the current database instance.
 * @returns {Database | null} sql.js Database instance or null if not initialized
 */
const getDatabase = (): Database | null => db;

/**
 * Drops all tables, resets schema version, and reapplies migrations.
 * ⚠️ Irreversible: wipes all wallet data.
 *
 * @returns {Promise<void>}
 */
const clearDatabase = async (): Promise<void> => {
  await ensureDatabaseStarted();
  if (db) {
    try {
      db.exec(`
        DROP TABLE IF EXISTS wallets;
        DROP TABLE IF EXISTS keys;
        DROP TABLE IF EXISTS addresses;
        DROP TABLE IF EXISTS UTXOs;
        DROP TABLE IF EXISTS transactions;
        DROP TABLE IF EXISTS cashscript_artifacts;
        DROP TABLE IF EXISTS cashscript_addresses;
        DROP TABLE IF EXISTS instantiated_contracts;
        DROP TABLE IF EXISTS bcmr;
        DROP TABLE IF EXISTS bcmr_tokens;
        DROP TABLE IF EXISTS bcmr_metadata;
      `);

      db.run('PRAGMA user_version = 0;');
      const targetVersion = migrations.length;
      for (let v = 1; v <= targetVersion; v++) {
        await migrations[v - 1](db);
        db.run(`PRAGMA user_version = ${v};`);
      }

      // Integrity check: ensure tables exist
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table';");
      if (!tables || tables.length === 0) {
        throw new Error("Schema re-creation failed");
      }

      await realSaveDatabase();
    } catch (e) {
      console.error("Failed to clear database:", e);
    }
  }
};

/**
 * Converts raw query results into a mnemonic/passphrase object.
 *
 * @param result Array of query results (mnemonic, passphrase)
 * @returns Object containing mnemonic and passphrase
 */
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

/**
 * DatabaseService factory.
 * @returns Object exposing DB lifecycle and utility functions.
 */
export default function DatabaseService() {
  return {
    startDatabase,
    ensureDatabaseStarted,
    saveDatabaseToFile,
    getDatabase,
    clearDatabase,
    resultToJSON,
  };
}
