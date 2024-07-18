// @ts-nocheck
// src/apis/UTXOManager/UTXOManager.ts

import { UTXOs } from '../types';
import DatabaseService from '../DatabaseManager/DatabaseService';
import ElectrumService from '../ElectrumServer/ElectrumServer';

export default async function UTXOManager() {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const Electrum = ElectrumService();

  return {
    storeUTXOs,
    fetchUTXOsByAddress,
    checkNewUTXOs,
    deleteUTXOs,
  };

  async function storeUTXOs(utxos) {
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return null;
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
            utxo.height || 0, // Default height to 0 if undefined
            utxo.tx_hash,
            utxo.tx_pos,
            utxo.amount,
            utxo.prefix || 'unknown', // Default prefix to 'unknown' if undefined
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

  async function fetchUTXOsByAddress(walletId, address) {
    const db = dbService.getDatabase();
    try {
      console.log(`Fetching UTXOs for address: ${address}`);

      // Fetch from Electrum
      const utxos = await Electrum.getUTXOS(address);
      console.log(`Raw UTXOs response for address ${address}:`, utxos);

      const formattedUTXOs = utxos.map((utxo) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: utxo.value,
        address: address,
        height: utxo.height,
        prefix: 'bchtest',
        token_data: utxo.token_data ? JSON.stringify(utxo.token_data) : null,
      }));

      console.log(`Formatted UTXOs for address ${address}:`, formattedUTXOs);

      // Store in database
      await storeUTXOs(
        formattedUTXOs.map((utxo) => ({
          ...utxo,
          wallet_id: walletId,
        }))
      );

      // Fetch from database
      const storedUTXOsQuery = db.prepare(`
        SELECT * FROM UTXOs WHERE wallet_id = ? AND address = ?;
      `);
      storedUTXOsQuery.bind([walletId, address]);
      const storedUTXOs = [];
      while (storedUTXOsQuery.step()) {
        const result = storedUTXOsQuery.getAsObject();
        result.token_data = result.token_data
          ? JSON.parse(result.token_data)
          : null;
        storedUTXOs.push(result);
      }
      storedUTXOsQuery.free();

      console.log(`Stored UTXOs for address ${address}:`, storedUTXOs);

      return storedUTXOs;
    } catch (error) {
      console.error(`Error fetching UTXOs for address ${address}:`, error);
      return [];
    }
  }

  async function deleteUTXOs(wallet_id: number, utxos: UTXOs[]) {
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
        query.run([wallet_id, utxo.tx_hash, utxo.tx_pos, utxo.address]);
      }
      query.free();
    } catch (error) {
      console.log('Error deleting UTXOs:', error);
    }
    await dbService.saveDatabaseToFile();
  }

  async function checkNewUTXOs(wallet_id: number) {
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return null;
    }
    const query = 'SELECT * FROM addresses WHERE wallet_id = :walletid';
    const statement = db.prepare(query);
    statement.bind({ ':walletid': wallet_id });

    const queriedAddresses: { address: string }[] = [];

    while (statement.step()) {
      const row = statement.getAsObject();
      queriedAddresses.push({
        address: row.address as string,
      });
    }

    statement.free();
    for (const address of queriedAddresses) {
      try {
        const fetchedUTXOs = await Electrum.getUTXOS(address.address);

        // Fetch existing UTXOs for the address from the database
        const existingUTXOs = await fetchUTXOsByAddress(
          wallet_id,
          address.address
        );

        // Determine UTXOs to be deleted (existing ones not in fetchedUTXOs)
        const fetchedUTXOKeys = new Set(
          fetchedUTXOs.map((utxo) => `${utxo.tx_hash}-${utxo.tx_pos}`)
        );
        const utxosToDelete = existingUTXOs.filter(
          (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
        );

        // Delete outdated UTXOs
        await deleteUTXOs(wallet_id, utxosToDelete);

        // Prepare new UTXOs to be stored
        const newUTXOs = fetchedUTXOs.map((utxo) => ({
          wallet_id: wallet_id,
          address: address.address,
          height: utxo.height,
          tx_hash: utxo.tx_hash,
          tx_pos: utxo.tx_pos,
          amount: utxo.value,
          prefix: 'bchtest',
          token_data: utxo.token_data ? JSON.stringify(utxo.token_data) : null,
        }));

        // Store new UTXOs
        await storeUTXOs(newUTXOs);
      } catch (error) {
        console.error(
          `Error fetching or storing UTXOs for address ${address.address}:`,
          error
        );
      }
    }
  }
}
