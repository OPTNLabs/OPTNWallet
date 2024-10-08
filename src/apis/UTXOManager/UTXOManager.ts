import DatabaseService from '../DatabaseManager/DatabaseService';
import { UTXO } from '../../types/types';

export default function UTXOManager() {
  const dbService = DatabaseService();

  return {
    storeUTXOs,
    fetchUTXOsByAddress,
    deleteUTXOs,
    fetchAddressesByWalletId,
  };

  // Store UTXOs in the database
  async function storeUTXOs(utxos: UTXO[]): Promise<void> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return;
    }
    try {
      const query = db.prepare(`
        INSERT INTO UTXOs(wallet_id, address, height, tx_hash, tx_pos, amount, prefix, token_data) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const utxo of utxos) {
        const existsQuery = db.prepare(`
          SELECT COUNT(*) AS count FROM UTXOs WHERE wallet_id = ? AND tx_hash = ? AND tx_pos = ?;
        `);
        existsQuery.bind([utxo.wallet_id, utxo.tx_hash, utxo.tx_pos]);

        if (existsQuery.step() && existsQuery.getAsObject().count === 0) {
          query.run([
            utxo.wallet_id,
            utxo.address,
            utxo.height || 0,
            utxo.tx_hash,
            utxo.tx_pos,
            utxo.value,
            utxo.prefix || 'unknown',
            utxo.token_data ? JSON.stringify(utxo.token_data) : null,
          ]);
          console.log(`Stored UTXO: ${JSON.stringify(utxo)}`);
        }
        existsQuery.free();
      }
      query.free();
    } catch (error) {
      console.log('Error storing UTXOs:', error);
    }
    await dbService.saveDatabaseToFile();
  }

  // Fetch UTXOs from the database by address
  async function fetchUTXOsByAddress(
    walletId: number,
    address: string
  ): Promise<UTXO[]> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      console.error('Database not started.');
      return [];
    }

    try {
      const storedUTXOsQuery = db.prepare(`
        SELECT * FROM UTXOs WHERE wallet_id = ? AND address = ?;
      `);
      storedUTXOsQuery.bind([walletId, address]);

      const storedUTXOs: UTXO[] = [];
      while (storedUTXOsQuery.step()) {
        const result = storedUTXOsQuery.getAsObject();

        if (typeof result.token_data === 'string') {
          result.token_data = JSON.parse(result.token_data);
        } else {
          result.token_data = null;
        }

        storedUTXOs.push(result as unknown as UTXO);
      }
      storedUTXOsQuery.free();

      return storedUTXOs;
    } catch (error) {
      console.error(`Error fetching UTXOs for address ${address}:`, error);
      return [];
    }
  }

  // Delete UTXOs from the database
  async function deleteUTXOs(walletId: number, utxos: UTXO[]): Promise<void> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return;
    }
    try {
      const query = db.prepare(`
        DELETE FROM UTXOs WHERE wallet_id = ? AND tx_hash = ? AND tx_pos = ? AND address = ?;
      `);
      for (const utxo of utxos) {
        query.run([walletId, utxo.tx_hash, utxo.tx_pos, utxo.address]);
      }
      query.free();
    } catch (error) {
      console.log('Error deleting UTXOs:', error);
    }
    await dbService.saveDatabaseToFile();
  }

  // New method to fetch addresses by wallet_id
  async function fetchAddressesByWalletId(
    walletId: number
  ): Promise<{ address: string }[]> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();
    if (!db) {
      throw new Error('Database not started.');
    }

    const query = 'SELECT address FROM addresses WHERE wallet_id = :walletid';
    const statement = db.prepare(query);
    statement.bind({ ':walletid': walletId });

    const addresses: { address: string }[] = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      addresses.push({ address: row.address as string });
    }
    statement.free();

    return addresses;
  }
}
