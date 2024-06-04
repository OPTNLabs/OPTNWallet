import { UTXOs } from "../types";
import DatabaseService from "../DatabaseManager/DatabaseService";

export default function UTXOManager(wallet : WalletEntity) {
    return {
        storeUTXOs,
        fetchUTXOs,
        getWalletUTXOs
    }

    function getWalletUTXOs() {

    }
    async function fetchUTXOs(amount : number, fee : number, prefix: string, ) : Promise<UTXOs[]|null> {
        const dbService = DatabaseService();
        const db = dbService.getDatabase();
        const transactionAmount = amount + fee;
        const exactAddresses = dbService.resultToJSON(
            db.exec(
                `SELECT * FROM address_utxos 
                  WHERE 
                    amount <= "${transactionAmount}}" 
                    AND wallet_id="${}" 
                    AND prefix="${prefix}"
                  ORDER BY amount DESC`
              )
        )
        return 
    }
    function storeUTXOs() {

    }
}