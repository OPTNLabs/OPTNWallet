import DatabaseService from '../DatabaseManager/DatabaseService';
import { TransactionHistoryItem } from '../../types/types'; // Assuming TransactionHistoryItem is defined in the types file
import ElectrumService from '../../services/ElectrumService';

export default function TransactionManager() {
  const dbService = DatabaseService();

  // Define the function with proper return type and parameter types
  async function fetchAndStoreTransactionHistory(
    walletId: string,
    address: string
  ): Promise<void> {
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Could not get database');
    }

    try {
      // Fetch transaction history using Electrum service
      const history: TransactionHistoryItem[] =
        await ElectrumService.getTransactionHistory(address);

      // Check if history is an array
      if (!Array.isArray(history)) {
        throw new Error('Invalid transaction history format');
      }

      const timestamp = new Date().toISOString();

      // Start a database transaction
      db.exec('BEGIN TRANSACTION');

      for (const tx of history) {
        console.log('TX:', tx);

        // Query for existing transactions by wallet_id and tx_hash
        const existingTransaction = db.exec(`
          SELECT tx_hash, height FROM transactions WHERE wallet_id = ${walletId} AND tx_hash = '${tx.tx_hash}'
        `);

        if (existingTransaction.length > 0) {
          // Get the existing height
          const existingHeight = existingTransaction[0].values[0][1] as number;

          // Update the transaction if needed
          if (
            existingHeight === -1 ||
            existingHeight === 0 ||
            existingHeight !== tx.height
          ) {
            db.exec(`
              UPDATE transactions SET height = ${tx.height}, timestamp = '${timestamp}' WHERE wallet_id = ${walletId} AND tx_hash = '${tx.tx_hash}'
            `);
          }
        } else {
          // Insert the transaction if it doesn't already exist
          db.exec(`
            INSERT OR IGNORE INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
            VALUES (${walletId}, '${tx.tx_hash}', ${tx.height}, '${timestamp}', 0)
          `);
        }
      }

      // Commit the transaction after processing
      db.exec('COMMIT');

      console.log(
        `Fetched and stored transaction history for address ${address}`
      );
    } catch (error) {
      // Rollback the transaction in case of errors
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
