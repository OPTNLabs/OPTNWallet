import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import type { OutboundPrivacyRoute } from '../../services/OutboundTransactionTracker';
import WalletBackendSyncService from '../../services/WalletBackendSyncService';
import { reconcileActiveWalletUtxosForSpend } from '../../services/WalletUtxoRefreshService';
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
  //
  // Prefer locking-script match on the final tx. If that finds nothing (script
  // form drift / decode miss), fall back after Electrum refresh: any UTXO whose
  // tx_hash is this CoinJoin is ours and must advance depth — otherwise Auto
  // keeps re-fusing forever past "Rounds per coin".
  let depthRecorded = 0;
  const spent = spentOutpointsOf(completed.spentInputs);
  try {
    const created = ownedOutpointsOf(
      completed.txHex,
      completed.txid,
      completed.ownedOutputScripts ?? []
    );
    if (created.length > 0) {
      recordFusionRound(completed.walletId, spent, created);
      recordFusionTxid(completed.walletId, completed.txid);
      depthRecorded = created.length;
    } else if (completed.txid) {
      recordFusionTxid(completed.walletId, completed.txid);
    }
  } catch (error) {
    logError('FusionCompletionService.recordFusionDepth', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  // Exclusive force listunspent — do NOT use soft reconcileActiveWalletUtxos.
  // Soft join often returns null while Electrum is busy (common right after a
  // multi-wallet fusion), leaving Redux/SQL on pre-spend coins + pending
  // outbound outputs → inflated "fake" balance until Manual Sync.
  let refreshed = false;
  let snapshot: Awaited<
    ReturnType<typeof reconcileActiveWalletUtxosForSpend>
  > = null;
  if (!torOnly) {
    for (let attempt = 0; attempt < 2 && !refreshed; attempt += 1) {
      try {
        snapshot = await reconcileActiveWalletUtxosForSpend(
          completed.walletId
        );
        refreshed = snapshot !== null;
      } catch (error) {
        logError('FusionCompletionService.refreshAfterBroadcast', error, {
          walletId: completed.walletId,
          txid: completed.txid,
          attempt,
        });
      }
    }
  }

  // Always re-bind depth to Electrum outpoints after refresh when we can see
  // our new UTXOs. Script-based indices can drift from what listunspent returns;
  // without this re-bind, the next round never finds spent ancestors and depth
  // resets 0→1 forever (Auto never stops at rounds-per-coin).
  if (snapshot && completed.txid) {
    try {
      const txid = completed.txid.toLowerCase();
      const fromWallet = Object.values(snapshot)
        .flat()
        .filter(
          (u) =>
            u &&
            typeof u.tx_hash === 'string' &&
            u.tx_hash.toLowerCase() === txid &&
            Number.isSafeInteger(u.tx_pos)
        )
        .map((u) => `${u.tx_hash}:${u.tx_pos}`);
      if (fromWallet.length > 0) {
        recordFusionRound(completed.walletId, spent, fromWallet);
        depthRecorded = fromWallet.length;
        recordFusionTxid(completed.walletId, completed.txid);
      }
    } catch (error) {
      logError('FusionCompletionService.recordFusionDepthFallback', error, {
        walletId: completed.walletId,
        txid: completed.txid,
      });
    }
  }

  try {
    const { fuseDepthEligibility } = await import('./fusionCoinDepth');
    const sample = snapshot
      ? Object.values(snapshot)
          .flat()
          .filter((c) => c && !c.token && !c.token_data)
      : [];
    const elig = fuseDepthEligibility(
      completed.walletId,
      sample,
      99 // log range only
    );
    const msg =
      `w${completed.walletId} depth: recorded ${depthRecorded} output(s) for fuse ` +
      `${completed.txid.slice(0, 12)}… ` +
      `wallet now depths ${elig.minDepth}–${elig.maxCoinDepth} ` +
      `(${elig.total} coin(s))`;
    // Prefer p2p-live file log; fall back to console in tests / no-window.
    void import('./logger')
      .then(({ log }) => {
        try {
          void Promise.resolve(log.info('p2p-live', msg)).catch(() => undefined);
        } catch {
          console.info(`[p2p-live] ${msg}`);
        }
      })
      .catch(() => {
        console.info(`[p2p-live] ${msg}`);
      });
  } catch {
    /* depth verify log is best-effort */
  }

  return { tracked, refreshed, depthRecorded };
}
