import initSqlJs, { Database } from "sql.js";
import { createTables } from "../../utils/schema/schema";

const SQL = initSqlJs({
  locateFile: (file) => `https://sql.js.org/dist/${file}`,
});
let db: Database | null = null;

export default function DatabaseService() {
  return {
    startDatabase,
    createWallet,
    saveDatabaseToFile,
    ensureDatabaseStarted,
    getDatabase,
    resultToJSON
  };

  async function startDatabase(): Promise<any> {
    const SQLModule = await SQL;
    const savedDb = localStorage.getItem("OPTNDatabase");
    if (savedDb) {
      const fileBuffer = new Uint8Array(JSON.parse(savedDb));
      db = new SQLModule.Database(fileBuffer);
    } else {
      db = new SQLModule.Database();
    }
    return db;
  }

  async function createWallet(
    walletName: string,
    mnemonic: string,
    passphrase: string
  ): Promise<any> {
    await ensureDatabaseStarted();
    if (!db) {
      console.log("Database not started.");
      return;

    }

    createTables(db);

    // const insertKeyQuery = db.prepare("INSERT INTO keys_and_addresses (wallet_id, public_key, private_key, addresses) VALUES (?, ?, ?, ?);");
    // insertKeyQuery.run([walletId, publicKey, privateKey, JSON.stringify(addresses)]);
    // insertKeyQuery.free();
    const query = db.prepare(
      "INSERT INTO wallets (wallet_name, mnemonic, passphrase) VALUES (?, ?, ?);"
    );
    query.run([walletName, mnemonic, passphrase]);
    query.free();

    const dbResult = db.exec("SELECT * FROM wallets;");
    await saveDatabaseToFile();

    return { id: result, result: dbResult };
  }

  async function ensureDatabaseStarted(): Promise<void> {
    if (!db) {
      await startDatabase();
    }
  }

  async function saveDatabaseToFile(): Promise<void> {
    await ensureDatabaseStarted();
    if (!db) {
      console.log("Database not started.");
      return;
    }

    const data = db.export();
    localStorage.setItem("OPTNDatabase", JSON.stringify(Array.from(data)));
    console.log(`Database saved to local storage`);
  }

  function getDatabase(): Database | null {
    return db;
  }

  function resultToJSON(result : any) {
    if (result.length === 0) {
      return result;
    }

    const mapped = result[0].values.map((val) =>
      result[0].columns.map((col, j) => ({ [result[0].columns[j]]: val[j] }))
    );

    const reduced = mapped.map((m) =>
      m.reduce((acc, cur) => ({ ...acc, ...cur }), {})
    );
    return reduced
  }
}
