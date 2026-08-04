import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import type { OutboundPrivacyRoute } from '../../services/OutboundTransactionTracker';
import WalletBackendSyncService from '../../services/WalletBackendSyncService';
import { refreshActiveWalletUtxos } from '../../services/WalletUtxoRefreshService';
import type { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';
import { recordFusionRound, recordFusionTxid } from './fusionCoinDepth';
import { ownedOutpointsOf, spentOutpointsOf } from './fusionDepthRecorder';

export interface CompletedFusionBroadcast {
  walletId: number;
  txid: string;
  txHex: string;
  spentInputs: UTXO[];
  source: 'p2p-fusion' | 'server-fusion';
  sourceLabel: string;
  /**
   * A Tor-only completion is already independently observed by the native
   * relay path. Do not immediately expose its txid or raw transaction through
   * the wallet's ordinary Electrum/backend refresh path.
   */
  privacyRoute?: OutboundPrivacyRoute;
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

export interface FusionCompletionState {
  tracked: boolean;
  refreshed: boolean;
}

/** Truthful post-broadcast status shared by both Fusion transports. */
export function fusionCompletionWarning(
  completion: FusionCompletionState
): string | undefined {
  if (!completion.tracked && !completion.refreshed) {
    return 'Wallet tracking and the immediate balance refresh both failed. Sync the wallet before starting another send.';
  }
  if (!completion.tracked) {
    return 'The balance refreshed, but the outbound tracking record could not be saved.';
  }
  if (!completion.refreshed) {
    return 'The transaction is safely tracked; the balance will update on the next wallet sync.';
  }
  return undefined;
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
      ...(completed.privacyRoute
        ? { privacyRoute: completed.privacyRoute }
        : {}),
    });
    tracked = true;
  } catch (error) {
    logError('FusionCompletionService.recordBroadcast', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  const torOnly = completed.privacyRoute === 'tor-only';
  if (!torOnly) {
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
  }

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
      recordFusionTxid(completed.walletId, completed.txid);
      depthRecorded = created.length;
    } else if (completed.txid) {
      // Still mark the CoinJoin itself for history even if we could not map outputs.
      recordFusionTxid(completed.walletId, completed.txid);
    }
  } catch (error) {
    logError('FusionCompletionService.recordFusionDepth', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  let refreshed = false;
  if (!torOnly) {
    try {
      refreshed = await refreshActiveWalletUtxos(completed.walletId);
    } catch (error) {
      logError('FusionCompletionService.refreshActiveWalletUtxos', error, {
        walletId: completed.walletId,
        txid: completed.txid,
      });
    }
  }

  return { tracked, refreshed, depthRecorded };
}
