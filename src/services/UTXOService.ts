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
        token_data: utxo.token_data || null,
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
        console.log(`Deleting outdated UTXOs for ${address}:`, utxosToDelete);
        await manager.deleteUTXOs(walletId, utxosToDelete);

        // Remove them from Redux as well
        store.dispatch(removeUTXOs({ address, utxosToRemove: utxosToDelete }));
      }

      // Store new UTXOs
      await manager.storeUTXOs(formattedUTXOs);

      // Update Redux store with the new UTXOs
      const updatedUTXOs = await manager.fetchUTXOsByAddress(walletId, address);
      store.dispatch(setUTXOs({ newUTXOs: { [address]: updatedUTXOs } }));

      return updatedUTXOs;
    } catch (error) {
      console.error(`Error in fetchAndStoreUTXOs for ${address}:`, error);
      return [];
    }
  },

  // Check for new UTXOs and synchronize with the database and Redux
  async checkNewUTXOs(walletId: number): Promise<void> {
    try {
      const manager = await UTXOManager();

      // Fetch all addresses linked to the wallet
      const queriedAddresses = await manager.fetchAddressesByWalletId(walletId);
      console.log('Queried addresses:', queriedAddresses);

      for (const { address } of queriedAddresses) {
        try {
          // Fetch UTXOs from Electrum
          const fetchedUTXOs = await ElectrumService.getUTXOS(address);
          console.log(`Fetched UTXOs for ${address}:`, fetchedUTXOs);

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
            console.log(
              `Deleting outdated UTXOs for ${address}:`,
              utxosToDelete
            );
            await manager.deleteUTXOs(walletId, utxosToDelete);
          }

          // Store new UTXOs
          const newUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
            ...utxo,
            wallet_id: walletId,
            address,
            prefix,
            token_data: utxo.token_data || null,
          }));

          if (newUTXOs.length > 0) {
            console.log(`Storing new UTXOs for ${address}:`, newUTXOs);
            await manager.storeUTXOs(newUTXOs);
          }

          // Update Redux with the new UTXOs
          store.dispatch(setUTXOs({ newUTXOs: { [address]: newUTXOs } }));
        } catch (error) {
          console.error(
            `Error processing UTXOs for address ${address}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error('Error checking new UTXOs:', error);
    }
  },
};

export default UTXOService;
