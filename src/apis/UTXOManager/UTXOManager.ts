import { UTXOs } from "../types";
import DatabaseService, { dbStart } from "../DatabaseManager/DatabaseService";


export default async function UTXOManager() {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();

    return {
        storeUTXOs,
        fetchUTXOs
    }

    // store utxos
    async function storeUTXOs(UTXOs : UTXOs) {
        const db = dbService.getDatabase()
        if (!db && db == null) {
            console.log("Database not started.");
            return null;
        }
        const query = db.prepare(`
            INSERT INTO UTXOs(wallet_name, address, height, tx_hash, tx_pos, amount, prefix) VALUES (?, ?, ?, ?, ?, ?, ?);
        `)
        query.run([UTXOs.wallet_name, UTXOs.address, UTXOs.height, UTXOs.tx_hash, UTXOs.tx_pos, UTXOs.amount, UTXOs.prefix]);
        query.free();
        await dbService.saveDatabaseToFile;
    }

    async function fetchUTXOs(amount: number, fee: number, prefix: string, wallet_name: string): Promise<UTXOs[] | null> {
        const db = dbService.getDatabase()
        if (!db && db == null) {
            console.log("Database not started.");
            return null;
        }
        const transactionAmount = amount + fee;
    
        const possibleUTXOs = dbService.resultToJSON(
            db.exec(
                `SELECT * FROM UTXOs 
                  WHERE 
                    amount <= "${transactionAmount}" 
                    AND wallet_name="${wallet_name}" 
                    AND prefix="${prefix}"
                  ORDER BY amount DESC`
            )
        );
    
        // condition 1: exact same amount as utxos
        const exactUTXOs = possibleUTXOs.filter(
            (utxo: UTXOs) => utxo.amount === transactionAmount
        );
        if (exactUTXOs.length > 0) {
            return [exactUTXOs[0]];
        }
    
        let possibleUTXOSum = 0;
        let returnUTXOs: UTXOs[] = [];
    
        for (let i = 0; i < possibleUTXOs.length; ++i) {
            possibleUTXOSum += possibleUTXOs[i].amount;
            returnUTXOs.push(possibleUTXOs[i]);
            if (possibleUTXOSum >= transactionAmount) {
                return returnUTXOs;
            }
        }
    
        console.log("Insufficient UTXOs to cover the transaction amount.");
        return null;
    }
}