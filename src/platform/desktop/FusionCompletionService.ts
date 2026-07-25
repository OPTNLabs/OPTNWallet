import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import WalletBackendSyncService from '../../services/WalletBackendSyncService';
import { refreshActiveWalletUtxos } from '../../services/WalletUtxoRefreshService';
import type { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';

export interface CompletedFusionBroadcast {
  walletId: number;
  txid: string;
  txHex: string;
  spentInputs: UTXO[];
  source: 'p2p-fusion' | 'server-fusion';
  sourceLabel: string;
}

export async function completeFusionBroadcast(
  completed: CompletedFusionBroadcast
): Promise<{ tracked: boolean; refreshed: boolean }> {
  let tracked = false;
  try {
    await OutboundTransactionTracker.recordBroadcast({
      walletId: completed.walletId,
      rawTx: completed.txHex,
      expectedTxid: completed.txid,
      spentInputs: completed.spentInputs,
      source: completed.source,
      sourceLabel: completed.sourceLabel,
    });
    tracked = true;
  } catch (error) {
    logError('FusionCompletionService.recordBroadcast', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  void Promise.resolve()
    .then(() =>
      WalletBackendSyncService.observeTransaction(
        completed.walletId,
        completed.txid,
        completed.txHex
      )
    )
    .catch((error) => {
      logError('FusionCompletionService.observeTransaction', error, {
        walletId: completed.walletId,
        txid: completed.txid,
      });
    });

  let refreshed = false;
  try {
    refreshed = await refreshActiveWalletUtxos(completed.walletId);
  } catch (error) {
    logError('FusionCompletionService.refreshActiveWalletUtxos', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  return { tracked, refreshed };
}
