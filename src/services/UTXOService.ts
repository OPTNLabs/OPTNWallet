// src/services/UTXOService.ts
import { cashAddressToLockingBytecode, decodeTransaction } from '@bitauth/libauth';
import ElectrumService from './ElectrumService';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import AddressManager from '../apis/AddressManager/AddressManager';
import BcmrService from './BcmrService';
import WalletDiscoveryService from './WalletDiscoveryService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import OutboundTransactionTracker from './OutboundTransactionTracker';
import { Token, UTXO } from '../types/types';
import { Network } from '../state/slices/networkSlice';
import { store } from '../state/store';
import { normalizeTokenField } from '../utils/tokenNormalization';
import { logError } from '../utils/errorHandling';
import { isWebPlatform } from '../utils/platform';
import { binToHex, hexToBin } from '../utils/hex';

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

type DecodedTransaction = Exclude<ReturnType<typeof decodeTransaction>, string>;
type DecodedOutput = DecodedTransaction['outputs'][number];

function outpointKey(utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

function decodedOutputToToken(output: DecodedOutput): Token | null {
  if (!output.token) return null;

  const token: Token = {
    amount: output.token.amount,
    category: binToHex(output.token.category),
  };

  if (output.token.nft) {
    token.nft = {
      capability: output.token.nft.capability,
      commitment: binToHex(output.token.nft.commitment),
    };
  }

  return token;
}

function buildWalletBytecodeMap(addresses: string[]): Map<string, string> {
  const bytecodeMap = new Map<string, string>();

  for (const address of addresses) {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') continue;
    bytecodeMap.set(binToHex(decoded.bytecode), address);
  }

  return bytecodeMap;
}

async function collectPendingOutboundTokenUtxos(
  walletId: number,
  addresses: string[]
): Promise<UTXO[]> {
  const activeRecords = await OutboundTransactionTracker.listActive(walletId);
  if (activeRecords.length === 0 || addresses.length === 0) {
    return [];
  }

  const walletBytecodes = buildWalletBytecodeMap(addresses);
  if (walletBytecodes.size === 0) {
    return [];
  }

  const pendingTokenUtxos: UTXO[] = [];

  for (const record of activeRecords) {
    const decoded = decodeTransaction(hexToBin(record.rawTx));
    if (typeof decoded === 'string') continue;

    decoded.outputs.forEach((output, outputIndex) => {
      const lockingBytecodeHex = binToHex(output.lockingBytecode);
      const address = walletBytecodes.get(lockingBytecodeHex);
      if (!address) return;

      const token = decodedOutputToToken(output);
      if (!token) return;

      pendingTokenUtxos.push({
        id: `${record.txid}:${outputIndex}`,
        tx_hash: record.txid,
        tx_pos: outputIndex,
        value: Number(output.valueSatoshis ?? 0n),
        amount: Number(output.valueSatoshis ?? 0n),
        address,
        height: 0,
        prefix: getPrefix(),
        token,
        wallet_id: walletId,
      });
    });
  }

  return pendingTokenUtxos;
}

async function hasElectrumBatchUsage(
  walletId: number,
  batch: { address: string }[]
): Promise<boolean> {
  if (batch.length === 0) return false;

  const addresses = batch.map((item) => item.address);
  const [historiesByAddress, utxosByAddress] = await Promise.all([
    TransactionManager().fetchAndStoreTransactionHistories(walletId, addresses),
    ElectrumService.getUTXOsMany(addresses),
  ]);

  return batch.some((item) => {
    const history = historiesByAddress[item.address];
    const utxos = utxosByAddress[item.address];
    return (Array.isArray(history) && history.length > 0) || (Array.isArray(utxos) && utxos.length > 0);
  });
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

function mergeKnownTokenData(
  fetchedUtxos: UTXO[],
  existingUtxos: UTXO[] = []
): UTXO[] {
  if (fetchedUtxos.length === 0 || existingUtxos.length === 0) {
    return fetchedUtxos;
  }

  const existingByOutpoint = new Map(
    existingUtxos.map((utxo) => [`${utxo.tx_hash}:${utxo.tx_pos}`, utxo] as const)
  );

  return fetchedUtxos.map((utxo) => {
    const existing = existingByOutpoint.get(`${utxo.tx_hash}:${utxo.tx_pos}`);
    if (!existing?.token) return utxo;

    if (!utxo.token) {
      return {
        ...utxo,
        token: existing.token,
      };
    }

    return {
      ...utxo,
      token: {
        ...existing.token,
        ...utxo.token,
        nft: utxo.token.nft ?? existing.token.nft,
        BcmrTokenMetadata:
          utxo.token.BcmrTokenMetadata ?? existing.token.BcmrTokenMetadata,
      },
    };
  });
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
      const currentNetwork = store.getState().network.currentNetwork;
      await WalletDiscoveryService.ensureInitialAddressBatches(
        walletId,
        currentNetwork,
        hasElectrumBatchUsage
      );
      const manager = await UTXOManager();
      const addressManager = AddressManager();
      const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
      if (uniqueAddresses.length === 0) return {};

      const existingSnapshot = await manager.fetchUTXOsFromDatabase(
        uniqueAddresses.map((address) => ({ address })),
        walletId
      );
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
        const fetchedUTXOs = utxosByAddress[address];
        if (!fetchedUTXOs) {
          formattedByAddress[address] = [
            ...(existingSnapshot.utxosMap[address] ?? []),
            ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
          ];
          continue;
        }

        const previousUtxos = [
          ...(existingSnapshot.utxosMap[address] ?? []),
          ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
        ];
        const mergedUTXOs = mergeKnownTokenData(fetchedUTXOs, previousUtxos);

        formattedByAddress[address] = mergedUTXOs.map((utxo: UTXO) => ({
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

      const dbService = DatabaseService();
      if (isWebPlatform()) {
        await dbService.flushDatabaseToFile();
      } else {
        dbService.scheduleDatabaseSave();
      }

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
      const allDbUtxos = Object.values(utxosMap).flat().filter((u) => !u.token);
      const dbTokenUtxos = Object.values(cashTokenUtxosMap).flat();
      const pendingTokenUtxos = await collectPendingOutboundTokenUtxos(
        walletId,
        addrs.map((entry) => entry.address)
      );

      const pendingTokenOutpoints = new Set(
        pendingTokenUtxos.map((utxo) => outpointKey(utxo))
      );
      const allUtxos = allDbUtxos.filter(
        (utxo) => !pendingTokenOutpoints.has(outpointKey(utxo))
      );
      const tokenUtxos = [...dbTokenUtxos, ...pendingTokenUtxos].reduce<UTXO[]>(
        (acc, utxo) => {
          if (!acc.some((existing) => outpointKey(existing) === outpointKey(utxo))) {
            acc.push(utxo);
          }
          return acc;
        },
        []
      );

      return { allUtxos, tokenUtxos };
    } catch (e) {
      logError('UTXOService.fetchAllWalletUtxos', e, { walletId });
      return { allUtxos: [], tokenUtxos: [] };
    }
  },
};

export default UTXOService;
