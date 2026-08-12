// src/workers/TransactionWorkerService.ts
import KeyService from '../services/KeyService';
import TransactionManager from '../apis/TransactionManager/TransactionManager';
import { store } from '../state/store';
import { addTransactions } from '../state/slices/transactionSlice';
import { INTERVAL } from '../utils/constants';
import { requestWalletUTXORefresh } from './UTXOWorkerService';
import ElectrumService from '../services/ElectrumService';
import { planTransactionDetailRefresh } from '../services/transactionDetailSync';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';

let transactionInterval: NodeJS.Timeout | null = null;
let transactionStartRetry: NodeJS.Timeout | null = null;

async function fetchAndStoreTransactionHistory() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;
  const sessionGeneration = state.wallet_id.sessionGeneration ?? 0;
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
        addresses,
        sessionGeneration
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

    // Always re-check height for unconfirmed rows (fusion injects height 0 and
    // can stay stuck as "Unconfirmed" until a verbose Electrum fetch write-back).
    const unconfirmedStuck = nextTransactions
      .filter((tx) => !(typeof tx.height === 'number' && tx.height > 0))
      .map((tx) => tx.tx_hash);

    const txidsToWarm = Array.from(
      new Set([
        ...(refreshPlan.reorgDetected
          ? nextTransactions.map((tx) => tx.tx_hash)
          : refreshPlan.txidsToRefresh),
        ...unconfirmedStuck,
      ])
    );
    if (txidsToWarm.length > 0) {
      void Promise.allSettled(
        txidsToWarm.map(async (txid) => {
          const details = await ElectrumService.getTransactionDetails(txid, {
            forceRefresh: refreshPlan.reorgDetected,
          });
          // Backfill confirmed height into Redux + SQL (fusion injects height 0).
          if (
            details &&
            typeof details.height === 'number' &&
            details.height > 0 &&
            details.confirmations > 0
          ) {
            store.dispatch(
              addTransactions({
                wallet_id: currentWalletId,
                transactions: [
                  {
                    tx_hash: txid,
                    height: details.height,
                    timestamp: details.timestamp,
                  },
                ],
                sessionGeneration,
              })
            );
            try {
              await transactionManager.applyConfirmedHeight(
                currentWalletId,
                txid,
                details.height,
                details.timestamp
              );
            } catch {
              /* best-effort */
            }
          }
        })
      );
    }

    for (const address of addresses) {
      const activeWallet = store.getState().wallet_id;
      if (
        activeWallet.currentWalletId !== currentWalletId ||
        (activeWallet.sessionGeneration ?? 0) !== sessionGeneration
      ) {
        return;
      }
      const updatedHistory = historyByAddress[address] ?? [];
      if (updatedHistory.length > 0) {
        store.dispatch(
          addTransactions({
            wallet_id: currentWalletId,
            transactions: updatedHistory,
            sessionGeneration,
          })
        );
      }
    }
    requestWalletUTXORefresh(60);
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
