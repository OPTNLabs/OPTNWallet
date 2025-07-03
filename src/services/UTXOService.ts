import ElectrumService from './ElectrumService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import AddressManager from '../apis/AddressManager/AddressManager';
import BcmrService from './BcmrService';
import { UTXO } from '../types/types';
import { Network } from '../redux/networkSlice';
import { store } from '../redux/store';
import { removeUTXOs, setUTXOs } from '../redux/utxoSlice';

const state = store.getState();
const prefix =
  state.network.currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

const UTXOService = {
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    try {
      const manager = await UTXOManager();
      const addressManager = AddressManager();

      // Fetch UTXOs from Electrum
      const fetchedUTXOs = await ElectrumService.getUTXOs(address);
      // console.log(`[UTXOService] Fetched UTXOs for address ${address}:`, fetchedUTXOs);

      // Fetch and store BCMR metadata for token categories
      const bcmrService = new BcmrService();
      const uniqueCategories = new Set<string>();
      for (const utxo of fetchedUTXOs) {
        if (utxo.token && utxo.token.category) {
          uniqueCategories.add(utxo.token.category);
        }
      }
      // console.log(`[UTXOService] Unique token categories:`, Array.from(uniqueCategories));

      if (uniqueCategories.size > 0) {
        try {
          // Fetch metadata for each category, allowing partial failures
          const metadataResults = await Promise.all(
            Array.from(uniqueCategories).map(async (category) => {
              try {
                await bcmrService.resolveIdentityRegistry(category);
                const metadata = await bcmrService.getSnapshot(category);
                // console.log(`[UTXOService] Metadata for category ${category}:`, metadata);
                return { category, metadata };
              } catch (error) {
                // console.error(`[UTXOService] Error fetching metadata for category ${category}:`, error);
                return { category, metadata: null };
              }
            })
          );

          // Attach metadata to UTXOs
          for (const utxo of fetchedUTXOs) {
            if (utxo.token && utxo.token.category) {
              const result = metadataResults.find((r) => r.category === utxo.token.category);
              if (result?.metadata) {
                utxo.token.BcmrTokenMetadata = result.metadata;
              }
            }
          }
          // console.log(`[UTXOService] UTXOs with attached BCMR metadata:`, fetchedUTXOs);
        } catch (error) {
          console.error('[UTXOService] Error processing BCMR metadata:', error);
        }
      }

      // Fetch tokenAddress
      const tokenAddress = await addressManager.fetchTokenAddress(walletId, address);
      // console.log(`[UTXOService] Token address for ${address}:`, tokenAddress);

      // Format UTXOs for storage
      const formattedUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        value: utxo.value,
        amount: utxo.value,
        address,
        height: utxo.height,
        prefix,
        token: utxo.token, // Includes BcmrTokenMetadata if present
        wallet_id: walletId,
        tokenAddress: tokenAddress || undefined,
      }));
      // console.log(`[UTXOService] Formatted UTXOs with metadata for storage:`, formattedUTXOs);

      // Fetch existing UTXOs from the database
      const existingUTXOs = await manager.fetchUTXOsByAddress(walletId, address);
      // console.log(`[UTXOService] Existing UTXOs in database:`, existingUTXOs);

      // Identify outdated UTXOs to delete
      const fetchedUTXOKeys = new Set(
        fetchedUTXOs.map((utxo) => `${utxo.tx_hash}-${utxo.tx_pos}`)
      );
      const utxosToDelete = existingUTXOs.filter(
        (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      if (utxosToDelete.length > 0) {
        await manager.deleteUTXOs(walletId, utxosToDelete);
        store.dispatch(removeUTXOs({ address, utxosToRemove: utxosToDelete }));
        // console.log(`[UTXOService] Deleted outdated UTXOs:`, utxosToDelete);
      }

      // Store new UTXOs
      await manager.storeUTXOs(formattedUTXOs);
      // console.log(`[UTXOService] Stored UTXOs in database`);

      // Update Redux store with the new UTXOs
      const updatedUTXOs = await manager.fetchUTXOsByAddress(walletId, address);
      store.dispatch(setUTXOs({ newUTXOs: { [address]: updatedUTXOs } }));
      // console.log(`[UTXOService] Updated Redux with UTXOs:`, updatedUTXOs);

      return updatedUTXOs;
    } catch (error) {
      console.error(`[UTXOService] Error in fetchAndStoreUTXOs for ${address}:`, error);
      return [];
    }
  },

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