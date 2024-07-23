// src/apis/TransactionManager/TransactionManager.ts
import ElectrumService from '../ElectrumServer/ElectrumServer';
import DatabaseService from '../DatabaseManager/DatabaseService';

export default function TransactionManager() {
  const electrumService = ElectrumService();
  const dbService = DatabaseService();

  async function fetchAndStoreTransactionHistory(
    walletId: string,
    address: string
  ) {
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Could not get database');
    }
    try {
      const history = await electrumService.getTransactionHistory(address);

      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();
      db.exec('BEGIN TRANSACTION');
      for (const tx of history) {
        console.log('TX:', tx);
        db.exec(`
          INSERT OR IGNORE INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
          VALUES (${walletId}, '${tx.tx_hash}', ${tx.height}, '${timestamp}', 0)
        `);
      }
      db.exec('COMMIT');
      console.log(
        `Fetched and stored transaction history for address ${address}`
      );
    } catch (error) {
      db.exec('ROLLBACK');
      console.error(
        `Failed to fetch and store transaction history for address ${address}:`,
        error
      );
    }
  }

  return {
    fetchAndStoreTransactionHistory,
  };
}
