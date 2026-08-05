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

      const walletWide = uniqueAddresses.length > 1 || options.force === true;

      // Cheap heal only: drop sticky external: spends. Do NOT rebuildUtxosFromLedger
      // here — that DELETE+rewrite of the whole UTXO table on every open blocked
      // the main thread long enough for a black/blank wallet window.
      if (walletWide) {
        try {
          const ledger = await import('../platform/desktop/WalletLedgerService');
          await ledger.clearSyntheticExternalSpends(walletId);
        } catch {
          /* ledger optional */
        }
      }

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
          addressesToFetch = [...partition.dirty];
          // History status clean but SQL empty + non-empty history status =
          // corrupted cache (status didn't change when we falsely spent coins).
          // Force listunspent for those addresses.
          const statusMap = await ledger.getAddressHistoryStatusMap(walletId);
          for (const address of partition.clean) {
            const n =
              (existingSnapshot.utxosMap[address]?.length ?? 0) +
              (existingSnapshot.cashTokenUtxosMap[address]?.length ?? 0);
            if (n > 0) continue;
            const st = statusMap.get(address);
            if (st != null && st !== ledger.EMPTY_HISTORY_STATUS) {
              addressesToFetch.push(address);
            }
          }
          addressesToFetch = Array.from(new Set(addressesToFetch));
          if (
            uniqueAddresses.length >= 20 &&
            addressesToFetch.length > 0
          ) {
            console.info('[UTXOService] status-hash gate', {
              total: uniqueAddresses.length,
              dirty: addressesToFetch.length,
              clean: uniqueAddresses.length - addressesToFetch.length,
              probed: partition.probed,
            });
          }
        } catch {
          addressesToFetch = uniqueAddresses;
        }
      }

      // All clean (Selene: state unchanged for everyone we care about).
      // Wallet-wide: still project balance from ledger after clearing sticky
      // external spends (EC: one truth). No mass listunspent.
      if (addressesToFetch.length === 0 && !options.force) {
        options.onProgress?.(uniqueAddresses.length, uniqueAddresses.length);
        if (walletWide) {
          try {
            const {
              rebuildUtxosFromLedger,
              listUnspentFromLedger,
            } = await import('../platform/desktop/WalletLedgerService');
            await rebuildUtxosFromLedger(walletId);
            const { byAddress } = await listUnspentFromLedger(walletId);
            return byAddress;
          } catch {
            /* fall through to SQL snapshot */
          }
        }
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

        const fetchedUTXOs = utxosByAddress[address] ?? [];
        const previousUtxos = [
          ...(existingSnapshot.utxosMap[address] ?? []),
          ...(existingSnapshot.cashTokenUtxosMap[address] ?? []),
        ];

        // Refuse empty listunspent over non-empty prior without force.
        // Background refresh / block tip must not wipe coins on a flaky empty
        // response (Manual Sync uses force:true and may legitimately clear).
        if (
          fetchedUTXOs.length === 0 &&
          previousUtxos.length > 0 &&
          options.force !== true
        ) {
          console.info(
            '[UTXOService] ignore empty listunspent over non-empty prior',
            { walletId, address, prior: previousUtxos.length }
          );
          formattedByAddress[address] = previousUtxos.filter(
            (utxo) => !reservedOutpoints.has(outpointKey(utxo))
          );
          continue;
        }

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

      // ── Option A hybrid (EC + Selene) ───────────────────────────────────
      // Electron Cash: balance = get_addr_utxo from txi/txo (ledger unspents).
      //   Dirty listunspent → applyAddressUtxoSnapshot → rebuild cache
      //   → Redux ALWAYS from ledger projection (never a parallel listunspent
      //   boss that can diverge).
      // Selene: status unchanged → no-op (gate above); single-address notify
      //   never full-wallet rebuilds SQL, but still returns ledger coins for
      //   that address only.
      //
      // SQL UTXOs are written ONLY after ledger projection (below) so a
      // refuse-empty formatted map cannot re-poison the cache ahead of txi/txo.
      const walletWidePass =
        options.force === true || uniqueAddresses.length > 1;
      try {
        const { ensureDesktopLedgerTables } = await import(
          '../platform/desktop/desktopSchema'
        );
        const {
          applyAddressUtxoSnapshot,
          rebuildUtxosFromLedger,
          listUnspentFromLedger,
        } = await import('../platform/desktop/WalletLedgerService');
        await ensureDesktopLedgerTables();

        // Apply listunspent into ledger — but NEVER empty[] without force.
        // 0457a2e9 regression: formatted map refused empty, then we still
        // applied empty into ledger_txi as external: → fake low balance.
        // SQL priorCount is not enough: walletWide clearSynthetic heals the
        // ledger while SQL can still look empty, so empty would re-poison.
        // Real spends: Manual Sync (force) or EC raw-tx → ledger_txi.
        for (const address of Object.keys(utxosByAddress)) {
          const netList = utxosByAddress[address] ?? [];
          if (netList.length === 0 && options.force !== true) {
            console.info(
              '[UTXOService] skip ledger apply: empty listunspent without force',
              { walletId, address }
            );
            continue;
          }

          // Prefer token-merged rows when same non-empty outpoint set.
          const merged = formattedByAddress[address];
          const toApply =
            merged &&
            merged.length === netList.length &&
            netList.length > 0
              ? merged.map((u) => ({
                  tx_hash: u.tx_hash,
                  tx_pos: u.tx_pos,
                  value: u.value ?? u.amount ?? 0,
                  height: u.height,
                  token: u.token,
                  prefix: u.prefix,
                  tokenAddress: u.tokenAddress,
                }))
              : netList.map((utxo: UTXO) => ({
                  tx_hash: utxo.tx_hash,
                  tx_pos: utxo.tx_pos,
                  value: utxo.value ?? utxo.amount ?? 0,
                  height: utxo.height,
                  token: utxo.token,
                  prefix: utxo.prefix,
                  tokenAddress: (utxo as UTXO & { tokenAddress?: string })
                    .tokenAddress,
                }));
          await applyAddressUtxoSnapshot(walletId, {
            address,
            utxos: toApply,
          });
        }

        const { byAddress: ledgerByAddress } =
          await listUnspentFromLedger(walletId);

        if (walletWidePass) {
          await rebuildUtxosFromLedger(walletId);
          // Pending outbound (0-conf fusion/send) still layered for UI, like EC
          // showing unconfirmed without inventing permanent ledger rows.
          for (const pending of await collectPendingOutboundOwnedUtxos(
            walletId,
            Object.keys(ledgerByAddress).length
              ? Object.keys(ledgerByAddress)
              : uniqueAddresses
          )) {
            if (reservedOutpoints.has(outpointKey(pending))) continue;
            const existing = ledgerByAddress[pending.address] ?? [];
            if (
              !existing.some(
                (utxo) => outpointKey(utxo) === outpointKey(pending)
              )
            ) {
              ledgerByAddress[pending.address] = [...existing, pending];
            }
          }
          const dbService = DatabaseService();
          if (isWebPlatform()) {
            await dbService.flushDatabaseToFile(walletId);
          } else {
            dbService.scheduleDatabaseSave(walletId);
          }
          if (uniqueAddresses.length >= 20) {
            const totalSats = Object.values(ledgerByAddress)
              .flat()
              .reduce((s, u) => s + (u.value ?? u.amount ?? 0), 0);
            console.info('[UTXOService] ledger balance (EC source of truth)', {
              walletId,
              addresses: Object.keys(ledgerByAddress).length,
              coins: Object.values(ledgerByAddress).flat().length,
              totalSats,
            });
          }
          return ledgerByAddress;
        }

        // Single-address (Selene notify): coins from ledger for that address
        // only — never return the raw listunspent map as a second boss.
        const singleOut: Record<string, UTXO[]> = {};
        for (const address of uniqueAddresses) {
          singleOut[address] = ledgerByAddress[address] ?? [];
        }
        for (const pending of await collectPendingOutboundOwnedUtxos(
          walletId,
          uniqueAddresses
        )) {
          if (reservedOutpoints.has(outpointKey(pending))) continue;
          const existing = singleOut[pending.address] ?? [];
          if (
            !existing.some((utxo) => outpointKey(utxo) === outpointKey(pending))
          ) {
            singleOut[pending.address] = [...existing, pending];
          }
        }
        // Per-address SQL cache only (no full-wallet DELETE rebuild).
        await manager.replaceWalletAddressUTXOs(walletId, singleOut);
        const dbService = DatabaseService();
        if (isWebPlatform()) {
          await dbService.flushDatabaseToFile(walletId);
        } else {
          dbService.scheduleDatabaseSave(walletId);
        }
        return singleOut;
      } catch (ledgerError) {
        logError('UTXOService.fetchAndStoreUTXOsMany.ledger', ledgerError, {
          walletId,
        });
      }

      // Ledger unavailable: fall back to formatted network/SQL map.
      await manager.replaceWalletAddressUTXOs(walletId, formattedByAddress);
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
