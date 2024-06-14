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

    async function storeUTXOs(UTXOs : UTXOs) {
        console.log("storing", UTXOs)
        const db = dbService.getDatabase()
        if (!db) {
            console.log("Database not started.");
            return null;
        }
        try {
        const query = db.prepare(`
            INSERT INTO UTXOs(wallet_name, address, height, tx_hash, tx_pos, amount, prefix, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `)
        query.run([UTXOs.wallet_name, UTXOs.address, UTXOs.height, UTXOs.tx_hash, UTXOs.tx_pos, UTXOs.amount, UTXOs.prefix, UTXOs.private_key]);
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
        console.log('trnasacitonamount', transactionAmount);
        const query = "SELECT id, wallet_name, address, height, tx_hash, tx_pos, amount, prefix, private_key FROM UTXOs WHERE wallet_name = :walletname";
        const statement = db.prepare(query);
        statement.bind({ ':walletname': wallet_name });

        const result: { id: number, wallet_name: string, address: string, height: number, tx_hash: string, tx_pos: number, amount: number, prefix: string, privateKey: Uint8Array }[] = [];

        while (statement.step()) {
            const row = statement.getAsObject();
            console.log('row', row);
            result.push({
                id: row.id as number,
                wallet_name: row.wallet_name as string,
                address: row.address as string,
                height: row.height as number,
                tx_hash: row.tx_hash as string,
                tx_pos: row.tx_pos as number,
                amount: row.amount as number,
                prefix: row.prefix as string,
                privateKey: new Uint8Array(row.private_key)
            });
        }

        // Use the result array as needed
        console.log('UTXOs:', result);

        const possibleUTXOs = dbService.resultToJSON(
            db.exec(
                `SELECT * FROM UTXOs 
                  WHERE wallet_name="${wallet_name}"
                  ORDER BY amount DESC;`
            )
        );
    
        // exact same amount as utxos
        const exactUTXOs = possibleUTXOs.filter(
            (utxo: UTXOs) => utxo.amount === transactionAmount
        );
        if (exactUTXOs.length > 0) {
            return [exactUTXOs[0]];
        }
    
        let possibleUTXOSum = 0;
        let returnUTXOs: UTXOs[] = [];
        
        console.log('harharhar', possibleUTXOs.length);
    
        for (let i = 0; i < possibleUTXOs.length; ++i) {
            console.log(possibleUTXOs[i].amount);
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
                    const pk_query = db.prepare("SELECT private_key FROM keys WHERE address = ?;");
                    const result = pk_query.get([address.address]);
                    pk_query.free();
                    console.log('hawwo')
                    console.log("private key", result[0]);
                    const newUTXO: UTXOs = {
                        wallet_name: wallet_name,
                        address: address.address,
                        height: utxo.height,
                        tx_hash: utxo.tx_hash,
                        tx_pos: utxo.tx_pos,
                        amount: utxo.value,
                        prefix: "BCH",
                        private_key : result[0]
                    };
                    await storeUTXOs(newUTXO);

                }
            } catch (error) {
                console.error(`Error fetching or storing UTXOs for address ${address}:`, error);
            }
        }
    }
}