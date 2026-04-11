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

async function enrichCachedTokenMetadata(
  utxosByAddress: Record<string, UTXO[]>
): Promise<void> {
  const bcmrService = new BcmrService();
  const uniqueCategories = new Set<string>();

  for (const utxos of Object.values(utxosByAddress)) {
    for (const utxo of utxos) {
      if (utxo.token?.category) uniqueCategories.add(utxo.token.category);
    }
  }

  if (uniqueCategories.size === 0) return;

  const categoryList = Array.from(uniqueCategories);
  const metadataByCategory = new Map<string, Awaited<ReturnType<BcmrService['getSnapshot']>>>();

  const metadataResults = await Promise.all(
    categoryList.map(async (category) => {
      try {
        const metadata = await bcmrService.getSnapshot(category);
        return { category, metadata };
      } catch {
        return { category, metadata: null };
      }
    })
  );

  for (const { category, metadata } of metadataResults) {
    metadataByCategory.set(category, metadata);
  }

  for (const utxos of Object.values(utxosByAddress)) {
    for (const utxo of utxos) {
      const category = utxo.token?.category;
      if (!category) continue;
      const metadata = metadataByCategory.get(category);
      if (metadata) {
        utxo.token = {
          ...utxo.token,
          BcmrTokenMetadata: metadata,
        };
      }
    }
  }
}

const UTXOService = {
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    try {
      const results = await UTXOService.fetchAndStoreUTXOsMany(walletId, [address]);
      return results[address] ?? [];
    } catch (error) {
      logError('UTXOService.fetchAndStoreUTXOs', error, { walletId, address });
      return [];
    }
  },

  async fetchAndStoreUTXOsMany(
    walletId: number,
    addresses: string[]
  ): Promise<Record<string, UTXO[]>> {
    try {
      const manager = await UTXOManager();
      const addressManager = AddressManager();
      const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
      if (uniqueAddresses.length === 0) return {};

      const utxosByAddress = await ElectrumService.getUTXOsMany(uniqueAddresses);
      for (const fetchedUTXOs of Object.values(utxosByAddress)) {
        for (const u of fetchedUTXOs) {
          const uAny = u as UTXO & { token_data?: unknown };
          if (!u.token && uAny.token_data) {
            u.token = normalizeTokenField(uAny.token_data);
            uAny.token_data = undefined;
          }
        }
      }

      await enrichCachedTokenMetadata(utxosByAddress);

      const tokenAddresses = await addressManager.fetchTokenAddresses(
        walletId,
        uniqueAddresses
      );
      const prefix = getPrefix();
      const formattedByAddress: Record<string, UTXO[]> = {};

      for (const address of uniqueAddresses) {
        const fetchedUTXOs = utxosByAddress[address] ?? [];
        formattedByAddress[address] = fetchedUTXOs.map((utxo: UTXO) => ({
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
          tokenAddress: tokenAddresses[address] || undefined,
        }));
      }

      await manager.replaceWalletAddressUTXOs(walletId, formattedByAddress);

      return formattedByAddress;
    } catch (error) {
      logError('UTXOService.fetchAndStoreUTXOsMany', error, {
        walletId,
        addressCount: addresses.length,
      });
      return {};
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
