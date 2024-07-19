// src/apis/DatabaseManager/DatabaseService.ts
import initSqlJs, { Database } from 'sql.js';
import { createTables } from '../../utils/schema/schema';

const SQL = initSqlJs({
  locateFile: (file) => `https://sql.js.org/dist/${file}`,
});
let db: Database | null = null;

export default function DatabaseService() {
  return {
    startDatabase,
    saveDatabaseToFile,
    ensureDatabaseStarted,
    getDatabase,
    clearDatabase,
    resultToJSON,
  };

  async function startDatabase(): Promise<any> {
    const SQLModule = await SQL;
    const savedDb = localStorage.getItem('OPTNDatabase');
    if (savedDb) {
      const fileBuffer = new Uint8Array(JSON.parse(savedDb));
      db = new SQLModule.Database(fileBuffer);
    } else {
      db = new SQLModule.Database();
      createTables(db); // Ensure the schema is created if no saved DB exists
    }
    await updateSchema(db); // Ensure schema is updated
    return db;
  }

  async function ensureDatabaseStarted(): Promise<void> {
    if (!db) {
      await startDatabase();
    }
  }

  async function saveDatabaseToFile(): Promise<void> {
    await ensureDatabaseStarted();
    if (!db) {
      console.log('Database not started.');
      return;
    }

    const data = db.export();
    localStorage.setItem('OPTNDatabase', JSON.stringify(Array.from(data)));
    // console.log(`Database saved to local storage`);
  }

  function getDatabase(): Database | null {
    return db;
  }

  async function clearDatabase(): Promise<void> {
    await ensureDatabaseStarted();
    if (db) {
      db.exec('VACUUM;'); // Ensure all changes are committed
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
      createTables(db); // Recreate empty tables after dropping
      await saveDatabaseToFile(); // Save changes to local storage
    }
  }

  async function updateSchema(db: Database): Promise<void> {
    const result = db.exec(`
      PRAGMA table_info(instantiated_contracts);
    `);
    const columns = result[0].values.map((row) => row[1]);
    if (!columns.includes('abi')) {
      db.run(`
        ALTER TABLE instantiated_contracts ADD COLUMN abi TEXT;
      `);
    }
  }

  function resultToJSON(result: any) {
    if (!result || result.length === 0) {
      return {};
    }

    // Assuming the result is an array with two elements: mnemonic and passphrase
    const obj = {
      mnemonic: result[0],
      passphrase: result[1] || '',
    };

    return obj;
  }
}
