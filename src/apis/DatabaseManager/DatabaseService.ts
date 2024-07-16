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

  function resultToJSON(result: any) {
    if (result.length === 0) {
      return result;
    }

    const mapped = result[0].values.map((val) =>
      result[0].columns.map((col, j) => ({ [result[0].columns[j]]: val[j] }))
    );

    const reduced = mapped.map((m) =>
      m.reduce((acc, cur) => ({ ...acc, ...cur }), {})
    );
    return reduced;
  }
}
