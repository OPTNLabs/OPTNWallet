// src/workers/TransactionWorkerService.ts
import KeyService from '../services/KeyService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { store } from '../redux/store';
import { addTransactions } from '../redux/transactionSlice';
import { INTERVAL } from '../utils/constants';

let transactionInterval: NodeJS.Timeout | null = null;

async function fetchAndStoreTransactionHistory() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const transactionManager = TransactionManager();

  if (!currentWalletId) {
    console.error('Missing wallet ID');
    return;
  }

  try {
    // Retrieve key pairs for addresses associated with the wallet
    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    if (!keyPairs || keyPairs.length === 0) {
      console.error('No key pairs found for wallet ID:', currentWalletId);
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
    }

    // console.log(
    //   `Fetched and stored transaction history for wallet ID ${currentWalletId}`
    // );
  } catch (error) {
    console.error('Error fetching and storing transaction history:', error);
  }
}

function startTransactionWorker() {
  const state = store.getState();
  const IsInitialized = state.utxos.initialized;

  if (!transactionInterval) {
    // Fetch transaction history immediately after worker starts if not initialized
    if (!IsInitialized) {
      fetchAndStoreTransactionHistory();
    }
    // Fetch transaction history at defined intervals
    transactionInterval = setInterval(
      fetchAndStoreTransactionHistory,
      INTERVAL
    );
  }
}

function stopTransactionWorker() {
  if (transactionInterval) {
    clearInterval(transactionInterval);
    transactionInterval = null;
    // console.log('Transaction Worker stopped');
  }
}

export { startTransactionWorker, stopTransactionWorker };
