import DatabaseService from "../DatabaseManager/DatabaseService"

export default function AddressManager() {
    const dbService = DatabaseService();
    return (
        registerAddress
    )
    async function registerAddress() { 
        dbService.ensureDatabaseStarted();
        const db = dbService.getDatabase();
        if (db == null) {
            return null;
        }
        const registerAddressQuery = db.prepare(`
            INSERT INTO addresses (address, )
        `)
        await dbService.saveDatabaseToFile();
        
    }
}