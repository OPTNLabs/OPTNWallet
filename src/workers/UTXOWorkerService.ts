// src/workers/UTXOWorkerService.ts
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import ElectrumService from '../services/ElectrumService';
import ContractManager from '../apis/ContractManager/ContractManager';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { store } from '../redux/store';
import {
  setUTXOs,
  setFetchingUTXOs,
  updateUTXOsForAddress,
  setInitialized,
  removeUTXOs,
} from '../redux/utxoSlice';
import { addTransactions } from '../redux/transactionSlice';
import { enqueueNotification } from '../redux/notificationsSlice';
import { invalidateUTXOCache } from '../services/ElectrumService';
import { logError, logWarn } from '../utils/errorHandling';
import { UTXO } from '../types/types';
import { runWalletUtxoRefresh } from '../services/RefreshCoordinator';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';

// --- Subscriptions state ---
let started = false;
let headerSubscribed = false;
let utxoStartRetry: NodeJS.Timeout | null = null;

const subscribedAddresses = new Set<string>();
const contractAddressSet = new Set<string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const contractManager = ContractManager();
const transactionManager = TransactionManager();
const dbService = DatabaseService();
const inFlightRefreshes = new Map<string, Promise<void>>();
const queuedRefreshes = new Set<string>();

function refreshAddressSoon(address: string, ms = 120) {
  const prev = refreshTimers.get(address);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    refreshAddress(address).catch((e) =>
      logError('UTXOWorker.refreshAddressSoon', e, { address })
    );
    refreshTimers.delete(address);
  }, ms);
  refreshTimers.set(address, t);
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

async function refreshWalletAddress(address: string, currentWalletId: number) {
  const prev = store.getState().utxos.utxos[address] ?? [];
  const prevSet = new Set(prev.map((u) => `${u.tx_hash}:${u.tx_pos}`));

  const updatedHistory = await transactionManager.fetchAndStoreTransactionHistory(
    currentWalletId,
    address
  );
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

async function performRefreshAddress(address: string) {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;

  // Contract addresses: update via ContractManager, skip popups
  if (contractAddressSet.has(address)) {
    try {
      await contractManager.updateContractUTXOs(address);
    } catch (e) {
      logError('UTXOWorker.refreshAddress.contract', e, { address });
    }
    return;
  }

  if (!currentWalletId) return;

  try {
    await refreshWalletAddress(address, currentWalletId);
    dbService.scheduleDatabaseSave();
  } catch (e) {
    logError('UTXOWorker.refreshAddress.wallet', e, { address });
  }
}

async function refreshAddress(address: string) {
  const inflight = inFlightRefreshes.get(address);
  if (inflight) {
    queuedRefreshes.add(address);
    await inflight;
    return;
  }

  const run = (async () => {
    do {
      queuedRefreshes.delete(address);
      await performRefreshAddress(address);
    } while (queuedRefreshes.has(address));
  })().finally(() => {
    inFlightRefreshes.delete(address);
    queuedRefreshes.delete(address);
  });

  inFlightRefreshes.set(address, run);
  await run;
}

async function bootstrapAllUTXOs() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;

  if (!currentWalletId) {
    // Wallet not ready; just exit. Caller will retry.
    return;
  }

  const keyPairs = await KeyService.retrieveKeys(currentWalletId);
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
  for (const keyPair of keyPairs) {
    allUTXOs[keyPair.address] = fetchedWalletUTXOs[keyPair.address] ?? [];
  }

  try {
    const quantumrootAddresses =
      await QuantumrootTrackingService.listTrackedAddresses(currentWalletId);
    const fetchedQuantumrootUTXOs = await UTXOService.fetchAndStoreUTXOsMany(
      currentWalletId,
      quantumrootAddresses
    );
    for (const address of quantumrootAddresses) {
      allUTXOs[address] = fetchedQuantumrootUTXOs[address] ?? [];
    }
  } catch (e) {
    logError('UTXOWorker.bootstrapAllUTXOs.quantumroot', e, {
      walletId: currentWalletId,
    });
  }

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

  store.dispatch(setUTXOs({ newUTXOs: allUTXOs }));
  store.dispatch(setFetchingUTXOs(false));
  store.dispatch(setInitialized(true));
}

async function establishSubscriptions() {
  // Headers (once)
  if (!headerSubscribed) {
    try {
      await ElectrumService.subscribeBlockHeaders(async () => {
        for (const addr of subscribedAddresses) refreshAddressSoon(addr, 250);
        for (const addr of contractAddressSet) refreshAddressSoon(addr, 250);
      });
      headerSubscribed = true;
    } catch (e) {
      logError('UTXOWorker.establishSubscriptions.blockHeaders', e);
    }
  }

  // Wallet addresses
  try {
    const { wallet_id } = store.getState();
    const currentWalletId = wallet_id.currentWalletId;
    if (!currentWalletId) return;

    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    const walletAddresses = (keyPairs || [])
      .map((k) => k.address)
      .filter(Boolean);
    const quantumrootAddresses =
      await QuantumrootTrackingService.listTrackedAddresses(currentWalletId);

    for (const addr of [...walletAddresses, ...quantumrootAddresses]) {
      if (subscribedAddresses.has(addr)) continue;
      subscribedAddresses.add(addr);

      // Baseline fetch
      refreshAddressSoon(addr, 0);

      try {
        await ElectrumService.subscribeAddress(addr, async () => {
          refreshAddressSoon(addr, 80);
        });
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
    subscribedAddresses.add(addr);

    refreshAddressSoon(addr, 0);

    try {
      await ElectrumService.subscribeAddress(addr, async () => {
        refreshAddressSoon(addr, 80);
      });
    } catch (e) {
      logError('UTXOWorker.establishSubscriptions.contractAddress', e, {
        address: addr,
      });
    }
  }
}

async function refreshUTXOWorkerSubscriptions() {
  if (!started) return;

  try {
    await establishSubscriptions();
  } catch (e) {
    logError('UTXOWorker.refreshSubscriptions', e);
  }
}

async function startUTXOWorker() {
  if (started) return;
  started = true;

  const tryStart = async () => {
    // Wait until wallet & keys exist
    const { wallet_id } = store.getState();
    const currentWalletId = wallet_id.currentWalletId;
    if (!currentWalletId) {
      utxoStartRetry && clearTimeout(utxoStartRetry);
      utxoStartRetry = setTimeout(tryStart, 500);
      return;
    }
    const keys = await KeyService.retrieveKeys(currentWalletId);
    if (!keys || keys.length === 0) {
      utxoStartRetry && clearTimeout(utxoStartRetry);
      utxoStartRetry = setTimeout(tryStart, 500);
      return;
    }

    // Ready: clear retry timer
    if (utxoStartRetry) {
      clearTimeout(utxoStartRetry);
      utxoStartRetry = null;
    }

    try {
      await runWalletUtxoRefresh(currentWalletId, async () => {
        await bootstrapAllUTXOs();
      });
    } catch (e) {
      logError('UTXOWorker.start.bootstrap', e);
    }

    try {
      await establishSubscriptions();
    } catch (e) {
      logError('UTXOWorker.start.subscriptions', e);
    }
  };

  tryStart();
}

async function stopUTXOWorker() {
  if (!started) return;
  started = false;

  if (utxoStartRetry) {
    clearTimeout(utxoStartRetry);
    utxoStartRetry = null;
  }

  for (const [, t] of refreshTimers) clearTimeout(t);
  refreshTimers.clear();

  await Promise.all(
    [...subscribedAddresses].map((addr) =>
      ElectrumService.unsubscribeAddress(addr).catch((error: unknown) =>
        logWarn('UTXOWorker.stop.unsubscribeAddress', 'Failed to unsubscribe', {
          address: addr,
          error,
        })
      )
    )
  );
  subscribedAddresses.clear();

  if (headerSubscribed) {
    try {
      await ElectrumService.unsubscribeBlockHeaders();
    } catch (e) {
      logWarn('UTXOWorker.stop.unsubscribeBlockHeaders', 'Failed to unsubscribe block headers', {
        error: e,
      });
    }
    headerSubscribed = false;
  }
}

export { startUTXOWorker, stopUTXOWorker, refreshUTXOWorkerSubscriptions };
