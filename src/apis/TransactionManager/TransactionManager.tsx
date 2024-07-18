import DatabaseService from '../DatabaseManager/DatabaseService';
// import { Transaction } from "../types";

export default function TransactionManager() {
  const dbService = DatabaseService();
  return {
    fetchTransactionHistory,
    saveCompletedTransaction,
  };
  async function fetchTransactionHistory() {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (db == null) {
      return null;
    }
    const query = 'SELECT * from transactions';
    db.prepare(query);
  }

  async function saveCompletedTransaction() {}
}
