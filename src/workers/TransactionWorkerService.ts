// src/workers/TransactionWorkerService.ts
import KeyService from '../services/KeyService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { store } from '../redux/store';
import { addTransactions } from '../redux/transactionSlice';
import { INTERVAL } from '../utils/constants';
import { requestUTXORefreshFor } from './UTXOWorkerService';
import ElectrumService from '../services/ElectrumService';
import { planTransactionDetailRefresh } from '../services/transactionDetailSync';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';

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
    const currentTransactions =
      store.getState().transactions.transactions[currentWalletId] ?? [];
    // Retrieve key pairs for addresses associated with the wallet
    const keyPairs = await KeyService.retrieveKeys(currentWalletId);
    if (!keyPairs || keyPairs.length === 0) {
      // Keys not ready yet; skip quietly.
      return;
    }

    const addresses = [
      ...keyPairs.map((keyPair) => keyPair.address).filter(Boolean),
      ...(await QuantumrootTrackingService.listTrackedAddresses(currentWalletId)),
    ];
    const historyByAddress =
      await transactionManager.fetchAndStoreTransactionHistories(
        currentWalletId,
        addresses
      );

    const mergedByHash = new Map(
      currentTransactions.map((tx) => [tx.tx_hash, tx] as const)
    );
    for (const address of addresses) {
      const updatedHistory = historyByAddress[address] ?? [];
      for (const tx of updatedHistory) {
        mergedByHash.set(tx.tx_hash, tx);
      }
    }
    const nextTransactions = Array.from(mergedByHash.values());
    const refreshPlan = planTransactionDetailRefresh({
      previous: currentTransactions,
      next: nextTransactions,
    });

    const txidsToWarm = refreshPlan.reorgDetected
      ? nextTransactions.map((tx) => tx.tx_hash)
      : refreshPlan.txidsToRefresh;
    if (txidsToWarm.length > 0) {
      void Promise.allSettled(
        txidsToWarm.map((txid) =>
          ElectrumService.getTransactionDetails(txid, {
            forceRefresh: refreshPlan.reorgDetected,
          })
        )
      );
    }

    for (const address of addresses) {
      const updatedHistory = historyByAddress[address] ?? [];
      if (updatedHistory.length > 0) {
        store.dispatch(
          addTransactions({
            wallet_id: currentWalletId,
            transactions: updatedHistory,
          })
        );
      }
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
