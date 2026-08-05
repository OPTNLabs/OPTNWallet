// Settings → Rebuild Wallet (nuclear). Unlike Manual Sync, this wipes chain
// data first, then re-runs bootstrap + history. Keeps keys/seed.

import { store } from '../../state/store';
import { replaceAllUTXOs, setFetchingUTXOs, setSyncingProgress } from '../../state/slices/utxoSlice';
import { setTransactions } from '../../state/slices/transactionSlice';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumService from '../../services/ElectrumService';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';
import { logError } from '../../utils/errorHandling';
import { bootstrapAllUTXOs } from '../../workers/UTXOWorkerService';
import { clearWalletChainData } from './WalletLedgerService';
import { ensureDesktopLedgerTables } from './desktopSchema';

export type RebuildProgress = (message: string, percent?: number) => void;

/**
 * Wipe durable chain data for the active wallet and resync from Electrum.
 * Requires network. Does not delete the wallet or seed.
 */
export async function rebuildActiveWallet(
  onProgress?: RebuildProgress
): Promise<{ ok: true } | { ok: false; error: string }> {
  const walletId = store.getState().wallet_id.currentWalletId;
  const sessionGeneration = store.getState().wallet_id.sessionGeneration ?? 0;
  if (!walletId || walletId <= 0) {
    return { ok: false, error: 'No wallet open.' };
  }

  onProgress?.('Checking network…', 2);
  try {
    await ElectrumService.ensureFreshConnection();
  } catch (error) {
    logError('WalletRebuildService.ensureFreshConnection', error, { walletId });
    return {
      ok: false,
      error: 'No Electrum connection. Rebuild needs a live network.',
    };
  }

  onProgress?.('Clearing chain data…', 10);
  try {
    await ensureDesktopLedgerTables();
    await clearWalletChainData(walletId);
  } catch (error) {
    logError('WalletRebuildService.clear', error, { walletId });
    return { ok: false, error: 'Failed to clear wallet chain data.' };
  }

  // Clear UI immediately so the user does not see stale balances mid-rebuild.
  store.dispatch(replaceAllUTXOs({ utxosByAddress: {} }));
  store.dispatch(
    setTransactions({
      wallet_id: walletId,
      transactions: [],
      sessionGeneration,
    })
  );
  store.dispatch(setFetchingUTXOs(true));
  store.dispatch(setSyncingProgress(15));

  try {
    onProgress?.('Rebuilding UTXOs from network…', 30);
    await bootstrapAllUTXOs();

    onProgress?.('Rebuilding transaction history…', 70);
    store.dispatch(setSyncingProgress(70));
    await refreshWalletTransactionHistory({
      walletId,
      dispatch: store.dispatch,
      sessionGeneration,
      force: true,
      onProgress: (pct) => {
        store.dispatch(setSyncingProgress(70 + Math.round(0.28 * pct)));
        onProgress?.('Rebuilding transaction history…', 70 + Math.round(0.28 * pct));
      },
    });

    DatabaseService().scheduleDatabaseSave(walletId);
    onProgress?.('Rebuild complete.', 100);
    return { ok: true };
  } catch (error) {
    logError('WalletRebuildService.resync', error, { walletId });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Rebuild failed during network resync.',
    };
  } finally {
    store.dispatch(setFetchingUTXOs(false));
    store.dispatch(setSyncingProgress(null));
  }
}
