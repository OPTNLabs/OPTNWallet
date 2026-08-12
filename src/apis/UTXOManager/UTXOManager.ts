import DatabaseService from '../DatabaseManager/DatabaseService';
// import { Network } from '../../redux/networkSlice';
import { store } from '../../redux/store';
import { Token, UTXO } from '../../types/types';
import { Database } from 'sql.js';
import { logError } from '../../utils/errorHandling';

export default function UTXOManager() {
  const dbService = DatabaseService();
  // const prefix =
  //   state.network.currentNetwork === Network.MAINNET
  //     ? 'bitcoincash'
  //     : 'bchtest';

  return {
    storeUTXOs,
    fetchUTXOsByAddress,
    deleteUTXOs,
    fetchAddressesByWalletId,
    fetchUTXOsFromDatabase,
  };

  function parseToken(rawToken: unknown): Token | null | undefined {
    if (typeof rawToken === 'string') {
      try {
        return JSON.parse(rawToken) as Token;
      } catch {
        return undefined;
      }
    }
    if (rawToken && typeof rawToken === 'object') return rawToken as Token;
    return undefined;
  }

  // Store UTXOs in the database
  async function storeUTXOs(utxos: UTXO[]): Promise<void> {
    let db: Database | null = null;
    try {
      await dbService.ensureDatabaseStarted();
      db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      // Begin a transaction for atomicity
      db.exec('BEGIN TRANSACTION;');

      const insertQuery = db.prepare(`
        INSERT OR REPLACE INTO UTXOs(wallet_id, address, token_address, height, tx_hash, tx_pos, amount, prefix, token) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);

      for (const utxo of utxos) {
        insertQuery.run([
          utxo.wallet_id,
          utxo.address,
          utxo.tokenAddress || null,
          utxo.height || 0,
          utxo.tx_hash,
          utxo.tx_pos,
          utxo.value,
          utxo.prefix || 'unknown',
          utxo.token ? JSON.stringify(utxo.token) : null,
        ]);
      }

      insertQuery.free();
      db.exec('COMMIT;');
    } catch (error) {
      logError('UTXOManager.storeUTXOs', error);
      if (db) {
        db.exec('ROLLBACK;');
      }
      throw error; // Re-throw to handle upstream if needed
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
        SELECT wallet_id, address, token_address, height, tx_hash, tx_pos, amount AS value, prefix, token
        FROM UTXOs WHERE wallet_id = ? AND address = ?;
      `);
      query.bind([walletId, address]);

      const utxos: UTXO[] = [];
      while (query.step()) {
        const result = query.getAsObject();
        const token = parseToken(result.token);
        utxos.push({
          wallet_id: result.wallet_id as number,
          address: result.address as string,
          tokenAddress: result.token_address as string | undefined,
          height: result.height as number,
          tx_hash: result.tx_hash as string,
          tx_pos: result.tx_pos as number,
          value: result.value as number,
          amount: result.value as number,
          prefix: result.prefix as string,
          token,
        });
      }
      query.free();

      return utxos;
    } catch (error) {
      logError('UTXOManager.fetchUTXOsByAddress', error, { address, walletId });
      return [];
    }
  }

  // Delete UTXOs from the database
  async function deleteUTXOs(walletId: number, utxos: UTXO[]): Promise<void> {
    let db; // Declare db variable outside of the try block

    try {
      await dbService.ensureDatabaseStarted();
      db = dbService.getDatabase();
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
      // await dbService.saveDatabaseToFile();
    } catch (error) {
      logError('UTXOManager.deleteUTXOs', error, { walletId });
      if (db) {
        db.exec('ROLLBACK;'); // Rollback in case of failure, if db is available
      }
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
      logError('UTXOManager.fetchAddressesByWalletId', error, { walletId });
      return [];
    }
  }

  // Fetch UTXOs from the database for multiple addresses
  async function fetchUTXOsFromDatabase(
    keyPairs: Array<{ address: string }>,
    walletId?: number
  ) {
    const utxosMap: Record<string, UTXO[]> = {};
    const cashTokenUtxosMap: Record<string, UTXO[]> = {};

    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database not started.');

      const currentWalletId = walletId ?? store.getState().wallet_id.currentWalletId;
      if (!currentWalletId) {
        return { utxosMap, cashTokenUtxosMap };
      }

      const addresses = Array.from(
        new Set(
          keyPairs
            .map((k) => (typeof k.address === 'string' ? k.address : ''))
            .filter(Boolean)
        )
      );

      for (const address of addresses) {
        utxosMap[address] = [];
        cashTokenUtxosMap[address] = [];
      }

      if (addresses.length === 0) {
        return { utxosMap, cashTokenUtxosMap };
      }

      const placeholders = addresses.map(() => '?').join(', ');
      const query = db.prepare(`
        SELECT wallet_id, address, token_address, height, tx_hash, tx_pos, amount AS value, prefix, token
        FROM UTXOs
        WHERE wallet_id = ? AND address IN (${placeholders});
      `);
      query.bind([currentWalletId, ...addresses]);

      while (query.step()) {
        const result = query.getAsObject();
        const address = result.address as string;
        const utxo: UTXO = {
          wallet_id: result.wallet_id as number,
          address,
          tokenAddress: result.token_address as string | undefined,
          height: result.height as number,
          tx_hash: result.tx_hash as string,
          tx_pos: result.tx_pos as number,
          value: result.value as number,
          amount: result.value as number,
          prefix: result.prefix as string,
          token: parseToken(result.token),
        };

        if (utxo.token) {
          cashTokenUtxosMap[address].push(utxo);
        } else {
          utxosMap[address].push(utxo);
        }
      }
      query.free();

      return { utxosMap, cashTokenUtxosMap };
    } catch (error) {
      logError('UTXOManager.fetchUTXOsFromDatabase', error);
      return { utxosMap: {}, cashTokenUtxosMap: {} };
    }
  }
}
