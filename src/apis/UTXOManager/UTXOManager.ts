import { UTXOs } from "../types";
import DatabaseService from "../DatabaseManager/DatabaseService";
import ElectrumService from "../ElectrumServer/ElectrumServer";


export default async function UTXOManager() {
    const dbService = DatabaseService();
    await dbService.ensureDatabaseStarted();
    const Electrum = ElectrumService();

    return {
        storeUTXOs,
        fetchUTXOs,
        checkNewUTXOs
    }

    // store utxos
    async function storeUTXOs(wallet_name: string, UTXOs : UTXOs) {
        console.log("storing", UTXOs)
        const db = dbService.getDatabase()
        if (!db) {
            console.log("Database not started.");
            return null;
        }
        try {
        const query = db.prepare(`
            INSERT INTO UTXOs(wallet_name, address, height, tx_hash, tx_pos, amount, prefix) VALUES (?, ?, ?, ?, ?, ?, ?);
        `)
        query.run([UTXOs.wallet_name, UTXOs.address, UTXOs.height, UTXOs.tx_hash, UTXOs.tx_pos, UTXOs.amount, UTXOs.prefix]);
        query.free();
        } catch(error) {
            console.log(error)
        }
        await dbService.saveDatabaseToFile;
    }

    async function fetchUTXOs(amount: number, fee: number, prefix: string, wallet_name: string): Promise<UTXOs[] | null> {
        const db = dbService.getDatabase()
        if (!db) {
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

    async function checkNewUTXOs(wallet_name: string) {
        console.log('checking');
        const db = dbService.getDatabase();
        if (!db) {
            console.log("Database not started.");
            return null;
        }
        const query = "SELECT * FROM addresses";
        const statement = db.prepare(query);

        const queriedAddresses: { address: string }[] = [];

        while (statement.step()) {
            const row = statement.getAsObject();
            queriedAddresses.push({
                address: row.address as string
            });
        }

        statement.free();
        for (const address of queriedAddresses) {
            try {

                const fetchedUTXOs = await Electrum.getUTXOS(address.address);
                for (const utxo of fetchedUTXOs) {
                    const newUTXO: UTXOs = {
                        wallet_name: wallet_name,
                        address: address.address,
                        height: utxo.height,
                        tx_hash: utxo.tx_hash,
                        tx_pos: utxo.tx_pos,
                        amount: utxo.value,
                        prefix: "BCH"
                    };
                    await storeUTXOs(wallet_name, newUTXO);

                }
            } catch (error) {
                console.error(`Error fetching or storing UTXOs for address ${address}:`, error);
            }
        }
    }
}