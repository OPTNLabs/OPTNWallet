// src/workers/UTXOWorkerService.ts
import { Capacitor } from '@capacitor/core';
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
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';
import { preloadTokenMetadata } from '../hooks/useSharedTokenMetadata';

// --- Subscriptions state ---
let started = false;
let headerSubscribed = false;
let utxoStartRetry: NodeJS.Timeout | null = null;
let workerEpoch = 0;
let desiredStarted = false;
let lifecycleQueue: Promise<void> = Promise.resolve();

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

  const updatedHistory =
    await transactionManager.fetchAndStoreTransactionHistory(
      currentWalletId,
      address
    );
  if (!isCurrentWorkerContext(session)) return;
  if (updatedHistory.length > 0) {
    store.dispatch(
      addTransactions({
        wallet_id: currentWalletId,
        transactions: updatedHistory,
      })
    );
  }

  invalidateUTXOCache(address);
  const utxos = await UTXOService.fetchAndStoreUTXOs(currentWalletId, address);
  if (!isCurrentWorkerContext(session)) return;
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

export async function bootstrapAllUTXOs(expectedEpoch?: number) {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const sessionGeneration = state.wallet_id.sessionGeneration ?? 0;
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

  store.dispatch(setFetchingUTXOs(true));

  const allUTXOs: Record<string, UTXO[]> = {};

  // Wallet addresses
  const fetchedWalletUTXOs = await UTXOService.fetchAndStoreUTXOsMany(
    currentWalletId,
    keyPairs.map((keyPair) => keyPair.address)
  );
  if (!bootstrapIsCurrent()) return;
  for (const keyPair of keyPairs) {
    allUTXOs[keyPair.address] = fetchedWalletUTXOs[keyPair.address] ?? [];
  }

  try {
    const quantumrootAddresses =
      await QuantumrootTrackingService.listTrackedAddresses(currentWalletId);
    if (!bootstrapIsCurrent()) return;
    const fetchedQuantumrootUTXOs = await UTXOService.fetchAndStoreUTXOsMany(
      currentWalletId,
      quantumrootAddresses
    );
    if (!bootstrapIsCurrent()) return;
    for (const address of quantumrootAddresses) {
      allUTXOs[address] = fetchedQuantumrootUTXOs[address] ?? [];
    }
  } catch (e) {
    logError('UTXOWorker.bootstrapAllUTXOs.quantumroot', e, {
      walletId: currentWalletId,
    });
  }
  if (!bootstrapIsCurrent()) return;

  // Contract instances
  try {
    const instances = await contractManager.fetchContractInstances();
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

  store.dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));

  const tokenCategories = collectTokenCategories(allUTXOs);
  if (tokenCategories.length > 0) {
    if (Capacitor.getPlatform() === 'web') {
      void preloadTokenMetadata(tokenCategories).catch((error) => {
        logError('UTXOWorker.bootstrapAllUTXOs.preloadTokenMetadata', error, {
          walletId: currentWalletId,
          categoryCount: tokenCategories.length,
        });
      });
    } else {
      await preloadTokenMetadata(tokenCategories);
    }
  }
  if (!bootstrapIsCurrent()) return;

  dbService.scheduleDatabaseSave(currentWalletId);
  store.dispatch(setFetchingUTXOs(false));
  store.dispatch(setInitialized(true));
}

async function establishSubscriptions(session: WorkerSession) {
  if (!isCurrentWorkerContext(session)) return;

  // Headers (once)
  if (!headerSubscribed) {
    try {
      await ElectrumService.subscribeBlockHeaders(async () => {
        const epoch = workerEpoch;
        for (const [addr, owner] of subscribedAddresses) {
          refreshAddressSoon(addr, 250, { ...owner, epoch });
        }
        const activeSession = captureWorkerSession(epoch);
        for (const addr of contractAddressSet) {
          refreshAddressSoon(addr, 250, activeSession);
        }
      });
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

    for (const addr of [...walletAddresses, ...quantumrootAddresses]) {
      const existingOwner = subscribedAddresses.get(addr);
      if (
        existingOwner?.walletId === session.walletId &&
        existingOwner.generation === session.generation
      ) {
        continue;
      }
      subscribedAddresses.set(addr, {
        walletId: session.walletId,
        generation: session.generation,
      });

      // Baseline fetch
      refreshAddressSoon(addr, 0, session);

      try {
        await ElectrumService.subscribeAddress(addr, async () => {
          refreshAddressSoon(addr, 80, session);
        });
        if (!isCurrentWorkerContext(session)) return;
      } catch (e) {
        logError('UTXOWorker.establishSubscriptions.walletAddress', e, {
          address: addr,
        });
      }
    }
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
        await establishSubscriptions(session);
      } catch (e) {
        logError('UTXOWorker.start.subscriptions', e);
      }
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
