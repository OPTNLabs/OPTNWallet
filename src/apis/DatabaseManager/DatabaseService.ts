// src/apis/DatabaseManager/DatabaseService.ts

import initSqlJs, { Database } from 'sql.js';
import { createTables } from '../../utils/schema/schema';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { logError } from '../../utils/errorHandling';

// Single shared DB handle
let db: Database | null = null;

// ** Debounce state **
let saveTimeout: number | null = null;
let pendingSavePromise: Promise<void> | null = null;

// ** Migrations Array **
const migrations: Array<(db: Database) => Promise<void>> = [
  async (db) => {
    createTables(db);
  },
  // Add future migrations here as needed
];

/** Write into IndexedDB instead of localStorage */
async function realSaveDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export(); // Uint8Array
  await idbSet('OPTNDatabase', data); // Store raw bytes
  // console.log('Persisted DB to IndexedDB');
}

const startDatabase = async (): Promise<Database | null> => {
  const SQLModule = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  });
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

  // Apply migrations
  const versionResult = db.exec('PRAGMA user_version;');
  const currentVersion = versionResult[0].values[0][0] as number;
  const targetVersion = migrations.length;

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    await migrations[v - 1](db);
    db.run(`PRAGMA user_version = ${v};`);
  }

  // Save immediately after migrations to persist schema changes
  await realSaveDatabase();

  return db;
};

const ensureDatabaseStarted = async (): Promise<void> => {
  if (!db) {
    await startDatabase();
  }
};

/**
 * Debounced save: schedule a real save 500ms in the future,
 * coalescing multiple calls into one. Returns a promise that
 * resolves after the actual save finishes.
 */
const saveDatabaseToFile = async (): Promise<void> => {
  await ensureDatabaseStarted();
  if (!db) return;

  if (!pendingSavePromise) {
    pendingSavePromise = new Promise((resolve) => {
      if (saveTimeout !== null) {
        clearTimeout(saveTimeout);
      }
      saveTimeout = window.setTimeout(async () => {
        try {
          await realSaveDatabase();
        } catch (error) {
          logError('DatabaseService.saveDatabaseToFile', error);
        }
        pendingSavePromise = null;
        saveTimeout = null;
        resolve();
      }, 500);
    });
  }
  return pendingSavePromise;
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
      DROP TABLE IF EXISTS cashscript_artifacts;
      DROP TABLE IF EXISTS cashscript_addresses;
      DROP TABLE IF EXISTS instantiated_contracts;
      DROP TABLE IF EXISTS bcmr;
      DROP TABLE IF EXISTS bcmr_tokens;
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
    await realSaveDatabase();
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
    saveDatabaseToFile,
    getDatabase,
    clearDatabase,
    resultToJSON,
  };
}
