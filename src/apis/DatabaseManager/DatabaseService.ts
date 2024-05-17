import initSqlJs, { Database } from 'sql.js';

const SQL = initSqlJs({
    locateFile: file => `https://sql.js.org/dist/${file}`
});
let db : Database | null = null;
export default function DatabaseService() {
    
    return {
        startDatabase,
        createWallet,
    }
    async function startDatabase() : Promise<any> {
        const SQLModule = await SQL;
        db = new SQLModule.Database();
        return db;
    }

    async function createWallet(walletName : string, mnemonic : string, passphrase : string) : Promise<any> {
        await ensureDatabaseStarted();
        if (!db) {
            console.log("Database not started.");
            return;
        }

        //Creates table in the case that it doesn't exist
        db.run("CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, wallet_name VARCHAR(255), mnemonic VARCHAR(255), passphrase VARCHAR(255));");

        //Prepares query for mnemonic and passphrase
        const query = db.prepare("INSERT INTO wallets (wallet_name, mnemonic, passphrase) VALUES (?, ?, ?);");
        query.run([walletName, mnemonic, passphrase]);
        query.free();
        const result = db.exec("SELECT * FROM wallets;");
        return result;
    }

    async function ensureDatabaseStarted(): Promise<void> {
        if (!db) {
            await startDatabase();
        }
    }
}