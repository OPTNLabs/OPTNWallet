import DatabaseService from "../DatabaseManager/DatabaseService";
import KeyGeneration from "./KeyGeneration";
import AddressManager from "../AddressManager/AddressManager";
import { Address } from "../types";

export default function KeyManager() {
    const dbService = DatabaseService();
    const KeyGen = KeyGeneration();
    const ManageAddress = AddressManager();

    return {
        retrieveKeys,
        createKeys,
        fetchAddressPrivateKey,
    };

    async function retrieveKeys(wallet_name: string): Promise<{ id: number, publicKey: Uint8Array; privateKey: Uint8Array; address: string }[]> {
        try {
            await dbService.ensureDatabaseStarted();
            const db = dbService.getDatabase();
            if (db == null) {
                return [];
            }

            const query = "SELECT id, public_key, private_key, address FROM keys WHERE wallet_name = :walletname";
            const statement = db.prepare(query);
            statement.bind({ ':walletname': wallet_name });

            const result: { id: number, publicKey: Uint8Array, privateKey: Uint8Array, address: string }[] = [];

            while (statement.step()) {
                const row = statement.getAsObject();
                console.log('row', row)
                result.push({
                    id: row.id as number,
                    publicKey: new Uint8Array(row.public_key),
                    privateKey: new Uint8Array(row.private_key),
                    address: row.address as string
                });
            }

            statement.free();
            return result;

        } catch (error) {
            console.error("Error retrieving keys:", error);
            throw error;
        }
    }

    async function createKeys(wallet_name: string, keyNumber: number): Promise<void> {
        try {
            await dbService.ensureDatabaseStarted();
            const db = dbService.getDatabase();
            if (db == null) {
                return;
            }

            const getIdQuery = db.prepare(
                "SELECT mnemonic, passphrase FROM wallets WHERE wallet_name = ?;"
            );
            const result = getIdQuery.get([wallet_name]);
            getIdQuery.free();

            if (!result) {
                console.error("Mnemonic or passphrase not found for the given wallet name");
                return;
            }
            const mnemonic = JSON.stringify(result[0])
            const passphrase = JSON.stringify(result[1])

            const keys = await KeyGen.generateKeys(mnemonic, passphrase, keyNumber);

            if (keys) {
                const publicKey = keys.alicePub;
                const privateKey = keys.alicePriv;
                const address = keys.aliceAddress;

                const insertQuery = db.prepare(
                    "INSERT INTO keys (wallet_name, public_key, private_key, address) VALUES (?, ?, ?, ?);"
                );
                insertQuery.run([wallet_name, publicKey, privateKey, address]);
                insertQuery.free();
                const newAddress : Address = {
                    wallet_name : wallet_name,
                    address : keys.aliceAddress,
                    balance : 0,
                    hd_index: keyNumber,
                    change_index: 0
                }
                await ManageAddress.registerAddress(newAddress);
                await dbService.saveDatabaseToFile();
                const query = "SELECT * FROM addresses";
                const statement = db.prepare(query);
                statement.free();
            }
        } catch (error) {
            console.error("Error creating keys:", error);
            throw error;
        }
    }

    function fetchAddressPrivateKey(address : string) {
        dbService.ensureDatabaseStarted();
        const db = dbService.getDatabase();
        if (db == null) {
            return null;
        }
        const fetchAddressQuery = db.prepare(
            "SELECT private_key FROM keys WHERE address = ?;"
        );
        const result = fetchAddressQuery.get([address]);
        fetchAddressQuery.free();
        return result;
    }
}
