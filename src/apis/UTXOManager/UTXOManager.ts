import { UTXOs } from "../types";
import DatabaseService from "../DatabaseManager/DatabaseService";

export default function UTXOManager(wallet) {
    return {
        storeUTXOs,
        fetchUTXOs,
        getWalletUTXOs
    }

    function getWalletUTXOs() {

    }

    async function fetchUTXOs(amount: number, fee: number, prefix: string, wallet_name: string): Promise<UTXOs[] | null> {
        const dbService = DatabaseService();
        const db = dbService.getDatabase();
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
    

    function storeUTXOs(amount: number, fee: number, prefix: string) {

    }
}