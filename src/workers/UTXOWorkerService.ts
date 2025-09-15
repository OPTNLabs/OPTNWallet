// src/workers/UTXOWorkerService.ts
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import ElectrumService from '../services/ElectrumService';
import ContractManager from '../apis/ContractManager/ContractManager';
import { store } from '../redux/store';
import {
  setUTXOs,
  setFetchingUTXOs,
  updateUTXOsForAddress,
} from '../redux/utxoSlice';
import { enqueueNotification } from '../redux/notificationsSlice';

// --- Subscriptions state ---
let started = false;
let headerSubscribed = false;
const subscribedAddresses = new Set<string>();
const contractAddressSet = new Set<string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced per-address refresh to avoid bursts. */
function refreshAddressSoon(address: string, ms = 120) {
  const prev = refreshTimers.get(address);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    refreshAddress(address).catch((e) =>
      console.error('Refresh address failed:', address, e)
    );
    refreshTimers.delete(address);
  }, ms);
  refreshTimers.set(address, t);
}

/** Pull fresh UTXOs and update store; also enqueue in-app notifications for new UTXOs. */
async function refreshAddress(address: string) {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;

  // Contract addresses: update via ContractManager, skip popups
  if (contractAddressSet.has(address)) {
    try {
      const contractManager = ContractManager();
      await contractManager.updateContractUTXOs(address);
    } catch (e) {
      console.error('Contract UTXO update failed:', address, e);
    }
    return;
  }

  if (!currentWalletId) return;

  try {
    // Compare with previous set to find *new* UTXOs
    const prev = state.utxos.utxos[address] ?? [];
    const prevSet = new Set(prev.map((u: any) => `${u.tx_hash}:${u.tx_pos}`));

    const utxos = await UTXOService.fetchAndStoreUTXOs(
      currentWalletId,
      address
    );
    store.dispatch(updateUTXOsForAddress({ address, utxos }));

    // Detect brand-new UTXOs and enqueue popup notifications
    for (const u of utxos) {
      const key = `${u.tx_hash}:${u.tx_pos}`;
      if (!prevSet.has(key)) {
        store.dispatch(
          enqueueNotification({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'utxo',
            address,
            value: u.value ?? 0,
            txid: u.tx_hash,
            createdAt: Date.now(),
          })
        );
      }
    }
  } catch (e) {
    console.error('Wallet UTXO update failed:', address, e);
  }
}

/** One-time bootstrap for wallet + contract UTXOs (batch). */
async function bootstrapAllUTXOs() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const keyPairs = await KeyService.retrieveKeys(currentWalletId);

  if (!currentWalletId || !keyPairs || keyPairs.length === 0) {
    console.error('Missing wallet ID or key pairs');
    return;
  }

  store.dispatch(setFetchingUTXOs(true));

  const allUTXOs: Record<string, any[]> = {};

  // Wallet addresses
  for (const keyPair of keyPairs) {
    try {
      const fetchedUTXOs = await UTXOService.fetchAndStoreUTXOs(
        currentWalletId,
        keyPair.address
      );
      allUTXOs[keyPair.address] = fetchedUTXOs;
    } catch (error) {
      console.error(`Error fetching UTXOs for ${keyPair.address}:`, error);
    }
  }

  // Contract instances
  try {
    const contractManager = ContractManager();
    const instances = await contractManager.fetchContractInstances();
    const contractAddresses = instances.map((i) => i.address);
    for (const address of contractAddresses) {
      try {
        await contractManager.updateContractUTXOs(address);
        contractAddressSet.add(address);
      } catch (error) {
        console.error(`Error fetching contract UTXOs for ${address}:`, error);
      }
    }
  } catch (e) {
    console.error('Contract bootstrap failed:', e);
  }

  store.dispatch(setUTXOs({ newUTXOs: allUTXOs }));
  store.dispatch(setFetchingUTXOs(false));
}

/** Subscriptions: headers + per-address. */
async function establishSubscriptions() {
  // Headers (once)
  if (!headerSubscribed) {
    try {
      await ElectrumService.subscribeBlockHeaders(async (_header: any) => {
        // On each new block, refresh all watched (confirmations bump)
        for (const addr of subscribedAddresses) refreshAddressSoon(addr, 250);
        for (const addr of contractAddressSet) refreshAddressSoon(addr, 250);
      });
      headerSubscribed = true;
    } catch (e) {
      console.error('Failed to subscribe to block headers:', e);
    }
  }

  // Wallet addresses
  try {
    const state = store.getState();
    const currentWalletId = state.wallet_id.currentWalletId;
    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    const walletAddresses = (keyPairs || [])
      .map((k) => k.address)
      .filter(Boolean);

    for (const addr of walletAddresses) {
      if (subscribedAddresses.has(addr)) continue;
      subscribedAddresses.add(addr);

      // Baseline fetch
      refreshAddressSoon(addr, 0);

      try {
        await ElectrumService.subscribeAddress(
          addr,
          async (_status: string) => {
            refreshAddressSoon(addr, 80);
          }
        );
      } catch (e) {
        console.error('subscribeAddress failed for', addr, e);
      }
    }
  } catch (e) {
    console.error('Wallet subscription setup failed:', e);
  }

  // (Optional) Contract addresses—subscribe if server supports address.subscribe for them
  for (const addr of contractAddressSet) {
    if (subscribedAddresses.has(addr)) continue;
    subscribedAddresses.add(addr);

    refreshAddressSoon(addr, 0);

    try {
      await ElectrumService.subscribeAddress(addr, async (_status: string) => {
        refreshAddressSoon(addr, 80);
      });
    } catch (e) {
      console.error('subscribeAddress failed for contract', addr, e);
    }
  }
}

async function startUTXOWorker() {
  if (started) return;
  started = true;

  try {
    await bootstrapAllUTXOs();
  } catch (e) {
    console.error('UTXO bootstrap failed:', e);
  }

  try {
    await establishSubscriptions();
  } catch (e) {
    console.error('Electrum subscription setup failed:', e);
  }
}

async function stopUTXOWorker() {
  if (!started) return;
  started = false;

  for (const [, t] of refreshTimers) clearTimeout(t);
  refreshTimers.clear();

  await Promise.all(
    [...subscribedAddresses].map((addr) =>
      ElectrumService.unsubscribeAddress(addr).catch((e: any) =>
        console.warn('Unsubscribe address failed:', addr, e)
      )
    )
  );
  subscribedAddresses.clear();

  if (headerSubscribed) {
    try {
      await ElectrumService.unsubscribeBlockHeaders();
    } catch (e) {
      console.warn('Unsubscribe headers failed:', e);
    }
    headerSubscribed = false;
  }
}

export { startUTXOWorker, stopUTXOWorker };
