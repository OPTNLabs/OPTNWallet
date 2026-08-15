// src/workers/UTXOWorkerService.ts
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import ElectrumService from '../services/ElectrumService';
import ContractManager from '../apis/ContractManager/ContractManager';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { store } from '../state/store';
import {
  replaceAllUTXOs,
  setFetchingUTXOs,
  setSyncingProgress,
  updateUTXOsForAddress,
  setInitialized,
  removeUTXOs,
} from '../state/slices/utxoSlice';
import { addTransactions } from '../state/slices/transactionSlice';
import { enqueueNotification } from '../state/slices/notificationsSlice';
import { invalidateUTXOCache } from '../services/ElectrumService';
import { logError, logWarn } from '../utils/errorHandling';
import { UTXO } from '../types/types';
import { runWalletUtxoRefresh } from '../services/RefreshCoordinator';
import { reconcileActiveWalletUtxos } from '../services/WalletUtxoRefreshService';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';
import { preloadTokenMetadata } from '../hooks/useSharedTokenMetadata';
import { syncWalletSpecialActivities } from '../services/WalletSpecialActivityService';

// --- Subscriptions state ---
let started = false;
let headerSubscribed = false;
let utxoStartRetry: NodeJS.Timeout | null = null;
let workerEpoch = 0;
let desiredStarted = false;
let lifecycleQueue: Promise<void> = Promise.resolve();
/** Owner of the Home "Syncing…" flag. Bumped each time we set fetching true so
 *  an abandoned/HMR-cancelled bootstrap still clears the flag when it was the
 *  latest owner, without clobbering a newer bootstrap that took over. */
let fetchingOwner = 0;

interface WorkerSession {
  walletId: number;
  generation: number;
  epoch: number;
}

const subscribedAddresses = new Map<
  string,
  { walletId: number; generation: number }
>();
const contractAddressSet = new Set<string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const contractManager = ContractManager();
const transactionManager = TransactionManager();
const dbService = DatabaseService();
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedRefreshes = new Set<string>();
const walletRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightWalletRefreshes = new Map<string, Promise<void>>();
const queuedWalletRefreshes = new Set<string>();

function collectTokenCategories(
  utxosByAddress: Record<string, UTXO[]>
): string[] {
  return Array.from(
    new Set(
      Object.values(utxosByAddress)
        .flat()
        .map((utxo) => utxo.token?.category)
        .filter((category): category is string => Boolean(category))
    )
  );
}

function isCurrentWalletSession(walletId: number, generation: number): boolean {
  const activeWallet = store.getState().wallet_id;
  return (
    activeWallet.currentWalletId === walletId &&
    (activeWallet.sessionGeneration ?? 0) === generation
  );
}

function isCurrentWorkerContext(session: WorkerSession): boolean {
  return (
    started &&
    workerEpoch === session.epoch &&
    isCurrentWalletSession(session.walletId, session.generation)
  );
}

function captureWorkerSession(epoch = workerEpoch): WorkerSession | null {
  const activeWallet = store.getState().wallet_id;
  if (!activeWallet.currentWalletId) return null;
  return {
    walletId: activeWallet.currentWalletId,
    generation: activeWallet.sessionGeneration ?? 0,
    epoch,
  };
}

function refreshContextKey(address: string, session: WorkerSession): string {
  return `${session.epoch}:${session.generation}:${session.walletId}:${address}`;
}

function walletRefreshContextKey(session: WorkerSession): string {
  return `${session.epoch}:${session.generation}:${session.walletId}`;
}

function refreshAddressSoon(
  address: string,
  ms = 120,
  session = captureWorkerSession()
) {
  if (!session || !isCurrentWorkerContext(session)) return;
  const contextKey = refreshContextKey(address, session);
  const prev = refreshTimers.get(contextKey);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    refreshAddress(address, session).catch((e) =>
      logError('UTXOWorker.refreshAddressSoon', e, {
        address,
        walletId: session.walletId,
      })
    );
    refreshTimers.delete(contextKey);
  }, ms);
  refreshTimers.set(contextKey, t);
}

export function requestUTXORefreshFor(address: string, ms = 80) {
  refreshAddressSoon(address, ms);
}
export function requestUTXORefreshForMany(addresses: string[], ms = 120) {
  for (const a of addresses) refreshAddressSoon(a, ms);
}

function refreshWalletSoon(ms = 120, session = captureWorkerSession()): void {
  if (!session || !isCurrentWorkerContext(session)) return;
  const contextKey = walletRefreshContextKey(session);
  const previous = walletRefreshTimers.get(contextKey);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    if (walletRefreshTimers.get(contextKey) === timer) {
      walletRefreshTimers.delete(contextKey);
    }
    refreshWallet(session).catch((error) =>
      logError('UTXOWorker.refreshWalletSoon', error, {
        walletId: session.walletId,
      })
    );
  }, ms);
  walletRefreshTimers.set(contextKey, timer);
}

/**
 * Coalesce a wallet-wide trigger into one batched Electrum refresh. History
 * polling and new-block notifications can touch dozens of HD addresses at
 * once; scheduling one address task for each would create a synchronized
 * request storm in every open wallet window.
 */
export function requestWalletUTXORefresh(ms = 120): void {
  refreshWalletSoon(ms);
}

export function optimisticRemoveSpentByOutpoints(
  outpoints: Array<{ tx_hash: string; tx_pos: number }>
) {
  const state = store.getState();
  const utxosByAddress = state.utxos.utxos;

  // Index current UTXOs by outpoint
  const index = new Map<string, { address: string; utxo: UTXO }>();
  for (const [addr, list] of Object.entries(utxosByAddress)) {
    for (const u of list)
      index.set(`${u.tx_hash}-${u.tx_pos}`, { address: addr, utxo: u });
  }

  // Group removals per address
  const toRemoveByAddr: Record<string, UTXO[]> = {};
  for (const op of outpoints) {
    const hit = index.get(`${op.tx_hash}-${op.tx_pos}`);
    if (hit) (toRemoveByAddr[hit.address] ??= []).push(hit.utxo);
  }

  const touched = Object.keys(toRemoveByAddr);
  if (touched.length === 0) return;

  // Optimistically remove, invalidate cache and force immediate refresh
  for (const addr of touched) {
    store.dispatch(
      removeUTXOs({ address: addr, utxosToRemove: toRemoveByAddr[addr] })
    );
    invalidateUTXOCache(addr);
  }
  requestUTXORefreshForMany(touched, 0);
}

async function refreshWalletAddress(address: string, session: WorkerSession) {
  if (!isCurrentWorkerContext(session)) return;
  const currentWalletId = session.walletId;
  const prev = store.getState().utxos.utxos[address] ?? [];
  const prevSet = new Set(prev.map((u) => `${u.tx_hash}:${u.tx_pos}`));

  // Option A / Selene: scripthash notify often re-fires the same status.
  // If local history status already matches Electrum, skip history + listunspent
  // entirely (stops console spam of clean:1 / addresses:0 × hundreds).
  try {
    const ledger = await import('../platform/desktop/WalletLedgerService');
    const remote = await ElectrumService.getAddressState(address);
    if (
      await ledger.addressHistoryIsFresh(currentWalletId, address, remote)
    ) {
      return;
    }
  } catch {
    /* fall through to full refresh */
  }

  const updatedHistory =
    await transactionManager.fetchAndStoreTransactionHistory(
      currentWalletId,
      address,
      session.generation
    );
  if (!isCurrentWorkerContext(session)) return;
  if (updatedHistory.length > 0) {
    store.dispatch(
      addTransactions({
        wallet_id: currentWalletId,
        transactions: updatedHistory,
        sessionGeneration: session.generation,
      })
    );
  }

  invalidateUTXOCache(address);
  const utxos = await UTXOService.fetchAndStoreUTXOs(currentWalletId, address);
  if (!isCurrentWorkerContext(session)) return;
  // Ledger projection is authority (EC). Status gate already skipped clean
  // addresses; empty here means dirty+listunspent=[] (real spend) or ledger
  // has no unspents — publish it. Failed listunspent throws / keeps prior.
  store.dispatch(updateUTXOsForAddress({ address, utxos }));

  for (const u of utxos) {
    const key = `${u.tx_hash}:${u.tx_pos}`;
    const height = typeof u.height === 'number' ? u.height : 0;

    if (height > 0) continue;

    if (!prevSet.has(key)) {
      store.dispatch(
        enqueueNotification({
          id: key,
          kind: 'utxo',
          address,
          value: u.value ?? 0,
          txid: u.tx_hash,
          createdAt: Date.now(),
          height,
        })
      );
    }
  }
}

async function performRefreshAddress(address: string, session: WorkerSession) {
  if (!isCurrentWorkerContext(session)) return;
  const currentWalletId = session.walletId;

  // Contract addresses: update via ContractManager, skip popups
  if (contractAddressSet.has(address)) {
    try {
      await contractManager.updateContractUTXOs(address);
    } catch (e) {
      logError('UTXOWorker.refreshAddress.contract', e, { address });
    }
    return;
  }

  try {
    await refreshWalletAddress(address, session);
    if (isCurrentWorkerContext(session)) {
      dbService.scheduleDatabaseSave(currentWalletId);
    }
  } catch (e) {
    logError('UTXOWorker.refreshAddress.wallet', e, {
      address,
      walletId: currentWalletId,
    });
  }
}

async function refreshAddress(address: string, session: WorkerSession) {
  if (!isCurrentWorkerContext(session)) return;
  const contextKey = refreshContextKey(address, session);
  const inflight = inFlightRefreshes.get(contextKey);
  if (inflight) {
    queuedRefreshes.add(contextKey);
    await inflight;
    return;
  }

  const run = (async () => {
    do {
      queuedRefreshes.delete(contextKey);
      await performRefreshAddress(address, session);
    } while (
      queuedRefreshes.has(contextKey) &&
      isCurrentWorkerContext(session)
    );
  })().finally(() => {
    inFlightRefreshes.delete(contextKey);
    queuedRefreshes.delete(contextKey);
  });

  inFlightRefreshes.set(contextKey, run);
  await run;
}

async function performWalletRefresh(session: WorkerSession): Promise<boolean> {
  if (!isCurrentWorkerContext(session)) return true;
  const snapshot = await reconcileActiveWalletUtxos(session.walletId);
  if (!isCurrentWorkerContext(session)) return true;
  return snapshot !== null;
}

async function refreshWallet(session: WorkerSession): Promise<void> {
  if (!isCurrentWorkerContext(session)) return;
  const contextKey = walletRefreshContextKey(session);
  const inflight = inFlightWalletRefreshes.get(contextKey);
  if (inflight) {
    queuedWalletRefreshes.add(contextKey);
    await inflight;
    return;
  }

  const run = (async () => {
    do {
      queuedWalletRefreshes.delete(contextKey);
      const completed = await performWalletRefresh(session);
      if (!completed && isCurrentWorkerContext(session)) {
        // A different wallet-wide refresh may have just finished inside the
        // coordinator's short cooldown. Preserve this trigger as one trailing
        // batch instead of silently dropping it.
        refreshWalletSoon(600, session);
        return;
      }
    } while (
      queuedWalletRefreshes.has(contextKey) &&
      isCurrentWorkerContext(session)
    );
  })().finally(() => {
    inFlightWalletRefreshes.delete(contextKey);
    queuedWalletRefreshes.delete(contextKey);
  });

  inFlightWalletRefreshes.set(contextKey, run);
  await run;
}

export type ExpectedWalletSession = {
  walletId: number;
  sessionGeneration: number;
};

export async function bootstrapAllUTXOs(
  expectedEpoch?: number,
  expectedSession?: ExpectedWalletSession
) {
  const state = store.getState();
  const currentWalletId =
    expectedSession?.walletId ?? state.wallet_id.currentWalletId;
  const sessionGeneration =
    expectedSession?.sessionGeneration ?? state.wallet_id.sessionGeneration ?? 0;
  const bootstrapIsCurrent = () =>
    isCurrentWalletSession(currentWalletId, sessionGeneration) &&
    (expectedEpoch === undefined ||
      isCurrentWorkerContext({
        walletId: currentWalletId,
        generation: sessionGeneration,
        epoch: expectedEpoch,
      }));

  if (!currentWalletId) {
    // Wallet not ready; just exit. Caller will retry.
    return;
  }

  const keyPairs = await KeyService.retrieveKeys(currentWalletId);
  if (!bootstrapIsCurrent()) return;
  if (!keyPairs || keyPairs.length === 0) {
    // Keys not ready; just exit. Caller will retry.
    return;
  }

  // Take ownership of the Syncing flag. If this run is cancelled (HMR, wallet
  // switch, epoch bump) we still clear the flag when we were the latest owner —
  // the previous "only if still current" finally left Home on Syncing forever.
  const myFetch = ++fetchingOwner;
  store.dispatch(setFetchingUTXOs(true));
  // Progress sweeps upward across distinct phases so the Home bar visibly moves
  // even while a single batched network call is in flight (it cannot sub-divide).
  const report = (percent: number) => store.dispatch(setSyncingProgress(percent));

  try {
    report(5);
    const allUTXOs: Record<string, UTXO[]> = {};

    try {
      const { ensureDesktopLedgerTables } = await import(
        '../platform/desktop/desktopSchema'
      );
      await ensureDesktopLedgerTables();
    } catch {
      /* optional on non-desktop */
    }

    // Connect + load tracked addresses in parallel — do not serialize a
    // socket wait with Quantumroot SQL that never needed the network.
    const walletAddresses = keyPairs.map((keyPair) => keyPair.address);
    const connectPromise = ElectrumService.ensureFreshConnection().catch(
      (e) => {
        logError('UTXOWorker.bootstrapAllUTXOs.ensureFreshConnection', e, {
          walletId: currentWalletId,
        });
      }
    );
    let quantumrootAddresses: string[] = [];
    try {
      // listTrackedAddresses must stay O(vaults). It previously re-derived a
      // Quantumroot vault for every HD key index and froze sync at 5%.
      quantumrootAddresses =
        await QuantumrootTrackingService.listTrackedAddresses(currentWalletId);
    } catch (e) {
      logError('UTXOWorker.bootstrapAllUTXOs.quantumroot', e, {
        walletId: currentWalletId,
      });
    }
    if (!bootstrapIsCurrent()) return;

    report(10);
    const trackedAddresses = Array.from(
      new Set([...walletAddresses, ...quantumrootAddresses].filter(Boolean))
    );

    // ── Provisional paint (safe) ────────────────────────────────────────
    // Show last durable SQL balance immediately while Syncing… stays on.
    // Earlier we refused this because a silent stale→correct flash looked
    // like a bug; with the Sync bar + force listunspent below, the network
    // still wins and users get a usable Home in <100ms on reopen.
    try {
      const sqlSnap = await UTXOService.fetchUTXOsFromDatabase(
        trackedAddresses.map((address) => ({ address }))
      );
      if (!bootstrapIsCurrent()) return;
      const provisional: Record<string, UTXO[]> = {};
      let provisionalCoins = 0;
      for (const address of trackedAddresses) {
        const merged = [
          ...(sqlSnap.utxosMap[address] ?? []),
          ...(sqlSnap.cashTokenUtxosMap[address] ?? []),
        ];
        if (merged.length > 0) {
          provisional[address] = merged;
          provisionalCoins += merged.length;
        }
      }
      if (provisionalCoins > 0) {
        store.dispatch(replaceAllUTXOs({ utxosByAddress: provisional }));
        store.dispatch(setInitialized(true));
        console.info('[UTXOWorker] provisional SQL paint', {
          addresses: Object.keys(provisional).length,
          coins: provisionalCoins,
        });
      }
    } catch (e) {
      logError('UTXOWorker.bootstrapAllUTXOs.provisionalSql', e, {
        walletId: currentWalletId,
      });
    }
    if (!bootstrapIsCurrent()) return;
    report(15);

    // Socket should be warm before the HOT listunspent pass.
    await connectPromise;
    if (!bootstrapIsCurrent()) return;
    report(20);

    for (const address of trackedAddresses) invalidateUTXOCache(address);

    // ── Open (HOT / OPTN 1.7.0) ─────────────────────────────────────────
    // force:true — full listunspent of known addresses. Network result
    // replaces the provisional SQL paint above (authoritative).
    const fetchStart = performance.now();
    const fetchedWalletUTXOs = await UTXOService.fetchAndStoreUTXOsMany(
      currentWalletId,
      trackedAddresses,
      {
        discover: false,
        force: true,
        onProgress: (done, total) => {
          if (total <= 0) return;
          const pct = 20 + Math.round(50 * (done / total));
          store.dispatch(setSyncingProgress(Math.min(pct, 69)));
        },
      }
    );
    console.info('[UTXOWorker] fetchAndStoreUTXOsMany took', {
      ms: Math.round(performance.now() - fetchStart),
      addresses: trackedAddresses.length,
      addressCount: Object.keys(fetchedWalletUTXOs).length,
    });
    if (!bootstrapIsCurrent()) return;
    report(70);
    // Discovery may materialize addresses beyond the key set captured above.
    // Publish every address returned by the fetch, not only the pre-discovery
    // subscription list, so a restored wallet's first balance is complete.
    for (const [address, utxos] of Object.entries(fetchedWalletUTXOs)) {
      allUTXOs[address] = utxos;
    }

    // Contract instances (optional; do not block balance paint)
    try {
      // The contract cache is global, but this worker owns exactly one wallet.
      // Scanning every wallet's contracts in every window caused cross-wallet
      // Electrum floods and made ordinary balances appear to hang.
      const instances =
        await contractManager.fetchContractInstances(currentWalletId);
      const contractAddresses = instances.map((i) => i.address);
      const contractResults = await Promise.allSettled(
        contractAddresses.map(async (address) => {
          await contractManager.updateContractUTXOs(address);
          return address;
        })
      );
      for (let i = 0; i < contractResults.length; i++) {
        const result = contractResults[i];
        const address = contractAddresses[i];
        if (result.status === 'fulfilled') {
          contractAddressSet.add(result.value);
          continue;
        }
        logError('UTXOWorker.bootstrapAllUTXOs.contract', result.reason, {
          address,
        });
      }
    } catch (e) {
      logError('UTXOWorker.bootstrapAllUTXOs.contractInit', e);
    }
    if (!bootstrapIsCurrent()) return;
    report(85);

    store.dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));

    // Token icons never block balance/sync completion (web or native).
    const tokenCategories = collectTokenCategories(allUTXOs);
    if (tokenCategories.length > 0) {
      void preloadTokenMetadata(tokenCategories).catch((error) => {
        logError('UTXOWorker.bootstrapAllUTXOs.preloadTokenMetadata', error, {
          walletId: currentWalletId,
          categoryCount: tokenCategories.length,
        });
      });
    }
    if (!bootstrapIsCurrent()) return;

    dbService.scheduleDatabaseSave(currentWalletId);
    store.dispatch(setInitialized(true));
  } finally {
    // A failed Electrum batch is not an empty wallet. Clear Syncing when this
    // attempt still owns the flag — including cancelled/HMR runs that never got
    // a successor bootstrap.
    if (myFetch === fetchingOwner) {
      store.dispatch(setFetchingUTXOs(false));
      store.dispatch(setSyncingProgress(null));
    }
  }
}

async function establishSubscriptions(session: WorkerSession) {
  if (!isCurrentWorkerContext(session)) return;

  // Headers (once)
  if (!headerSubscribed) {
    try {
      await ElectrumService.subscribeBlockHeaders(
        async () => {
          const epoch = workerEpoch;
          const activeSession = captureWorkerSession(epoch);
          refreshWalletSoon(250, activeSession);
          for (const addr of contractAddressSet) {
            refreshAddressSoon(addr, 250, activeSession);
          }
        },
        // A single wallet-wide catch-up runs after every address subscription
        // is installed below, so replaying the current tip would only duplicate it.
        { emitCurrent: false }
      );
      if (!isCurrentWorkerContext(session)) {
        await ElectrumService.unsubscribeBlockHeaders().catch(
          (error: unknown) =>
            logWarn(
              'UTXOWorker.establishSubscriptions.blockHeaders',
              'Discarded a stale header subscription',
              { error }
            )
        );
        return;
      }
      headerSubscribed = true;
    } catch (e) {
      logError('UTXOWorker.establishSubscriptions.blockHeaders', e);
    }
  }

  // Wallet addresses
  try {
    const currentWalletId = session.walletId;

    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    if (!isCurrentWorkerContext(session)) return;
    const walletAddresses = (keyPairs || [])
      .map((k) => k.address)
      .filter(Boolean);
    const quantumrootAddresses =
      await QuantumrootTrackingService.listTrackedAddresses(currentWalletId);
    if (!isCurrentWorkerContext(session)) return;

    const allAddresses = [...walletAddresses, ...quantumrootAddresses];

    const toSubscribe = allAddresses.filter(
      (addr) =>
        !(
          subscribedAddresses.has(addr) &&
          subscribedAddresses.get(addr)?.walletId === session.walletId &&
          subscribedAddresses.get(addr)?.generation === session.generation
        )
    );

    if (toSubscribe.length > 0) {
      // Bulk-subscribe; on later status *change* refresh only that address
      // (Selene). Never refresh the whole set on one notify.
      await ElectrumService.subscribeAddressesBulk(
        toSubscribe,
        (addr) => {
          refreshAddressSoon(addr, 80, session);
        }
      );
      if (!isCurrentWorkerContext(session)) return;
      for (const addr of toSubscribe) {
        subscribedAddresses.set(addr, {
          walletId: session.walletId,
          generation: session.generation,
        });
      }
    }

    // No trailing refreshWalletSoon: open already painted ledger + delta.
    // A second non-force reconcile here was overwriting a good balance.
  } catch (e) {
    logError('UTXOWorker.establishSubscriptions.walletInit', e);
  }

  // (Optional) contract addresses
  for (const addr of contractAddressSet) {
    if (subscribedAddresses.has(addr)) continue;
    if (!isCurrentWorkerContext(session)) return;
    subscribedAddresses.set(addr, {
      walletId: session.walletId,
      generation: session.generation,
    });

    refreshAddressSoon(addr, 0, session);

    try {
      await ElectrumService.subscribeAddress(addr, async () => {
        refreshAddressSoon(addr, 80, session);
      });
      if (!isCurrentWorkerContext(session)) return;
    } catch (e) {
      logError('UTXOWorker.establishSubscriptions.contractAddress', e, {
        address: addr,
      });
    }
  }
}

async function refreshUTXOWorkerSubscriptions() {
  if (!started) return;
  const session = captureWorkerSession();
  if (!session) return;

  try {
    await establishSubscriptions(session);
  } catch (e) {
    logError('UTXOWorker.refreshSubscriptions', e);
  }
}

function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  const run = lifecycleQueue.then(task, task);
  lifecycleQueue = run.catch((error) => {
    logError('UTXOWorker.lifecycle', error);
  });
  return run;
}

function startUTXOWorker(): Promise<void> {
  if (desiredStarted) return lifecycleQueue;
  desiredStarted = true;
  const epoch = ++workerEpoch;

  return enqueueLifecycle(async () => {
    if (!desiredStarted || epoch !== workerEpoch) return;
    const session = captureWorkerSession(epoch);
    if (!session) return;
    started = true;

    const tryStart = async (): Promise<void> => {
      if (!isCurrentWorkerContext(session)) return;
      const keys = await KeyService.retrieveKeys(session.walletId);
      if (!isCurrentWorkerContext(session)) return;
      if (!keys || keys.length === 0) {
        if (utxoStartRetry) clearTimeout(utxoStartRetry);
        utxoStartRetry = setTimeout(() => void tryStart(), 500);
        return;
      }

      if (utxoStartRetry) {
        clearTimeout(utxoStartRetry);
        utxoStartRetry = null;
      }

      try {
        await runWalletUtxoRefresh(session.walletId, async () => {
          await bootstrapAllUTXOs(epoch);
        });
      } catch (e) {
        logError('UTXOWorker.start.bootstrap', e);
      }
      if (!isCurrentWorkerContext(session)) return;

      try {
        // bootstrapAllUTXOs already fetched every wallet address in one batch.
        // One trailing batch after all subscriptions closes both the block and
        // mempool race windows without restoring per-address baseline scans.
        await establishSubscriptions(session);
      } catch (e) {
        logError('UTXOWorker.start.subscriptions', e);
      }

      // The base receive/change UTXO snapshot is authoritative for ordinary
      // wallet state. RPA and Cauldron scans are optional, potentially slow
      // follow-up work; do not make wallet loading or network switching wait
      // for their indexer/Electrum requests. The session guard prevents a
      // scan from persisting records after this wallet/path has been replaced.
      void syncWalletSpecialActivities({
        walletId: session.walletId,
        baseUtxos: Object.values(store.getState().utxos?.utxos ?? {}).flat(),
        isCurrent: () => isCurrentWorkerContext(session),
      }).catch((e) => {
        logError('UTXOWorker.start.specialActivities', e, {
          walletId: session.walletId,
        });
      });
    };

    await tryStart();
  });
}

function stopUTXOWorker(): Promise<void> {
  if (!desiredStarted && !started) return lifecycleQueue;
  desiredStarted = false;
  workerEpoch += 1;

  return enqueueLifecycle(async () => {
    started = false;

    if (utxoStartRetry) {
      clearTimeout(utxoStartRetry);
      utxoStartRetry = null;
    }

    for (const [, timer] of refreshTimers) clearTimeout(timer);
    refreshTimers.clear();
    queuedRefreshes.clear();
    inFlightRefreshes.clear();
    for (const [, timer] of walletRefreshTimers) clearTimeout(timer);
    walletRefreshTimers.clear();
    queuedWalletRefreshes.clear();
    inFlightWalletRefreshes.clear();

    const addressesToUnsubscribe = [...subscribedAddresses.keys()];
    subscribedAddresses.clear();
    contractAddressSet.clear();
    const unsubscribeHeaders = headerSubscribed;
    headerSubscribed = false;

    await Promise.all(
      addressesToUnsubscribe.map((addr) =>
        ElectrumService.unsubscribeAddress(addr).catch((error: unknown) =>
          logWarn(
            'UTXOWorker.stop.unsubscribeAddress',
            'Failed to unsubscribe',
            {
              address: addr,
              error,
            }
          )
        )
      )
    );

    if (unsubscribeHeaders) {
      try {
        await ElectrumService.unsubscribeBlockHeaders();
      } catch (e) {
        logWarn(
          'UTXOWorker.stop.unsubscribeBlockHeaders',
          'Failed to unsubscribe block headers',
          { error: e }
        );
      }
    }
  });
}

export { startUTXOWorker, stopUTXOWorker, refreshUTXOWorkerSubscriptions };
