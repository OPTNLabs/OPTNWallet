// src/services/UTXOService.ts
import ElectrumService from './ElectrumService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import AddressManager from '../apis/AddressManager/AddressManager';
import BcmrService from './BcmrService';
import { UTXO } from '../types/types';
import { Network } from '../redux/networkSlice';
import { store } from '../redux/store';
import { normalizeTokenField } from '../utils/tokenNormalization';
import { logError } from '../utils/errorHandling';

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

      // Fetch from electrum (already normalized inside ElectrumService),
      // but we defensively normalize again in case of future changes.
      const fetchedUTXOs = await ElectrumService.getUTXOs(address);
      for (const u of fetchedUTXOs) {
        const uAny = u as UTXO & { token_data?: unknown };
        if (!u.token && uAny.token_data) {
          u.token = normalizeTokenField(uAny.token_data);
          uAny.token_data = undefined;
        }
      }

      // BCMR enrichment — gather unique token categories
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

      // Token address resolution (if available)
      const tokenAddress = await addressManager.fetchTokenAddress(
        walletId,
        address
      );
      const prefix = getPrefix();

      // Format for DB
      const formattedUTXOs: UTXO[] = fetchedUTXOs.map((utxo: UTXO) => ({
        id: `${utxo.tx_hash}:${utxo.tx_pos}`,
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        value: utxo.value,
        amount: utxo.value,
        address,
        height: utxo.height,
        prefix,
        token: utxo.token ?? null,
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

      // Persist latest snapshot
      await manager.storeUTXOs(formattedUTXOs);

      // IMPORTANT: read back using the split maps and merge coin + token UTXOs
      const { utxosMap, cashTokenUtxosMap } =
        await manager.fetchUTXOsFromDatabase([{ address }], walletId);
      const merged = [
        ...(utxosMap[address] ?? []),
        ...(cashTokenUtxosMap[address] ?? []),
      ];

      return merged;
    } catch (error) {
      logError('UTXOService.fetchAndStoreUTXOs', error, { walletId, address });
      return [];
    }
  },

  async fetchUTXOsFromDatabase(keyPairs: { address: string }[]): Promise<{
    utxosMap: Record<string, UTXO[]>;
    cashTokenUtxosMap: Record<string, UTXO[]>;
  }> {
    try {
      const manager = await UTXOManager();
      const currentWalletId = store.getState().wallet_id.currentWalletId;
      return await manager.fetchUTXOsFromDatabase(keyPairs, currentWalletId);
    } catch (error) {
      logError('UTXOService.fetchUTXOsFromDatabase', error, {
        addressCount: keyPairs.length,
      });
      return { utxosMap: {}, cashTokenUtxosMap: {} };
    }
  },

  // Fetch all wallet UTXOs (across every address) from DB
  // Note: utxosMap excludes tokens (by design in the manager),
  //       tokenUtxos holds token-carrying UTXOs.
  async fetchAllWalletUtxos(
    walletId: number
  ): Promise<{ allUtxos: UTXO[]; tokenUtxos: UTXO[] }> {
    try {
      const manager = await UTXOManager();
      const addrs = await manager.fetchAddressesByWalletId(walletId);
      if (!addrs.length) return { allUtxos: [], tokenUtxos: [] };

      const { utxosMap, cashTokenUtxosMap } =
        await manager.fetchUTXOsFromDatabase(addrs, walletId);

      const allUtxos = Object.values(utxosMap).flat().filter((u) => !u.token);
      const tokenUtxos = Object.values(cashTokenUtxosMap).flat();

      return { allUtxos, tokenUtxos };
    } catch (e) {
      logError('UTXOService.fetchAllWalletUtxos', e, { walletId });
      return { allUtxos: [], tokenUtxos: [] };
    }
  },
};

export default UTXOService;
