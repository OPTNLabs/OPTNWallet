import ElectrumService from './ElectrumService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import { UTXO } from '../types/types';
import { Network } from '../redux/networkSlice';
import { store } from '../redux/store';
import { removeUTXOs, setUTXOs } from '../redux/utxoSlice';

const state = store.getState();
const prefix =
  state.network.currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

const UTXOService = {
  // Fetch UTXOs from Electrum and store them in the database and Redux
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    try {
      const manager = await UTXOManager();

      // Fetch UTXOs from Electrum
      const fetchedUTXOs = await ElectrumService.getUTXOS(address);
      // console.log(`Fetched UTXOs for ${address}:`, fetchedUTXOs);

      // Format UTXOs for storage
      const formattedUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        value: utxo.value,
        address,
        height: utxo.height,
        prefix,
        token: utxo.token,
        wallet_id: walletId,
      }));

      // console.log(`Formatted UTXOs for ${address}:`, formattedUTXOs);

      // Fetch existing UTXOs from the database
      const existingUTXOs = await manager.fetchUTXOsByAddress(
        walletId,
        address
      );

      // Identify outdated UTXOs to delete
      const fetchedUTXOKeys = new Set(
        fetchedUTXOs.map((utxo) => `${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      const utxosToDelete = existingUTXOs.filter(
        (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      if (utxosToDelete.length > 0) {
        // console.log(`Deleting outdated UTXOs for ${address}:`, utxosToDelete);
        await manager.deleteUTXOs(walletId, utxosToDelete);

        // Remove them from Redux as well
        store.dispatch(removeUTXOs({ address, utxosToRemove: utxosToDelete }));
      }

      // Store new UTXOs
      await manager.storeUTXOs(formattedUTXOs);

      // Update Redux store with the new UTXOs
      const updatedUTXOs = await manager.fetchUTXOsByAddress(walletId, address);
      store.dispatch(setUTXOs({ newUTXOs: { [address]: updatedUTXOs } }));

      // console.log("updated UTXOs", updatedUTXOs)
      return updatedUTXOs;
    } catch (error) {
      console.error(`Error in fetchAndStoreUTXOs for ${address}:`, error);
      return [];
    }
  },

  // Fetch existing UTXOs from the database and return them
  async fetchUTXOsFromDatabase(keyPairs: { address: string }[]): Promise<{
    utxosMap: Record<string, UTXO[]>;
    cashTokenUtxosMap: Record<string, UTXO[]>;
  }> {
    try {
      const manager = await UTXOManager();
      const result = await manager.fetchUTXOsFromDatabase(keyPairs);
      return result;
    } catch (error) {
      console.error('Error fetching UTXOs from database:', error);
      return { utxosMap: {}, cashTokenUtxosMap: {} };
    }
  },
};

export default UTXOService;
