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
import { backfillConfirmedHistoryHeights } from '../services/historyHeightBackfill';

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
      currentTransactions.map((tx) => [
        String(tx.tx_hash).trim().toLowerCase(),
        { ...tx, tx_hash: String(tx.tx_hash).trim().toLowerCase() },
      ])
    );
    for (const address of addresses) {
      const updatedHistory = historyByAddress[address] ?? [];
      for (const tx of updatedHistory) {
        const hash = String(tx.tx_hash).trim().toLowerCase();
        const existing = mergedByHash.get(hash);
        // Prefer positive height so address history cannot re-stick a fusion
        // row that already received a verbose height write-back.
        const height =
          typeof tx.height === 'number' && tx.height > 0
            ? tx.height
            : typeof existing?.height === 'number' && existing.height > 0
              ? existing.height
              : tx.height;
        mergedByHash.set(hash, {
          ...(existing ?? {}),
          ...tx,
          tx_hash: hash,
          height,
          timestamp: tx.timestamp || existing?.timestamp,
        });
      }
    }

    // Await height backfill BEFORE publishing. Fusion injects height 0; the
    // previous fire-and-forget warm lost races to address-history dispatches
    // and also bailed when Electrum returned confs without height.
    let nextTransactions = Array.from(mergedByHash.values());
    nextTransactions = await backfillConfirmedHistoryHeights({
      walletId: currentWalletId,
      transactions: nextTransactions,
      sessionGeneration,
      forceRefresh: true,
    });

    const activeWallet = store.getState().wallet_id;
    if (
      activeWallet.currentWalletId !== currentWalletId ||
      (activeWallet.sessionGeneration ?? 0) !== sessionGeneration
    ) {
      return;
    }

    if (nextTransactions.length > 0) {
      store.dispatch(
        addTransactions({
          wallet_id: currentWalletId,
          transactions: nextTransactions,
          sessionGeneration,
        })
      );
    }

    const refreshPlan = planTransactionDetailRefresh({
      previous: currentTransactions,
      next: nextTransactions,
    });
    const txidsToWarm = refreshPlan.reorgDetected
      ? nextTransactions.map((tx) => tx.tx_hash)
      : refreshPlan.txidsToRefresh;
    if (txidsToWarm.length > 0) {
      // Detail cache warm only — heights already resolved above.
      void Promise.allSettled(
        txidsToWarm.map((txid) =>
          ElectrumService.getTransactionDetails(txid, {
            forceRefresh: refreshPlan.reorgDetected,
          })
        )
      );
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
