import { UTXO } from '../../types/types';
import DatabaseService from '../DatabaseManager/DatabaseService';
import ElectrumService from '../ElectrumServer/ElectrumServer';
import { Network } from '../../redux/networkSlice';
import { store } from '../../redux/store';
import { setUTXOs } from '../../redux/utxoSlice';

export default async function UTXOManager() {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const Electrum = ElectrumService();
  const state = store.getState();
  const prefix =
    state.network.currentNetwork === Network.MAINNET
      ? 'bitcoincash'
      : 'bchtest';

  return {
    storeUTXOs,
    fetchUTXOsByAddress,
    checkNewUTXOs,
    deleteUTXOs,
    fetchUTXOs,
  };

  // Typing for UTXO objects and return values
  async function storeUTXOs(utxos: UTXO[]): Promise<void> {
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
            utxo.height || 0, // Default height to 0 if undefined
            utxo.tx_hash,
            utxo.tx_pos,
            utxo.value,
            utxo.prefix || 'unknown', // Default prefix to 'unknown' if undefined
            utxo.token_data ? JSON.stringify(utxo.token_data) : null, // Store token_data as string in DB
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

  // Typing for fetching UTXOs
  async function fetchUTXOsByAddress(
    walletId: number,
    address: string
  ): Promise<UTXO[]> {
    const db = dbService.getDatabase();
    if (!db) {
      console.error('Database not started.');
      return [];
    }

    try {
      console.log(`Fetching UTXOs for address: ${address}`);

      // Fetch from Electrum service
      const utxos = await Electrum.getUTXOS(address);
      console.log(`Raw UTXOs response for address ${address}:`, utxos);

      const formattedUTXOs: UTXO[] = utxos.map((utxo: UTXO) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        value: utxo.value,
        address: address,
        height: utxo.height,
        prefix,
        token_data: utxo.token_data ? JSON.stringify(utxo.token_data) : null,
      }));

      console.log(`Formatted UTXOs for address ${address}:`, formattedUTXOs);

      // Store in the database
      await storeUTXOs(
        formattedUTXOs.map((utxo) => ({
          ...utxo,
          wallet_id: walletId,
        }))
      );

      // Fetch existing UTXOs from the database
      const storedUTXOsQuery = db.prepare(`
        SELECT * FROM UTXOs WHERE wallet_id = ? AND address = ?;
      `);
      storedUTXOsQuery.bind([walletId, address]);

      const storedUTXOs: UTXO[] = [];
      while (storedUTXOsQuery.step()) {
        const result = storedUTXOsQuery.getAsObject();

        // Parse token_data if it exists and is a string
        if (typeof result.token_data === 'string') {
          result.token_data = JSON.parse(result.token_data);
        } else {
          result.token_data = null;
        }

        storedUTXOs.push(result as unknown as UTXO); // Cast after ensuring the fields match
      }
      storedUTXOsQuery.free();

      console.log(`Stored UTXOs for address ${address}:`, storedUTXOs);

      // Determine UTXOs to be deleted (existing ones not in fetchedUTXOs)
      const fetchedUTXOKeys = new Set(
        formattedUTXOs.map((utxo) => `${utxo.tx_hash}-${utxo.tx_pos}`)
      );
      const utxosToDelete = storedUTXOs.filter(
        (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      // Delete outdated UTXOs
      await deleteUTXOs(walletId, utxosToDelete);

      return storedUTXOs;
    } catch (error) {
      console.error(`Error fetching UTXOs for address ${address}:`, error);
      return [];
    }
  }

  // Typing for deleting UTXOs
  async function deleteUTXOs(wallet_id: number, utxos: UTXO[]): Promise<void> {
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

  // Typing for checking new UTXOs
  async function checkNewUTXOs(wallet_id: number): Promise<void> {
    const db = dbService.getDatabase();
    if (!db) {
      console.log('Database not started.');
      return;
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
          fetchedUTXOs.map((utxo: UTXO) => `${utxo.tx_hash}-${utxo.tx_pos}`)
        );
        const utxosToDelete = existingUTXOs.filter(
          (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
        );

        // Delete outdated UTXOs
        await deleteUTXOs(wallet_id, utxosToDelete);

        // Prepare new UTXOs to be stored
        const newUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
          wallet_id: wallet_id,
          address: address.address,
          height: utxo.height,
          tx_hash: utxo.tx_hash,
          tx_pos: utxo.tx_pos,
          amount: utxo.value,
          prefix,
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
  async function fetchUTXOs(walletKeys) {
    // setFetchingUTXOs(true);
    const utxosMap = {};
    const cashTokenUtxosMap = {};
    const uniqueUTXOs = new Set();
    const loadingState = {};

    const electrumService = ElectrumService();
    await electrumService.electrumConnect();

    for (const key of walletKeys) {
      loadingState[key.address] = true;
    }
    // setLoading(loadingState);

    for (let i = 0; i < walletKeys.length; i++) {
      const key = walletKeys[i];
      console.log(`Key ${i}:`, key.address);
      const addressUTXOs = await fetchUTXOsByAddress(
        state.wallet_id.currentWalletId,
        key.address
      );
      console.log(`Fetched UTXOs for address ${key.address}:`, addressUTXOs);

      utxosMap[key.address] = addressUTXOs.filter((utxo) => {
        const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
        if (uniqueUTXOs.has(utxoKey)) {
          return false;
        }
        if (utxo.address === key.address && !utxo.token_data) {
          uniqueUTXOs.add(utxoKey);
          total += utxo.amount;
          return true;
        }
        return false;
      });

      cashTokenUtxosMap[key.address] = addressUTXOs.filter((utxo) => {
        const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
        if (uniqueUTXOs.has(utxoKey)) {
          return false;
        }
        if (utxo.address === key.address && utxo.token_data) {
          uniqueUTXOs.add(utxoKey);
          total += utxo.amount;
          return true;
        }
        return false;
      });

      loadingState[key.address] = false;
      // setLoading({ ...loadingState });
      // setUtxoProgress(((i + 1) / walletKeys.length) * 100);
    }

    await electrumService.electrumDisconnect();

    // Update Redux with the new UTXOs
    const newUTXOs = walletKeys.reduce((acc, key) => {
      acc[key.address] = [
        ...utxosMap[key.address],
        ...cashTokenUtxosMap[key.address],
      ];
      return acc;
    }, {});
    store.dispatch(setUTXOs({ newUTXOs }));

    return { utxosMap, cashTokenUtxosMap };
    // setUtxos(utxosMap);
    // setCashTokenUtxos(cashTokenUtxosMap);
    // setFetchingUTXOs(false);
  }
}
