// src/services/UTXOService.ts
import {
  cashAddressToLockingBytecode,
  decodeTransaction,
} from '@bitauth/libauth';
import ElectrumService, { invalidateUTXOCache } from './ElectrumService';
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

const bcmrCache = new Map<string, { ts: number; data: Awaited<ReturnType<BcmrService['getSnapshot']>> | null }>();
const BCMR_CACHE_TTL_MS = 300_000;

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
  // Lowercase txid so reserved-outbound filters match Electrum casing.
  return `${String(utxo.tx_hash).trim().toLowerCase()}:${utxo.tx_pos}`;
}

async function collectReservedOutboundOutpointKeys(
  walletId: number
): Promise<Set<string>> {
  const reserved =
    await OutboundTransactionTracker.listReservedOutpoints(walletId);
  return new Set(reserved.map((outpoint) => outpointKey(outpoint)));
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

async function collectPendingOutboundOwnedUtxos(
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

  const pendingOwnedUtxos: UTXO[] = [];

  for (const record of activeRecords) {
    const decoded = decodeTransaction(hexToBin(record.rawTx));
    if (typeof decoded === 'string') continue;

    decoded.outputs.forEach((output, outputIndex) => {
      const lockingBytecodeHex = binToHex(output.lockingBytecode);
      const address = walletBytecodes.get(lockingBytecodeHex);
      if (!address) return;

      const token = decodedOutputToToken(output);
      pendingOwnedUtxos.push({
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

  return pendingOwnedUtxos;
}

async function hasElectrumBatchUsage(
  walletId: number,
  batch: { address: string }[]
): Promise<string[]> {
  if (batch.length === 0) return [];

  const addresses = batch.map((item) => item.address);
  // BIP44 discovery is based on transaction history, including mempool
  // entries, not current balance. A history entry is sufficient proof that an
  // address is used; the wallet-wide UTXO fetch immediately after discovery
  // obtains the spendable outputs. Keeping this probe to one batched RPC avoids
  // doubling node load for every gap-limit window.
  const historiesByAddress =
    await TransactionManager().fetchAndStoreTransactionHistories(
      walletId,
      addresses
    );

  return batch
    .filter((item) => {
      const history = historiesByAddress[item.address];
      return Array.isArray(history) && history.length > 0;
    })
    .map((item) => item.address);
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
  const metadataByCategory = new Map<
    string,
    Awaited<ReturnType<BcmrService['getSnapshot']>>
  >();

  const metadataResults = await Promise.all(
    categoryList.map(async (category) => {
      try {
        const cached = bcmrCache.get(category);
        if (cached && Date.now() - cached.ts < BCMR_CACHE_TTL_MS) {
          return { category, metadata: cached.data };
        }
        const metadata = await bcmrService.getSnapshot(category);
        bcmrCache.set(category, { ts: Date.now(), data: metadata });
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
    existingUtxos.map(
      (utxo) => [`${utxo.tx_hash}:${utxo.tx_pos}`, utxo] as const
    )
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

type UTXOFetchOptions = {
  /**
   * Account discovery is useful during worker/bootstrap refreshes, but send
   * screens should only refresh addresses already owned by the wallet. A
   * spending action must not block on a new BIP44 history scan.
   */
  discover?: boolean;
  /**
   * Full-pass flag (open / Manual Sync). HOT already listunspents every address
   * in the call; kept for API compatibility with Manual Sync / open callers.
   */
  force?: boolean;
  /**
   * Reported as Electrum batch chunks complete so the UI can show real,
   * in-flight UTXO progress instead of a coarse coarse phase jump (which made
   * the ETA extrapolate "2s left" while the fetch was actually mid-flight).
   */
  onProgress?: (completedCount: number, totalCount: number) => void;
};

const UTXOService = {
  async fetchAndStoreUTXOs(walletId: number, address: string): Promise<UTXO[]> {
    try {
      // Subscription / single-address path: never BIP44 rediscovery, never
      // full-wallet ledger rebuild (that rewrote every UTXO on each notify and
      // produced fake balances + console floods of total:1 dirty:1).
      const results = await UTXOService.fetchAndStoreUTXOsMany(
        walletId,
        [address],
        { discover: false }
      );
      return results[address] ?? [];
    } catch (error) {
      logError('UTXOService.fetchAndStoreUTXOs', error, { walletId, address });
      // A subscription refresh must distinguish "the address is empty" from
      // "the server disconnected". Returning [] here made the worker erase a
      // previously visible balance after any transport-wide failure.
      throw error;
    }
  },

  async fetchAndStoreUTXOsMany(
    walletId: number,
    addresses: string[],
    options: UTXOFetchOptions = {}
  ): Promise<Record<string, UTXO[]>> {
    try {
      const currentNetwork = store.getState().network.currentNetwork;
      const tDiscovery = performance.now();
      const discoveredAddresses =
        options.discover === false
          ? []
          : ((await WalletDiscoveryService.ensureInitialAddressBatches(
              walletId,
              currentNetwork,
              hasElectrumBatchUsage
            )) ?? []);
      if (options.discover !== false) {
        console.info('[UTXOService] discovery took', {
          ms: Math.round(performance.now() - tDiscovery),
          discovered: discoveredAddresses.length,
        });
      }
      const manager = await UTXOManager();
      const addressManager = AddressManager();
      const uniqueAddresses = Array.from(
        new Set([
          ...addresses.filter(Boolean),
          ...discoveredAddresses.filter(Boolean),
        ])
      );
      if (uniqueAddresses.length === 0) return {};

      // Mark entry into the UTXO network phase immediately (manual Sync was
      // stuck on a phase marker until the first Electrum chunk completed).
      options.onProgress?.(0, uniqueAddresses.length);

      // ── HOT path (OPTN 1.7.0 law) ──────────────────────────────────────
      // Always listunspent every address in this call (like Labs 1.7.0).
      // Status-hash "skip clean" was leaving poisoned SQL as balance forever.
      // Single-address subscription still skips via addressHistoryIsFresh in worker.

      const existingSnapshot = await manager.fetchUTXOsFromDatabase(
        uniqueAddresses.map((address) => ({ address })),
        walletId
      );

      // Never serve stale Electrum TTL cache for wallet-wide / force passes.
      for (const address of uniqueAddresses) {
        invalidateUTXOCache(address);
      }

      const tFetch = performance.now();
      let utxosByAddress: Record<string, UTXO[]> = {};
      try {
        utxosByAddress = await ElectrumService.getUTXOsMany(
          uniqueAddresses,
          options.onProgress
            ? (done, total) => options.onProgress?.(done, total)
            : undefined
        );
      } catch (fetchError) {
        // Soft-fail on transport/backoff: keep last SQL so reconnect does not wipe.
        const msg =
          fetchError instanceof Error ? fetchError.message : String(fetchError);
        if (
          /backoff|connection lost|not connected|timeout|ECONN/i.test(msg)
        ) {
          logError('UTXOService.fetchAndStoreUTXOsMany.softFail', fetchError, {
            walletId,
            addressCount: uniqueAddresses.length,
          });
          options.onProgress?.(
            uniqueAddresses.length,
            uniqueAddresses.length
          );
          // Still strip outbound-spent coins so a soft-fail after broadcast
          // cannot re-surface pre-fusion inputs as spendable balance.
          const reservedOutpoints =
            await collectReservedOutboundOutpointKeys(walletId);
          const fromDb: Record<string, UTXO[]> = {};
          for (const address of uniqueAddresses) {
            fromDb[address] = [
              ...(existingSnapshot.utxosMap[address] ?? []),
              ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
            ].filter((utxo) => !reservedOutpoints.has(outpointKey(utxo)));
          }
          return fromDb;
        }
        throw fetchError;
      }
      if (uniqueAddresses.length > 1) {
        console.info('[UTXOService] getUTXOsMany took', {
          ms: Math.round(performance.now() - tFetch),
          addresses: uniqueAddresses.length,
        });
      }
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
      const reservedOutpoints =
        await collectReservedOutboundOutpointKeys(walletId);
      const prefix = getPrefix();
      const formattedByAddress: Record<string, UTXO[]> = {};

      for (const address of uniqueAddresses) {
        // Missing key = RPC failure (not empty). Empty array = server said 0 coins.
        const hasNetworkResult = Object.prototype.hasOwnProperty.call(
          utxosByAddress,
          address
        );
        if (!hasNetworkResult) {
          formattedByAddress[address] = [
            ...(existingSnapshot.utxosMap[address] ?? []),
            ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
          ].filter(
            (utxo) => !reservedOutpoints.has(outpointKey(utxo))
          );
          continue;
        }

        // Network returned a key (including empty []). Trust listunspent like
        // 1.7.0 — do not keep prior coins over an authoritative empty set.
        const fetchedUTXOs = utxosByAddress[address] ?? [];
        const previousUtxos = [
          ...(existingSnapshot.utxosMap[address] ?? []),
          ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
        ];

        const mergedUTXOs = mergeKnownTokenData(
          fetchedUTXOs,
          previousUtxos
        ).filter((utxo) => !reservedOutpoints.has(outpointKey(utxo)));

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

      const pendingOwnedUtxos = await collectPendingOutboundOwnedUtxos(
        walletId,
        uniqueAddresses
      );
      for (const pending of pendingOwnedUtxos) {
        if (reservedOutpoints.has(outpointKey(pending))) continue;
        const existing = formattedByAddress[pending.address] ?? [];
        if (
          !existing.some((utxo) => outpointKey(utxo) === outpointKey(pending))
        ) {
          formattedByAddress[pending.address] = [...existing, pending];
        }
      }

      // HOT write: SQL UTXOs are the durable spendable set; return same map
      // for Redux. No ledger projection (cold archive must not set balance).
      await manager.replaceWalletAddressUTXOs(walletId, formattedByAddress);
      const dbService = DatabaseService();
      if (isWebPlatform()) {
        await dbService.flushDatabaseToFile(walletId);
      } else {
        dbService.scheduleDatabaseSave(walletId);
      }
      if (uniqueAddresses.length >= 20) {
        const totalSats = Object.values(formattedByAddress)
          .flat()
          .reduce((s, u) => s + (u.value ?? u.amount ?? 0), 0);
        console.info('[UTXOService] HOT balance (SQL UTXOs)', {
          walletId,
          addresses: Object.keys(formattedByAddress).length,
          coins: Object.values(formattedByAddress).flat().length,
          totalSats,
        });
      }
      return formattedByAddress;
    } catch (error) {
      logError('UTXOService.fetchAndStoreUTXOsMany', error, {
        walletId,
        addressCount: addresses.length,
      });
      // A transport-wide failure is not an authoritative empty wallet. Let
      // wallet-level callers preserve their last known snapshot and retry on
      // another server instead of replacing every address with zero UTXOs.
      throw error;
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
      const reservedOutpoints =
        await collectReservedOutboundOutpointKeys(walletId);
      const allDbUtxos = Object.values(utxosMap)
        .flat()
        .filter(
          (utxo) =>
            !utxo.token && !reservedOutpoints.has(outpointKey(utxo))
        );
      const dbTokenUtxos = Object.values(cashTokenUtxosMap)
        .flat()
        .filter((utxo) => !reservedOutpoints.has(outpointKey(utxo)));
      const pendingOwnedUtxos = await collectPendingOutboundOwnedUtxos(
        walletId,
        addrs.map((entry) => entry.address)
      );
      const pendingTokenUtxos = pendingOwnedUtxos.filter(
        (utxo) => utxo.token && !reservedOutpoints.has(outpointKey(utxo))
      );
      const pendingBchUtxos = pendingOwnedUtxos.filter(
        (utxo) => !utxo.token && !reservedOutpoints.has(outpointKey(utxo))
      );

      const pendingOutpoints = new Set(
        pendingOwnedUtxos.map((utxo) => outpointKey(utxo))
      );
      const allUtxos = [
        ...allDbUtxos.filter(
          (utxo) => !pendingOutpoints.has(outpointKey(utxo))
        ),
        ...pendingBchUtxos,
      ];
      const tokenUtxos = [...dbTokenUtxos, ...pendingTokenUtxos].reduce<UTXO[]>(
        (acc, utxo) => {
          if (
            !acc.some((existing) => outpointKey(existing) === outpointKey(utxo))
          ) {
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
