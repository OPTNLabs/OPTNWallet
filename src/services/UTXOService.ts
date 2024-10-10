import ElectrumService from './ElectrumService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import { UTXO } from '../types/types';

const UTXOService = {
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    const manager = UTXOManager();

    // Fetch UTXOs from Electrum service
    const utxos = await ElectrumService.getUTXOS(address);
    console.log(`Raw UTXOs response for address ${address}:`, utxos);

    const formattedUTXOs: UTXO[] = utxos.map((utxo: UTXO) => ({
      tx_hash: utxo.tx_hash,
      tx_pos: utxo.tx_pos,
      value: utxo.value,
      address: address,
      height: utxo.height,
      prefix: 'bchtest',
      token_data: utxo.token_data || null,
    }));

    console.log(`Formatted UTXOs for address ${address}:`, formattedUTXOs);

    // Store UTXOs in the database
    (await manager).storeUTXOs(
      formattedUTXOs.map((utxo) => ({
        ...utxo,
        wallet_id: walletId,
      }))
    );

    return (await manager).fetchUTXOsByAddress(walletId, address);
  },

  async checkNewUTXOs(walletId: number): Promise<void> {
    const manager = UTXOManager();

    // Fetch addresses from the database using the new method
    const queriedAddresses = (await manager).fetchAddressesByWalletId(walletId);

    // Loop through each address to check for new UTXOs
    for (const address of await queriedAddresses) {
      try {
        const fetchedUTXOs = await ElectrumService.getUTXOS(address.address);
        const existingUTXOs = (await manager).fetchUTXOsByAddress(
          walletId,
          address.address
        );

        // Determine outdated UTXOs to delete
        const fetchedUTXOKeys = new Set(
          fetchedUTXOs.map((utxo: UTXO) => `${utxo.tx_hash}-${utxo.tx_pos}`)
        );
        const utxosToDelete = (await existingUTXOs).filter(
          (utxo) => !fetchedUTXOKeys.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
        );

        // Delete outdated UTXOs
        (await manager).deleteUTXOs(walletId, utxosToDelete);

        // Store new UTXOs
        const newUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
          wallet_id: walletId,
          address: address.address,
          height: utxo.height,
          tx_hash: utxo.tx_hash,
          tx_pos: utxo.tx_pos,
          value: utxo.value,
          prefix: 'bchtest',
          token_data: utxo.token_data ? utxo.token_data : null,
        }));
        (await manager).storeUTXOs(newUTXOs);
      } catch (error) {
        console.error(
          `Error fetching or storing UTXOs for address ${address.address}:`,
          error
        );
      }
    }
  },
};

export default UTXOService;
