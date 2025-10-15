// src/services/UTXOService.ts
import ElectrumService from './ElectrumService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import AddressManager from '../apis/AddressManager/AddressManager';
import BcmrService from './BcmrService';
import { UTXO } from '../types/types';
import { Network } from '../redux/networkSlice';
import { store } from '../redux/store';

function getPrefix(): string {
  try {
    const state = store.getState();
    return state.network.currentNetwork === Network.MAINNET
      ? 'bitcoincash'
      : 'bchtest';
  } catch {
    return 'bitcoincash';
  }
}

const UTXOService = {
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    try {
      const manager = await UTXOManager();
      const addressManager = AddressManager();

      const fetchedUTXOs = await ElectrumService.getUTXOs(address);

      // BCMR
      const bcmrService = new BcmrService();
      const uniqueCategories = new Set<string>();
      for (const utxo of fetchedUTXOs) {
        if (utxo.token?.category) uniqueCategories.add(utxo.token.category);
      }
      if (uniqueCategories.size > 0) {
        const metadataResults = await Promise.all(
          [...uniqueCategories].map(async (category) => {
            try {
              await bcmrService.resolveIdentityRegistry(category);
              const metadata = await bcmrService.getSnapshot(category);
              return { category, metadata };
            } catch {
              return { category, metadata: null };
            }
          })
        );
        for (const utxo of fetchedUTXOs) {
          if (utxo.token?.category) {
            const res = metadataResults.find(
              (r) => r.category === utxo.token!.category
            );
            if (res?.metadata) utxo.token.BcmrTokenMetadata = res.metadata;
          }
        }
      }

      const tokenAddress = await addressManager.fetchTokenAddress(
        walletId,
        address
      );
      const prefix = getPrefix();

      const formattedUTXOs = fetchedUTXOs.map((utxo: UTXO) => ({
        id: `${utxo.tx_hash}:${utxo.tx_pos}`,
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        value: utxo.value,
        amount: utxo.value,
        address,
        height: utxo.height,
        prefix,
        token: utxo.token,
        wallet_id: walletId,
        tokenAddress: tokenAddress || undefined,
      }));

      // Diff against DB and delete removed ones
      const existingUTXOs = await manager.fetchUTXOsByAddress(
        walletId,
        address
      );
      const fetchedKeys = new Set(
        formattedUTXOs.map((u) => `${u.tx_hash}-${u.tx_pos}`)
      );
      const utxosToDelete = existingUTXOs.filter(
        (u) => !fetchedKeys.has(`${u.tx_hash}-${u.tx_pos}`)
      );
      if (utxosToDelete.length > 0) {
        await manager.deleteUTXOs(walletId, utxosToDelete);
      }

      await manager.storeUTXOs(formattedUTXOs);
      const updatedUTXOs = await manager.fetchUTXOsByAddress(walletId, address);

      return updatedUTXOs;
    } catch (error) {
      console.error(
        `[UTXOService] Error in fetchAndStoreUTXOs for ${address}:`,
        error
      );
      return [];
    }
  },

  async fetchUTXOsFromDatabase(keyPairs: { address: string }[]): Promise<{
    utxosMap: Record<string, UTXO[]>;
    cashTokenUtxosMap: Record<string, UTXO[]>;
  }> {
    try {
      const manager = await UTXOManager();
      return await manager.fetchUTXOsFromDatabase(keyPairs);
    } catch (error) {
      console.error('Error fetching UTXOs from database:', error);
      return { utxosMap: {}, cashTokenUtxosMap: {} };
    }
  },

  // ✅ NEW: fetch all wallet UTXOs (across every address) from DB
  async fetchAllWalletUtxos(
    walletId: number
  ): Promise<{ allUtxos: UTXO[]; tokenUtxos: UTXO[] }> {
    try {
      const manager = await UTXOManager();
      const addrs = await manager.fetchAddressesByWalletId(walletId);
      if (!addrs.length) return { allUtxos: [], tokenUtxos: [] };

      const { utxosMap, cashTokenUtxosMap } =
        await manager.fetchUTXOsFromDatabase(addrs);
      const allUtxos = Object.values(utxosMap).flat();
      const tokenUtxos = Object.values(cashTokenUtxosMap).flat();
      // Note: utxosMap excludes tokens (see manager), tokenUtxos holds token-carrying UTXOs
      return { allUtxos, tokenUtxos };
    } catch (e) {
      console.error('fetchAllWalletUtxos failed:', e);
      return { allUtxos: [], tokenUtxos: [] };
    }
  },
};

export default UTXOService;
