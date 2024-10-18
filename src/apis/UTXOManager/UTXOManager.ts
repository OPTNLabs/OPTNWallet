import DatabaseService from '../DatabaseManager/DatabaseService';
import { Network } from '../../redux/networkSlice';
import { store } from '../../redux/store';
import { UTXO } from '../../types/types';

export default function UTXOManager() {
  const dbService = DatabaseService();
  const state = store.getState();
  const prefix =
    state.network.currentNetwork === Network.MAINNET
      ? 'bitcoincash'
      : 'bchtest';

  return {
    storeUTXOs,
    fetchUTXOsByAddress,
    deleteUTXOs,
    fetchAddressesByWalletId,
    fetchUTXOsFromDatabase,
  };

  // Store UTXOs in the database
  async function storeUTXOs(utxos: UTXO[]): Promise<void> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      const insertQuery = db.prepare(`
        INSERT INTO UTXOs(wallet_id, address, height, tx_hash, tx_pos, amount, prefix, token_data) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `);

      for (const utxo of utxos) {
        const existsQuery = db.prepare(`
          SELECT COUNT(*) AS count FROM UTXOs WHERE wallet_id = ? AND tx_hash = ? AND tx_pos = ?;
        `);
        existsQuery.bind([utxo.wallet_id, utxo.tx_hash, utxo.tx_pos]);

        if (existsQuery.step() && existsQuery.getAsObject().count === 0) {
          insertQuery.run([
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
      insertQuery.free();
      await dbService.saveDatabaseToFile();
    } catch (error) {
      console.error('Error storing UTXOs:', error);
    }
  }

  // Fetch UTXOs from the database by address
  async function fetchUTXOsByAddress(
    walletId: number,
    address: string
  ): Promise<UTXO[]> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      const query = db.prepare(`
        SELECT * FROM UTXOs WHERE wallet_id = ? AND address = ?;
      `);
      query.bind([walletId, address]);

      const utxos: UTXO[] = [];
      while (query.step()) {
        const result = query.getAsObject();
        result.token_data =
          typeof result.token_data === 'string'
            ? JSON.parse(result.token_data)
            : null;
        utxos.push(result as UTXO);
      }
      query.free();

      return utxos;
    } catch (error) {
      console.error(`Error fetching UTXOs for ${address}:`, error);
      return [];
    }
  }

  // Delete UTXOs from the database
  async function deleteUTXOs(walletId: number, utxos: UTXO[]): Promise<void> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      db.exec('BEGIN TRANSACTION;');

      const query = db.prepare(`
        DELETE FROM UTXOs WHERE wallet_id = ? AND tx_hash = ? AND tx_pos = ? AND address = ?;
      `);

      for (const utxo of utxos) {
        query.run([walletId, utxo.tx_hash, utxo.tx_pos, utxo.address]);
      }

      query.free();
      db.exec('COMMIT;');
      await dbService.saveDatabaseToFile();
    } catch (error) {
      console.error('Error deleting UTXOs:', error);
      db.exec('ROLLBACK;'); // Rollback in case of failure
    }
  }

  // Fetch addresses by wallet ID from the database
  async function fetchAddressesByWalletId(
    walletId: number
  ): Promise<{ address: string }[]> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      const query = db.prepare(
        'SELECT address FROM addresses WHERE wallet_id = ?'
      );
      query.bind([walletId]);

      const addresses: { address: string }[] = [];
      while (query.step()) {
        addresses.push(query.getAsObject() as { address: string });
      }
      query.free();

      return addresses;
    } catch (error) {
      console.error('Error fetching addresses:', error);
      return [];
    }
  }

  // Fetch UTXOs from the database for multiple addresses
  async function fetchUTXOsFromDatabase(keyPairs) {
    const utxosMap: Record<string, UTXO[]> = {};
    const cashTokenUtxosMap: Record<string, UTXO[]> = {};

    try {
      for (const key of keyPairs) {
        const addressUTXOs = await fetchUTXOsByAddress(
          state.wallet_id.currentWalletId,
          key.address
        );
        console.log(`Fetched UTXOs for ${key.address}:`, addressUTXOs);

        utxosMap[key.address] = addressUTXOs.filter((utxo) => !utxo.token_data);
        cashTokenUtxosMap[key.address] = addressUTXOs.filter(
          (utxo) => utxo.token_data
        );
      }

      return { utxosMap, cashTokenUtxosMap };
    } catch (error) {
      console.error('Error fetching UTXOs from database:', error);
      return { utxosMap: {}, cashTokenUtxosMap: {} };
    }
  }
}
