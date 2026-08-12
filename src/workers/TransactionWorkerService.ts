// src/workers/TransactionWorkerService.ts
import KeyService from '../services/KeyService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { store } from '../redux/store';
import { addTransactions } from '../redux/transactionSlice';
import { INTERVAL } from '../utils/constants';
import { requestUTXORefreshFor } from './UTXOWorkerService';

let transactionInterval: NodeJS.Timeout | null = null;
let transactionStartRetry: NodeJS.Timeout | null = null;

async function fetchAndStoreTransactionHistory() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const transactionManager = TransactionManager();

  if (!currentWalletId) {
    // Wallet not ready yet; just skip quietly.
    return;
  }

  try {
    // Retrieve key pairs for addresses associated with the wallet
    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    if (!keyPairs || keyPairs.length === 0) {
      // Keys not ready yet; skip quietly.
      return;
    }

    // Fetch and store transaction history for each address
    for (const keyPair of keyPairs) {
      const address = keyPair.address;
      const updatedHistory =
        await transactionManager.fetchAndStoreTransactionHistory(
          currentWalletId,
          address
        );

      // Update Redux store with the new transactions
      if (updatedHistory.length > 0) {
        store.dispatch(
          addTransactions({
            wallet_id: currentWalletId,
            transactions: updatedHistory,
          })
        );
      }

      // Ask UTXO worker to refresh this address (keeps UTXO set in sync)
      requestUTXORefreshFor(address, 60);
    }
  } catch (error) {
    console.error('Error fetching and storing transaction history:', error);
  }
}

async function walletReady(): Promise<boolean> {
  const { wallet_id } = store.getState();
  const currentWalletId = wallet_id.currentWalletId;
  if (!currentWalletId) return false;

  try {
    const keys = await KeyService.retrieveKeys(currentWalletId);
    return Array.isArray(keys) && keys.length > 0;
  } catch {
    return false;
  }
}

function startTransactionWorker() {
  if (transactionInterval) return;

  // Defer starting until wallet + keys are available
  const tryStart = async () => {
    if (!(await walletReady())) {
      if (!transactionStartRetry) {
        transactionStartRetry = setTimeout(tryStart, 500);
      } else {
        // Re-arm
        clearTimeout(transactionStartRetry);
        transactionStartRetry = setTimeout(tryStart, 500);
      }
      return;
    }

    // Ready: clear any pending retry
    if (transactionStartRetry) {
      clearTimeout(transactionStartRetry);
      transactionStartRetry = null;
    }

    const { utxos } = store.getState();
    if (!utxos.initialized) {
      // Initial catch-up once
      fetchAndStoreTransactionHistory();
    }

    // Then poll at interval
    transactionInterval = setInterval(fetchAndStoreTransactionHistory, INTERVAL);
  };

  // Kick the first attempt
  tryStart();
}

function stopTransactionWorker() {
  if (transactionStartRetry) {
    clearTimeout(transactionStartRetry);
    transactionStartRetry = null;
  }
  if (transactionInterval) {
    clearInterval(transactionInterval);
    transactionInterval = null;
  }
}

export { startTransactionWorker, stopTransactionWorker };
