import initSqlJs, { Database } from 'sql.js';

const SQL = initSqlJs({
    locateFile: file => `https://sql.js.org/dist/${file}`
});
let db: Database | null = null;

export default function DatabaseService() {
    
    return {
        startDatabase,
        createWallet,
        saveDatabaseToFile,
        ensureDatabaseStarted,
        getDatabase,
    }

    async function startDatabase(): Promise<any> {
        const SQLModule = await SQL;
        const savedDb = localStorage.getItem('OPTNDatabase');
        if (savedDb) {
            const fileBuffer = new Uint8Array(JSON.parse(savedDb));
            db = new SQLModule.Database(fileBuffer);
        } else {
            db = new SQLModule.Database();
        }
        return db;
    }

    async function createWallet(walletName: string, mnemonic: string, passphrase: string): Promise<any> {
        await ensureDatabaseStarted();
        if (!db) {
            console.log("Database not started.");
            return;
        }
    
        db.run("CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, wallet_name VARCHAR(255), mnemonic VARCHAR(255), passphrase VARCHAR(255));");
    
        const query = db.prepare("INSERT INTO wallets (wallet_name, mnemonic, passphrase) VALUES (?, ?, ?);");
        query.run([walletName, mnemonic, passphrase]);
        query.free();

        const getIdQuery = db.prepare("SELECT wallet_name FROM wallets WHERE wallet_name = ?;");
        const result = getIdQuery.get([walletName]);
        getIdQuery.free();
    
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
        localStorage.setItem('OPTNDatabase', JSON.stringify(Array.from(data)));
        console.log(`Database saved to local storage`);
    }

    function getDatabase(): Database | null {
        return db;
    }
}
