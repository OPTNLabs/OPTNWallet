import DatabaseService from "../DatabaseManager/DatabaseService";
import { Address } from "../types";

export default function AddressManager() {
  const dbService = DatabaseService();

  async function registerAddress (address: Address): Promise<void>  {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db != null) {
        const registerAddressQuery = db.prepare(`
          INSERT INTO addresses (wallet_name, address, balance, hd_index, change_index) VALUES (?, ?, ?, ?, ?)
        `);

        registerAddressQuery.run([
          address.wallet_name,
          address.address,
          address.balance,
          address.hd_index,
          address.change_index
        ]);

        registerAddressQuery.free();
      } else {
        console.error("Database instance is null.");
      }
    } catch (error) {
      console.error("Failed to register address:", error);
    }
  };

  return {
    registerAddress
  }
}
