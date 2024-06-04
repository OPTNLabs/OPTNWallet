import { hexToBin } from "@bitauth/libauth";
import KeyManager from "./KeyManager";
import { WalletInformation } from "../interfaces";
import { createTables } from "../../utils/schema/schema";
import DatabaseService from "../DatabaseManager/DatabaseService";

const KeyManage = KeyManager();

export default function WalletManager() {
    return {
        createInputs,
        createWallet
    };
    async function createWallet (
        wallet_name: string,
        mnemonic: string,
        passphrase: string
    ) : Promise<any | null> {
        
        const dbService = DatabaseService();
        const db = dbService.getDatabase();
        if (!db) {
            return null;
        }

        createTables(db);
        const query = db.prepare(
            "INSERT INTO wallets (wallet_name, mnemonic, passphrase, balance) VALUES (?, ?, ?, ?);"
        );
        query.run([wallet_name, mnemonic, passphrase, 0]);
        query.free();
        await dbService.saveDatabaseToFile();
        return 1;
    }

    function createInputs(inputs: any, compiler) {
        const transactionInputs = inputs.map((input) => ({
            outpointTransactionHash: hexToBin(input.tx_hash),
            outpointIndex: input.tx_pos,
            sequenceNumber: 0,
            unlockingBytecode: {
                compiler,
                script: "unlock",
                valueSatoshis: BigInt(input.value),
                data: {
                    keys: {
                    privateKeys: {
                        key: KeyManage.fetchAddressPrivateKey(input.address),
                },
            },
            },
        },
    }));
    return transactionInputs;
    }
}
