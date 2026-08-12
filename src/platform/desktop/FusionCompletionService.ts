import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import WalletBackendSyncService from '../../services/WalletBackendSyncService';
import { refreshActiveWalletUtxos } from '../../services/WalletUtxoRefreshService';
import type { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';
import { recordFusionRound } from './fusionCoinDepth';
import { ownedOutpointsOf, spentOutpointsOf } from './fusionDepthRecorder';

export interface CompletedFusionBroadcast {
  walletId: number;
  txid: string;
  txHex: string;
  spentInputs: UTXO[];
  source: 'p2p-fusion' | 'server-fusion';
  sourceLabel: string;
  /**
   * Locking scripts (hex) of the outputs this round created FOR US.
   *
   * Supplied by the caller because both transports already hold them
   * authoritatively — P2P from `createFreshFusionOutputScripts`, server Fusion
   * from its allocation. Resolving `txid:index` here rather than in the callers
   * keeps output-index handling in one tested place: a round shuffles its
   * outputs so that position reveals nothing, so any caller guessing indices
   * would eventually attribute a peer's coin to us.
   */
  ownedOutputScripts?: readonly string[];
}

export async function completeFusionBroadcast(
  completed: CompletedFusionBroadcast
): Promise<{ tracked: boolean; refreshed: boolean; depthRecorded: number }> {
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

  // Advance per-coin fuse depth. Reached only after a verified broadcast, so a
  // round that failed can never make its coins look more fused than they are.
  // Failure here is non-fatal by design: the transaction is already on the
  // network, and losing a depth record only means a coin may be fused once more
  // than configured — wasteful, never unsafe. Both transports come through this
  // one path, so their accounting cannot drift apart.
  let depthRecorded = 0;
  try {
    const created = ownedOutpointsOf(
      completed.txHex,
      completed.txid,
      completed.ownedOutputScripts ?? []
    );
    if (created.length > 0) {
      recordFusionRound(
        completed.walletId,
        spentOutpointsOf(completed.spentInputs),
        created
      );
      depthRecorded = created.length;
    }
  } catch (error) {
    logError('FusionCompletionService.recordFusionDepth', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  let refreshed = false;
  try {
    refreshed = await refreshActiveWalletUtxos(completed.walletId);
  } catch (error) {
    logError('FusionCompletionService.refreshActiveWalletUtxos', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  return { tracked, refreshed, depthRecorded };
}
