// src/apis/DatabaseManager/DatabaseService.ts

import initSqlJs, { Database } from 'sql.js';
import { createTables } from '../../utils/schema/schema';
import { get as idbGet, set as idbSet } from 'idb-keyval';

// single shared DB handle
let db: Database | null = null;

// ** Debounce state **
let saveTimeout: number | null = null;
let pendingSavePromise: Promise<void> | null = null;

/** write into IndexedDB instead of localStorage */
async function realSaveDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export(); // Uint8Array
  await idbSet('OPTNDatabase', data); // store raw bytes
  // console.log('Persisted DB to IndexedDB');
}

const startDatabase = async (): Promise<Database | null> => {
  const SQLModule = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  });
  const saved = await idbGet('OPTNDatabase');
  if (saved) {
    // saved is already Uint8Array
    db = new SQLModule.Database(new Uint8Array(saved as any));
  } else {
    db = new SQLModule.Database();
    createTables(db);
  }
  await updateSchema(db);
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
        } catch (e) {
          console.error('Failed debounced save:', e);
        }
        // reset for next batch
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
    db.exec('VACUUM;');
    db.exec(`
      DROP TABLE IF EXISTS wallets;
      DROP TABLE IF EXISTS keys;
      DROP TABLE IF EXISTS addresses;
      DROP TABLE IF EXISTS UTXOs;
      DROP TABLE IF EXISTS transactions;
      DROP TABLE IF EXISTS cashscript_artifacts;
      DROP TABLE IF EXISTS cashscript_addresses;
      DROP TABLE IF EXISTS instantiated_contracts;
    `);
    createTables(db);
    // You can debounce this too, but usually on clear you want immediate:
    await realSaveDatabase();
  }
};

const updateSchema = async (db: Database): Promise<void> => {
  const result = db.exec(`PRAGMA table_info(instantiated_contracts);`);
  const columns = result[0].values.map((row) => row[1] as string);
  if (!columns.includes('abi')) {
    db.run(`ALTER TABLE instantiated_contracts ADD COLUMN abi TEXT;`);
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
