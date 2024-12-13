// src/workers/UTXOWorkerService.ts
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import { store } from '../redux/store';
import { setUTXOs, setFetchingUTXOs } from '../redux/utxoSlice';
import { INTERVAL } from '../utils/constants';
import ContractManager from '../apis/ContractManager/ContractManager';

let utxoInterval: NodeJS.Timeout | null = null;

async function fetchAndStoreUTXOs() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const keyPairs = await KeyService.retrieveKeys(currentWalletId);

  if (!currentWalletId || !keyPairs || keyPairs.length === 0) {
    console.error('Missing wallet ID or key pairs');
    return;
  }

  store.dispatch(setFetchingUTXOs(true)); // Set fetching UTXOs state to true

  const allUTXOs: Record<string, any[]> = {};
  for (const keyPair of keyPairs) {
    try {
      const fetchedUTXOs = await UTXOService.fetchAndStoreUTXOs(
        currentWalletId,
        keyPair.address
      );

      allUTXOs[keyPair.address] = fetchedUTXOs;
    } catch (error) {
      console.error(
        `Error fetching UTXOs for address ${keyPair.address}:`,
        error
      );
    }
  }

  const contractManager = ContractManager();
  const instances = await contractManager.fetchContractInstances();
  const contractAddresses = instances.map(instance => instance.address);

  for (const address of contractAddresses) {
    try {
      await contractManager.updateContractUTXOs(address)
    } catch (error) {
      console.error(
        `Error fetching UTXOs for address ${address}:`,
        error
      );
    }
  }

  // Update Redux store in a single batch after fetching all UTXOs
  store.dispatch(setUTXOs({ newUTXOs: allUTXOs }));
  store.dispatch(setFetchingUTXOs(false)); // Set fetching UTXOs state to false
  // console.log(allUTXOs);
}

function startUTXOWorker() {
  if (!utxoInterval) {
    // Fetch UTXOs immediately after service worker starts
    fetchAndStoreUTXOs();
    // Fetch UTXOs at defined intervals
    utxoInterval = setInterval(fetchAndStoreUTXOs, INTERVAL);
  }
}

function stopUTXOWorker() {
  if (utxoInterval) {
    clearInterval(utxoInterval);
    utxoInterval = null;
    // console.log('UTXO Worker stopped');
  }
}

export { startUTXOWorker, stopUTXOWorker };
