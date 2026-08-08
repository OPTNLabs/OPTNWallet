import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import type { Database } from 'sql.js';
import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import KeyService from './KeyService';
import WalletDiscoveryService from './WalletDiscoveryService';
import QuantumrootVaultCacheService from './QuantumrootVaultCacheService';
import { invalidateUTXOCache } from './ElectrumService';
import { refreshWalletTransactionHistory } from './WalletHistoryRefreshService';
import { waitForWalletHistoryRefresh } from './RefreshCoordinator';
import { startUTXOWorker, stopUTXOWorker } from '../workers/UTXOWorkerService';
import { store } from '../state/store';
import {
  setWalletId,
  setWalletNetwork,
  setWalletDerivationPath,
} from '../state/slices/walletSlice';
import { Network, setNetwork } from '../state/slices/networkSlice';
import { resetUTXOs } from '../state/slices/utxoSlice';
import { resetTransactions } from '../state/slices/transactionSlice';
import { clearTransaction } from '../state/slices/transactionBuilderSlice';
import { disconnectHardwareWallet } from '../state/slices/hardwareWalletSlice';
import { clearWalletSpecialActivities } from '../state/slices/walletSpecialActivitySlice';
import {
  beginWalletReconfiguration,
  completeWalletReconfiguration,
  failWalletReconfiguration,
  setWalletReconfigurationStage,
  type WalletOperationKind,
} from '../state/slices/walletReconfigurationSlice';
import type { DerivationPathSource } from '../types/wallet';
import { getBchAccountPath, normalizeBchAccountPath } from './HdWalletService';
import { clearParentTransactionCache } from './psbt/parentTransactions';

export type WalletReconfigurationRequest = {
  walletId: number;
  network: Network;
  derivationPath: string;
  derivationPathSource: DerivationPathSource;
  operation?: Exclude<WalletOperationKind, 'reload'>;
  clearDerivedState?: boolean;
};

let inFlight: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runOptionalDelete(
  db: Pick<Database, 'run'>,
  sql: string,
  params: Parameters<Database['run']>[1]
) {
  try {
    db.run(sql, params);
  } catch {
    // Older databases may not contain optional feature tables.
  }
}

function clearDerivedWalletState(walletId: number): void {
  const db = DatabaseService().getDatabase();
  if (!db) throw new Error('Database is not available.');

  runOptionalDelete(
    db,
    'DELETE FROM instantiated_contracts WHERE address IN (SELECT address FROM cashscript_addresses WHERE wallet_id = ?)',
    [walletId]
  );
  runOptionalDelete(
    db,
    'DELETE FROM cashscript_artifacts WHERE id IN (SELECT artifact_id FROM cashscript_addresses WHERE wallet_id = ?)',
    [walletId]
  );
  runOptionalDelete(
    db,
    'DELETE FROM cashscript_addresses WHERE wallet_id = ?',
    [walletId]
  );
  runOptionalDelete(db, 'DELETE FROM quantumroot_vaults WHERE wallet_id = ?', [
    walletId,
  ]);
  runOptionalDelete(db, 'DELETE FROM transaction_details WHERE wallet_id = ?', [
    walletId,
  ]);
  runOptionalDelete(db, 'DELETE FROM transactions WHERE wallet_id = ?', [
    walletId,
  ]);
  runOptionalDelete(
    db,
    'DELETE FROM wallet_special_activities WHERE wallet_id = ?',
    [walletId]
  );
  runOptionalDelete(db, 'DELETE FROM UTXOs WHERE wallet_id = ?', [walletId]);
  runOptionalDelete(db, 'DELETE FROM addresses WHERE wallet_id = ?', [
    walletId,
  ]);
  runOptionalDelete(db, 'DELETE FROM keys WHERE wallet_id = ?', [walletId]);

  QuantumrootVaultCacheService.clear(walletId);
  WalletDiscoveryService.clear(walletId);
  invalidateUTXOCache();
  store.dispatch(clearWalletSpecialActivities(walletId));
}

async function resetReduxForWalletReload(walletId: number): Promise<void> {
  // setWalletId intentionally keeps the wallet mounted while incrementing the
  // session generation. This invalidates stale async work without routing the
  // user through the onboarding screen during a long resynchronization.
  store.dispatch(setWalletId(walletId));
  store.dispatch(resetUTXOs());
  store.dispatch(resetTransactions());
  store.dispatch(clearTransaction());
  store.dispatch(disconnectHardwareWallet());
}

async function resyncWallet(walletId: number): Promise<void> {
  await startUTXOWorker();
  const sessionGeneration =
    typeof store.getState === 'function'
      ? store.getState().wallet_id.sessionGeneration ?? 0
      : undefined;
  await refreshWalletTransactionHistory({
    walletId,
    dispatch: store.dispatch,
    sessionGeneration,
  });
}

async function refreshDesktopWalletFileMirror(walletId: number): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))
    return;
  try {
    const { refreshWalletFileMirror } = await import(
      '../platform/desktop/DesktopWalletManager'
    );
    await refreshWalletFileMirror(walletId);
  } catch (error) {
    // The database remains authoritative; a failed mirror is recoverable via
    // the explicit wallet export flow.
    console.warn(
      '[WalletReconfiguration] desktop wallet-file mirror failed:',
      error
    );
  }
}

export async function reloadActiveWallet(walletId: number): Promise<void> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('Invalid wallet id for reload.');
  }
  if (inFlight) return inFlight;

  store.dispatch(beginWalletReconfiguration({ kind: 'reload' }));
  inFlight = (async () => {
    try {
      await stopUTXOWorker();
      await resetReduxForWalletReload(walletId);
      await waitForWalletHistoryRefresh(walletId, { resetCooldown: true });
      invalidateUTXOCache();
      try {
        await ElectrumServer().electrumDisconnect();
      } catch {
        // The next worker start reconnects against the active network.
      }
      store.dispatch(setWalletReconfigurationStage('syncing'));
      await resyncWallet(walletId);
      store.dispatch(completeWalletReconfiguration());
    } catch (error) {
      store.dispatch(failWalletReconfiguration(errorMessage(error)));
      throw error;
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function reconfigureActiveWallet(
  request: WalletReconfigurationRequest
): Promise<void> {
  if (!Number.isSafeInteger(request.walletId) || request.walletId <= 0) {
    throw new Error('Invalid wallet id for reconfiguration.');
  }
  const derivationPath = normalizeBchAccountPath(request.derivationPath);
  if (inFlight) return inFlight;

  const operation = request.operation ?? 'network-switch';
  store.dispatch(
    beginWalletReconfiguration({
      kind: operation,
      targetNetwork: request.network,
    })
  );
  inFlight = (async () => {
    try {
      const dbService = DatabaseService();
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (!db) throw new Error('Database is not available.');

      await stopUTXOWorker();
      await resetReduxForWalletReload(request.walletId);
      await waitForWalletHistoryRefresh(request.walletId, {
        resetCooldown: true,
      });
      invalidateUTXOCache();
      clearParentTransactionCache();
      try {
        await ElectrumServer().electrumDisconnect();
      } catch {
        // The next worker start reconnects against the target network.
      }

      store.dispatch(setWalletReconfigurationStage('clearing'));
      await WalletDiscoveryService.waitForIdle(request.walletId);
      if (request.clearDerivedState !== false) {
        clearDerivedWalletState(request.walletId);
      }

      db.run(
        'UPDATE wallets SET networkType = ?, derivation_path = ?, derivation_path_source = ?, birth_height = NULL WHERE id = ?',
        [
          request.network,
          derivationPath,
          request.derivationPathSource,
          request.walletId,
        ]
      );
      dbService.scheduleDatabaseSave(request.walletId);
      await dbService.flushDatabaseToFile(request.walletId);
      await refreshDesktopWalletFileMirror(request.walletId);

      store.dispatch(setWalletNetwork(request.network));
      store.dispatch(setNetwork(request.network));
      store.dispatch(
        setWalletDerivationPath({
          path: derivationPath,
          source: request.derivationPathSource,
        })
      );

      store.dispatch(setWalletReconfigurationStage('deriving'));
      // Materialize the BIP44 gap-limit window before the worker starts. The
      // discovery pass may extend it when the external chain is used.
      await KeyService.bootstrapInitialAddressBatch(request.walletId, 0, 20);
      store.dispatch(setWalletId(request.walletId));

      store.dispatch(setWalletReconfigurationStage('syncing'));
      await resyncWallet(request.walletId);
      await dbService.flushDatabaseToFile(request.walletId);
      store.dispatch(completeWalletReconfiguration());
    } catch (error) {
      store.dispatch(failWalletReconfiguration(errorMessage(error)));
      throw error;
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export function getDefaultPathForNetwork(network: Network): string {
  return getBchAccountPath(network);
}
