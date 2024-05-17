import DatabaseService from "../DatabaseManager/DatabaseService";
import KeyGeneration from "./KeyGeneration";

export default function KeyManager() {
    const dbService = DatabaseService();
    const KeyGen = KeyGeneration();
    return {
        retrieveKeys,
        createKeys,
    };

    async function retrieveKeys(wallet_name: string): Promise<{ publicKey: string; privateKey: string; addresses: string[] }[]> {
        try {
            await dbService.ensureDatabaseStarted();
            const db = dbService.getDatabase();
            if (db == null) {
                return [];
            }   

            const query = "SELECT public_key, private_key, addresses FROM keys WHERE wallet_name = :walletname";
            const statement = db.prepare(query);
            statement.bind({ ':walletname': wallet_name });

            const result: { publicKey: string; privateKey: string; addresses: string[] }[] = [];

            while (statement.step()) {
                const row = statement.getAsObject();
                result.push({
                    publicKey: row.public_key as string,
                    privateKey: row.private_key as string,
                    addresses: JSON.parse(row.addresses as string)
                });
            }

            statement.free();

            return result;

        } catch (error) {
            console.error("Error retrieving keys:", error);
            throw error;
        }
    }

    async function createKeys(wallet_name: string): Promise<void> {
        try {
            console.log('Testing wallet_name:', wallet_name);
            await dbService.ensureDatabaseStarted();
            const db = dbService.getDatabase();
            if (db == null) {
                return;
            }
            const dbResult = db.exec("SELECT * FROM wallets;");
            console.log("Table testing:", dbResult);

            const walletsQuery = "SELECT wallet_name FROM wallets WHERE wallet_name = :walletname";
            const walletsStmt = db.prepare(walletsQuery);
            walletsStmt.bind({ ':walletname': wallet_name });
            const walletExists = walletsStmt.getAsObject();
            walletsStmt.free();
    
            console.log("Wallet exists check:", walletExists);
    
            if (!walletExists.wallet_name) {
                console.error("Wallet not found with the given name");
                return;
            }
    
            const query = "SELECT mnemonic, passphrase FROM wallets WHERE wallet_name = :walletname";
            const statement = db.prepare(query);
            console.log("Statement before binding:", statement);
            statement.bind({ ':walletname': wallet_name });
            console.log("Statement after binding:", statement);
            const result = statement.getAsObject();
            statement.free();
    
            console.log("Query result:", result);
    
            if (!result.mnemonic || !result.passphrase) {
                console.error("Mnemonic or passphrase not found for the given wallet name");
                return;
            }
    
            // Cast the mnemonic and passphrase to string
            const mnemonic = result.mnemonic as string;
            const passphrase = result.passphrase as string;
    
            // Generate keys using the retrieved mnemonic and passphrase
            const keys = await KeyGen.generateKeys(mnemonic, passphrase);
    
            // Insert the generated keys into the keys table
            const insertQuery = db.prepare(
                "INSERT INTO keys (wallet_name, public_key, private_key, addresses) VALUES (?, ?, ?, ?);"
            );
    
            // Assuming keys is an object with properties alicePub, alicePriv, and aliceAddress
            insertQuery.run([wallet_name, keys.alicePub, keys.alicePriv, JSON.stringify([keys.aliceAddress])]);
            insertQuery.free();
    
            console.log("Keys successfully created and stored in the database.");
        } catch (error) {
            console.error("Error creating keys:", error);
            throw error;
        }
    }
    
}
