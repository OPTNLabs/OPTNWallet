// src/services/UTXOService.ts
import {
  cashAddressToLockingBytecode,
  decodeTransaction,
} from '@bitauth/libauth';
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
   * When true, skip the status-hash gate and listunspent every address.
   * Manual Sync clears statuses first so this is usually unnecessary; still
   * available for callers that want an explicit force.
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

      const existingSnapshot = await manager.fetchUTXOsFromDatabase(
        uniqueAddresses.map((address) => ({ address })),
        walletId
      );

      // Option A status-hash gate: skip listunspent when local history status
      // already matches Electrum. Addresses with NO local status are dirty
      // immediately (no probe) — Manual Sync clears statuses first, so without
      // that rule the bar froze at ~20% while we subscribed every address.
      let addressesToFetch = uniqueAddresses;
      if (!options.force) {
        try {
          const ledger = await import('../platform/desktop/WalletLedgerService');
          const partition = await ledger.partitionAddressesByStatus(
            walletId,
            uniqueAddresses
          );
          addressesToFetch = partition.dirty;
          // Intentionally no per-tick console.info. Single-address clean ticks
          // used to flood DevTools (total:1 clean:1). Log only large dirty batches.
          if (
            uniqueAddresses.length >= 20 &&
            partition.dirty.length > 0
          ) {
            console.info('[UTXOService] status-hash gate', {
              total: uniqueAddresses.length,
              dirty: partition.dirty.length,
              clean: partition.clean.length,
              probed: partition.probed,
            });
          }
        } catch {
          addressesToFetch = uniqueAddresses;
        }
      }

      // All clean: return SQL snapshot only. No listunspent, no ledger re-apply.
      if (addressesToFetch.length === 0 && !options.force) {
        options.onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
        const fromDb: Record<string, UTXO[]> = {};
        for (const address of uniqueAddresses) {
          fromDb[address] = [
            ...(existingSnapshot.utxosMap[address] ?? []),
            ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
          ];
        }
        return fromDb;
      }

      const tFetch = performance.now();
      let utxosByAddress: Record<string, UTXO[]> = {};
      if (addressesToFetch.length === 0) {
        // force with empty dirty set should not happen; keep progress complete.
        options.onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
      } else {
        try {
          if (options.onProgress) {
            // Map listunspent progress over dirty addresses only, but report against
            // total wallet size so skipped clean addresses still advance the bar.
            const dirtyTotal = addressesToFetch.length;
            const skipped = uniqueAddresses.length - dirtyTotal;
            utxosByAddress = await ElectrumService.getUTXOsMany(
              addressesToFetch,
              (done, _total) => {
                options.onProgress?.(skipped + done, uniqueAddresses.length);
              }
            );
          } else {
            utxosByAddress = await ElectrumService.getUTXOsMany(addressesToFetch);
          }
        } catch (fetchError) {
          // Soft-fail on transport/backoff: keep last SQL snapshot so balance
          // does not wipe when Electrum is reconnecting (user saw
          // "reconnect backoff" right after a healthy open).
          const msg =
            fetchError instanceof Error ? fetchError.message : String(fetchError);
          if (
            /backoff|connection lost|not connected|timeout|ECONN/i.test(msg)
          ) {
            logError('UTXOService.fetchAndStoreUTXOsMany.softFail', fetchError, {
              walletId,
              addressCount: addressesToFetch.length,
            });
            options.onProgress?.(
              uniqueAddresses.length,
              uniqueAddresses.length
            );
            const fromDb: Record<string, UTXO[]> = {};
            for (const address of uniqueAddresses) {
              fromDb[address] = [
                ...(existingSnapshot.utxosMap[address] ?? []),
                ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
              ];
            }
            return fromDb;
          }
          throw fetchError;
        }
      }
      // Log only real network work (or multi-address batches).
      if (uniqueAddresses.length > 1 && addressesToFetch.length > 0) {
        console.info('[UTXOService] getUTXOsMany took', {
          ms: Math.round(performance.now() - tFetch),
          addresses: addressesToFetch.length,
          skippedClean: uniqueAddresses.length - addressesToFetch.length,
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
        const fetchedUTXOs = utxosByAddress[address];
        if (!fetchedUTXOs) {
          formattedByAddress[address] = [
            ...(existingSnapshot.utxosMap[address] ?? []),
            ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
          ].filter(
            (utxo) => !reservedOutpoints.has(outpointKey(utxo))
          );
          continue;
        }

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

      await manager.replaceWalletAddressUTXOs(walletId, formattedByAddress);

      // Option A (docs/wallet-ledger-sync-design.md):
      //   listunspent → applyAddressUtxoSnapshot → (wallet-wide) rebuild SQL.
      // CRITICAL: single-address subscription must NOT call
      // rebuildUtxosFromLedger — that DELETEs every UTXO for the wallet and
      // rewrites from the ledger after only one address was updated, which is
      // the verified console flood (total:1) + fake balance path on wallet 5.
      try {
        const { ensureDesktopLedgerTables } = await import(
          '../platform/desktop/desktopSchema'
        );
        const { applyAddressUtxoSnapshot, rebuildUtxosFromLedger } =
          await import('../platform/desktop/WalletLedgerService');
        await ensureDesktopLedgerTables();
        for (const address of uniqueAddresses) {
          const list = formattedByAddress[address] ?? [];
          await applyAddressUtxoSnapshot(walletId, {
            address,
            utxos: list.map((u) => ({
              tx_hash: u.tx_hash,
              tx_pos: u.tx_pos,
              value: u.value ?? u.amount ?? 0,
              height: u.height,
              token: u.token,
              prefix: u.prefix,
              tokenAddress: u.tokenAddress,
            })),
          });
        }
        const walletWidePass =
          options.force === true || uniqueAddresses.length > 1;
        if (walletWidePass) {
          await rebuildUtxosFromLedger(walletId);
        }
      } catch (ledgerError) {
        // Ledger is additive; classic UTXO path already wrote replaceWalletAddressUTXOs
        logError('UTXOService.fetchAndStoreUTXOsMany.ledger', ledgerError, {
          walletId,
        });
      }

      const dbService = DatabaseService();
      if (isWebPlatform()) {
        await dbService.flushDatabaseToFile(walletId);
      } else {
        dbService.scheduleDatabaseSave(walletId);
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
