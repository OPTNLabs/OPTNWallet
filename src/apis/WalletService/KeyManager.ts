import DatabaseService from "../DatabaseManager/DatabaseService";



export default function KeyManager() {
    const dbService = DatabaseService();
    return {
        retrieveKeys,
    }

    async function retrieveKeys(wallet_id : string ):  Promise<{ publicKey: string; privateKey: string; addresses : [] }[]>{
        await dbService.ensureDatabaseStarted();
        const db = dbService.getDatabase();
        if (db == null) {
            return []
        }
        const query = `SELECT public_key, private_key, addresses, FROM keys WHERE wallet_id = ?`;
    }
    async function createKeys(wallet_id : string): Promise<void> {

    }
}