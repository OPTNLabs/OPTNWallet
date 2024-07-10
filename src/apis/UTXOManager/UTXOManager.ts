// @ts-nocheck
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
        checkNewUTXOs,
        deleteUTXOs
    }

    async function storeUTXOs(UTXOs: UTXOs) {
        const db = dbService.getDatabase();
        if (!db) {
            console.log("Database not started.");
            return null;
        }
        try {
            const query = db.prepare(`
                INSERT INTO UTXOs(wallet_id, address, height, tx_hash, tx_pos, amount, prefix) VALUES (?, ?, ?, ?, ?, ?, ?);
            `);
            query.run([UTXOs.wallet_id, UTXOs.address, UTXOs.height, UTXOs.tx_hash, UTXOs.tx_pos, UTXOs.amount, UTXOs.prefix]);
            query.free();
        } catch (error) {
            console.log(error);
        }
        await dbService.saveDatabaseToFile();
    }

    async function fetchUTXOs(wallet_id: number): Promise<UTXOs[] | null> {
        const db = dbService.getDatabase();
        if (!db) {
            console.log("Database not started.");
            return null;
        }

        const query = "SELECT id, wallet_id, address, height, tx_hash, tx_pos, amount, prefix FROM UTXOs WHERE wallet_id = :walletid";
        const statement = db.prepare(query);
        statement.bind({ ':walletid': wallet_id });

        const result: UTXOs[] = [];

        while (statement.step()) {
            const row = statement.getAsObject();
            console.log('row', row);
            result.push({
                id: row.id as number,
                wallet_id: row.wallet_id as number,
                address: row.address as string,
                height: row.height as number,
                tx_hash: row.tx_hash as string,
                tx_pos: row.tx_pos as number,
                amount: row.amount as number,
                prefix: row.prefix as string
            });
        }
        statement.free();

        console.log('UTXOs:', result);

        return result;
    }

    async function deleteUTXOs(wallet_id: number, utxos: UTXOs[]) {
        const db = dbService.getDatabase();
        if (!db) {
            console.log("Database not started.");
            return;
        }
        try {
            const query = db.prepare(`
                DELETE FROM UTXOs WHERE wallet_id = ? AND tx_hash = ? AND tx_pos = ? AND address = ?;
            `);
            for (const utxo of utxos) {
                query.run([wallet_id, utxo.tx_hash, utxo.tx_pos, utxo.address]);
            }
            query.free();
        } catch (error) {
            console.log("Error deleting UTXOs:", error);
        }
        await dbService.saveDatabaseToFile();
    }

    async function checkNewUTXOs(wallet_id: number) {
        const db = dbService.getDatabase();
        if (!db) {
            console.log("Database not started.");
            return null;
        }
        const query = "SELECT * FROM addresses WHERE wallet_id = :walletid";
        const statement = db.prepare(query);
        statement.bind({ ":walletid" : wallet_id });

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
                console.log(`${address.address} UTXOS: `, fetchedUTXOs);

                // Fetch existing UTXOs for the address from the database
                const existingUTXOs = (await fetchUTXOs(wallet_id)).filter(utxo => utxo.address === address.address);
                
                // Determine UTXOs to be deleted (existing ones not in fetchedUTXOs)
                const fetchedUTXOKeys = new Set(fetchedUTXOs.map(utxo => `${utxo.tx_hash}-${utxo.tx_pos}`));
                const utxosToDelete = existingUTXOs.filter(utxo => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`));

                // Delete outdated UTXOs
                await deleteUTXOs(wallet_id, utxosToDelete);

                // Store new UTXOs
                for (const utxo of fetchedUTXOs) {
                    const newUTXO: UTXOs = {
                        wallet_id: wallet_id,
                        address: address.address,
                        height: utxo.height,
                        tx_hash: utxo.tx_hash,
                        tx_pos: utxo.tx_pos,
                        amount: utxo.value,
                        prefix: "bchtest"
                    };
                    await storeUTXOs(newUTXO);
                }
            } catch (error) {
                console.error(`Error fetching or storing UTXOs for address ${address.address}:`, error);
            }
        }
    }
}
