// Settings → Rebuild Wallet (nuclear). Unlike Manual Sync, this wipes chain
// data first, then re-runs bootstrap + history. Keeps keys/seed.

import { store } from '../../state/store';
import { replaceAllUTXOs, setFetchingUTXOs, setSyncingProgress } from '../../state/slices/utxoSlice';
import { setTransactions } from '../../state/slices/transactionSlice';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumService from '../../services/ElectrumService';
import { refreshWalletTransactionHistory } from '../../services/WalletHistoryRefreshService';
import { logError } from '../../utils/errorHandling';
import {
  bootstrapAllUTXOs,
  type ExpectedWalletSession,
} from '../../workers/UTXOWorkerService';
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

  const expectedSession: ExpectedWalletSession = {
    walletId,
    sessionGeneration,
  };
  const isCurrentSession = () => {
    const active = store.getState().wallet_id;
    return (
      active.currentWalletId === expectedSession.walletId &&
      (active.sessionGeneration ?? 0) === expectedSession.sessionGeneration
    );
  };
  const staleResult = () => ({
    ok: false as const,
    error: 'Wallet changed while the rebuild was in progress.',
  });
  const report = (message: string, percent?: number) => {
    if (isCurrentSession()) onProgress?.(message, percent);
  };

  report('Checking network…', 2);
  try {
    await ElectrumService.ensureFreshConnection();
  } catch (error) {
    logError('WalletRebuildService.ensureFreshConnection', error, { walletId });
    return {
      ok: false,
      error: 'No Electrum connection. Rebuild needs a live network.',
    };
  }
  if (!isCurrentSession()) return staleResult();

  report('Clearing chain data…', 10);
  try {
    await ensureDesktopLedgerTables();
    if (!isCurrentSession()) return staleResult();
    await clearWalletChainData(walletId);
  } catch (error) {
    if (!isCurrentSession()) return staleResult();
    logError('WalletRebuildService.clear', error, { walletId });
    return { ok: false, error: 'Failed to clear wallet chain data.' };
  }
  if (!isCurrentSession()) return staleResult();

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
    report('Rebuilding UTXOs from network…', 30);
    if (!isCurrentSession()) return staleResult();
    await bootstrapAllUTXOs(undefined, expectedSession);
    if (!isCurrentSession()) return staleResult();

    report('Rebuilding transaction history…', 70);
    store.dispatch(setSyncingProgress(70));
    await refreshWalletTransactionHistory({
      walletId,
      dispatch: store.dispatch,
      sessionGeneration,
      force: true,
      onProgress: (pct) => {
        if (!isCurrentSession()) return;
        store.dispatch(setSyncingProgress(70 + Math.round(0.28 * pct)));
        report(
          'Rebuilding transaction history…',
          70 + Math.round(0.28 * pct)
        );
      },
    });

    if (!isCurrentSession()) return staleResult();
    DatabaseService().scheduleDatabaseSave(walletId);
    report('Rebuild complete.', 100);
    return { ok: true };
  } catch (error) {
    if (!isCurrentSession()) return staleResult();
    logError('WalletRebuildService.resync', error, { walletId });
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Rebuild failed during network resync.',
    };
  } finally {
    if (isCurrentSession()) {
      store.dispatch(setFetchingUTXOs(false));
      store.dispatch(setSyncingProgress(null));
    }
  }
}
