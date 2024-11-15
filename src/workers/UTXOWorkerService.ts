// src/workers/UTXOWorkerService.ts
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import { store } from '../redux/store';
import { setUTXOs, setFetchingUTXOs } from '../redux/utxoSlice';
import { INTERVAL } from '../utils/constants';

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

  // Update Redux store in a single batch after fetching all UTXOs
  store.dispatch(setUTXOs({ newUTXOs: allUTXOs }));
  store.dispatch(setFetchingUTXOs(false)); // Set fetching UTXOs state to false
  console.log(allUTXOs);
}

function startUTXOWorker() {
  // Fetch UTXOs every minute
  setInterval(fetchAndStoreUTXOs, INTERVAL);

  // Fetch UTXOs immediately after service worker starts
  fetchAndStoreUTXOs();
}

export default startUTXOWorker;
