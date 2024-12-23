import initSqlJs, { Database } from 'sql.js';
import { createTables } from '../../utils/schema/schema';

// Define the type for the DB variable
let db: Database | null = null;

const startDatabase = async (): Promise<Database | null> => {
  try {
    // console.log('Initializing SQL.js...');
    const SQLModule = await initSqlJs({
      locateFile: () => `/sql-wasm.wasm`,
    });
    // console.log('SQL.js initialized.');

    const savedDb = localStorage.getItem('OPTNDatabase');
    if (savedDb) {
      // console.log('Loading saved database...');
      const fileBuffer = new Uint8Array(JSON.parse(savedDb));
      db = new SQLModule.Database(fileBuffer);
      // console.log('Saved database loaded.');
    } else {
      // console.log('Creating new database...');
      db = new SQLModule.Database();
      createTables(db); // Ensure the schema is created if no saved DB exists
      // console.log('New database created.');
    }

    await updateSchema(db); // Ensure schema is updated
    // console.log('Database started.');
    return db;
  } catch (error) {
    console.error('Error starting database:', error);
    throw error;
  }
};

const ensureDatabaseStarted = async (): Promise<void> => {
  if (!db) {
    await startDatabase();
  }
};

const saveDatabaseToFile = async (): Promise<void> => {
  await ensureDatabaseStarted();
  if (!db) {
    console.error('Database not started.');
    return;
  }

  const data = db.export();
  localStorage.setItem('OPTNDatabase', JSON.stringify(Array.from(data)));
  // console.log('Database saved to local storage');
};

const getDatabase = (): Database | null => db;

const clearDatabase = async (): Promise<void> => {
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
};

const updateSchema = async (db: Database): Promise<void> => {
  const result = db.exec(`
    PRAGMA table_info(instantiated_contracts);
  `);

  const columns = result[0].values.map((row) => row[1] as string);
  if (!columns.includes('abi')) {
    db.run(`
      ALTER TABLE instantiated_contracts ADD COLUMN abi TEXT;
    `);
  }
};

// Typing the resultToJSON function, ensuring proper return types
const resultToJSON = (
  result: (string | undefined)[]
): { mnemonic: string; passphrase: string } => {
  if (!result || result.length === 0) {
    return { mnemonic: '', passphrase: '' };
  }

  const obj = {
    mnemonic: result[0] as string,
    passphrase: result[1] ? (result[1] as string) : '',
  };

  return obj;
};

export default function DatabaseService() {
  return {
    startDatabase,
    saveDatabaseToFile,
    ensureDatabaseStarted,
    getDatabase,
    clearDatabase,
    resultToJSON,
  };
}
