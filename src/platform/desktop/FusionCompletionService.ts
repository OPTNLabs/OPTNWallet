import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import type { OutboundPrivacyRoute } from '../../services/OutboundTransactionTracker';
import WalletBackendSyncService from '../../services/WalletBackendSyncService';
import { reconcileActiveWalletUtxosForSpend } from '../../services/WalletUtxoRefreshService';
import type { UTXO } from '../../types/types';
import { logError } from '../../utils/errorHandling';
import { recordFusionRound, recordFusionTxid } from './fusionCoinDepth';
import { ownedOutpointsOf, spentOutpointsOf } from './fusionDepthRecorder';

/**
 * Persist a fusion CoinJoin into the wallet SQL history (P2P + server).
 * Redux-only inject was wiped on Manual Sync / history refresh.
 */
async function persistFusionHistoryRow(
  walletId: number,
  txid: string,
  timestamp: string
): Promise<void> {
  const DatabaseService = (
    await import('../../apis/DatabaseManager/DatabaseService')
  ).default;
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) {
    throw new Error('Wallet database is unavailable.');
  }
  const hash = txid.trim().toLowerCase();
  // height 0 = broadcast not yet in a block. Never overwrite a confirmed height
  // if Electrum already wrote one for this CoinJoin.
  db.run(
    `INSERT INTO transactions (wallet_id, tx_hash, height, timestamp, amount)
     VALUES (?, ?, 0, ?, 0)
     ON CONFLICT(wallet_id, tx_hash) DO UPDATE SET
       timestamp = CASE
         WHEN transactions.timestamp IS NULL OR transactions.timestamp = ''
         THEN excluded.timestamp
         ELSE transactions.timestamp
       END,
       height = CASE
         WHEN COALESCE(transactions.height, 0) > 0 THEN transactions.height
         ELSE excluded.height
       END`,
    [walletId, hash, timestamp]
  );
  // A queued save is not enough here: the Fusion caller releases its round
  // reservation after this function resolves. Keep completion pending until
  // the history row is durable so reload cannot erase an already-broadcast
  // CoinJoin from wallet history.
  await dbService.saveDatabaseToFile(walletId);
}

export interface CompletedFusionBroadcast {
  walletId: number;
  txid: string;
  txHex: string;
  spentInputs: UTXO[];
  source: 'p2p-fusion' | 'server-fusion';
  sourceLabel: string;
  /**
   * Both server and P2P completion use `tor-only`: the round already ran over
   * Tor (or verified independently). Do not re-announce the CoinJoin via the
   * wallet's ordinary Electrum observe path. UTXO refresh + depth + history
   * stamp still run so Auto stop and Fused labels work the same for both.
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
  /**
   * SQL history is durable and the matching Redux row has been injected.
   * Optional so older warning-only snapshots remain source-compatible;
   * completeFusionBroadcast always returns it.
   */
  historyRecorded?: boolean;
}

/** Truthful post-broadcast status shared by both Fusion transports. */
export function fusionCompletionWarning(
  completion: FusionCompletionState
): string | undefined {
  const historyWarning =
    completion.historyRecorded === false
      ? completion.tracked
        ? 'The Fusion transaction is safely tracked, but its wallet history entry could not be saved. Sync the wallet before starting another Fusion round.'
        : 'The Fusion transaction was broadcast, but its wallet history entry could not be saved. Sync the wallet before starting another Fusion round.'
      : undefined;

  let recoveryWarning: string | undefined;
  if (!completion.tracked && !completion.refreshed) {
    recoveryWarning =
      'Wallet tracking and the immediate balance refresh both failed. Sync the wallet before starting another send.';
  } else if (!completion.tracked) {
    recoveryWarning =
      'The balance refreshed, but the outbound tracking record could not be saved.';
  } else if (!completion.refreshed) {
    recoveryWarning =
      'The transaction is safely tracked; the balance will update on the next wallet sync.';
  }

  return (
    [historyWarning, recoveryWarning]
      .filter((warning): warning is string => Boolean(warning))
      .join(' ') || undefined
  );
}

export async function completeFusionBroadcast(
  completed: CompletedFusionBroadcast
): Promise<{
  tracked: boolean;
  refreshed: boolean;
  depthRecorded: number;
  historyRecorded: boolean;
}> {
  // Ensure SQL fusion_txids table exists before we stamp this CoinJoin.
  void import('./fusionCoinDepth')
    .then(({ hydrateFusionLabels }) => hydrateFusionLabels(completed.walletId))
    .catch(() => undefined);

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
    // tor-only fusions are skipped by the ordinary Electrum reconciler, so they
    // used to sit in "Finalizing N transactions" / Outbox forever. Mark seen
    // once we have a verified CoinJoin — same UX end-state as a cleared send.
    if (completed.txid) {
      await OutboundTransactionTracker.markState(
        completed.txid,
        'seen',
        null,
        completed.walletId
      ).catch(() => undefined);
    }
  } catch (error) {
    logError('FusionCompletionService.recordBroadcast', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  // privacyRoute tor-only: do not re-announce via Electrum observe (P2P + server).
  // Wallet UTXO refresh + depth + history below still run for both transports
  // so Auto stop and Fused labels match.
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

  // Shared completion for P2P and server — same depth, labels, Auto stop.
  let depthRecorded = 0;
  let historyRecorded = false;
  const spent = spentOutpointsOf(completed.spentInputs);
  if (completed.txid) {
    try {
      recordFusionTxid(completed.walletId, completed.txid);
    } catch (error) {
      logError('FusionCompletionService.recordFusionTxid', error, {
        walletId: completed.walletId,
        txid: completed.txid,
      });
    }
    // History for Home/Recent Activity — same for P2P and server:
    // stamp Redux + SQL so Manual Sync cannot delete the CoinJoin row.
    try {
      const txid = completed.txid.toLowerCase();
      const timestamp = new Date().toISOString();
      const item = {
        tx_hash: txid,
        height: 0,
        timestamp,
      };
      await persistFusionHistoryRow(completed.walletId, txid, timestamp);
      const { store } = await import('../../state/store');
      const { addTransactions } = await import(
        '../../state/slices/transactionSlice'
      );
      await Promise.resolve(
        store.dispatch(
          addTransactions({
            wallet_id: completed.walletId,
            transactions: [item],
          })
        )
      );
      historyRecorded = true;
    } catch (error) {
      logError('FusionCompletionService.injectHistory', error, {
        walletId: completed.walletId,
        txid: completed.txid,
      });
    }
  }
  try {
    const created = ownedOutpointsOf(
      completed.txHex,
      completed.txid,
      completed.ownedOutputScripts ?? []
    );
    if (created.length > 0) {
      recordFusionRound(completed.walletId, spent, created);
      depthRecorded = created.length;
    }
  } catch (error) {
    logError('FusionCompletionService.recordFusionDepth', error, {
      walletId: completed.walletId,
      txid: completed.txid,
    });
  }

  // Force listunspent so depth re-bind + balance match (P2P and server).
  // One quick retry only — the old 3× with 0.8s/1.6s sleeps added multi-second
  // lag after an already-confirmed broadcast. Depth is already stamped from
  // ownedOutputScripts above; refresh is best-effort balance rebind.
  let refreshed = false;
  let snapshot: Awaited<ReturnType<typeof reconcileActiveWalletUtxosForSpend>> =
    null;
  for (let attempt = 0; attempt < 2 && !refreshed; attempt += 1) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 300));
      }
      snapshot = await reconcileActiveWalletUtxosForSpend(completed.walletId);
      refreshed = snapshot !== null;
    } catch (error) {
      logError('FusionCompletionService.refreshAfterBroadcast', error, {
        walletId: completed.walletId,
        txid: completed.txid,
        attempt,
      });
    }
  }

  // Re-bind: only RAISE depth for Electrum-visible outpoints of this CoinJoin.
  // Never call recordFusionRound again (that re-inherits from spent coins that
  // were already deleted and can reset ×N / confuse badges). Labels stay in
  // durable SQL via recordFusionTxid.
  if (snapshot && completed.txid) {
    try {
      const txid = completed.txid.toLowerCase();
      recordFusionTxid(completed.walletId, txid);
      const fromWallet = Object.values(snapshot)
        .flat()
        .filter(
          (u) =>
            u &&
            typeof u.tx_hash === 'string' &&
            u.tx_hash.toLowerCase() === txid &&
            Number.isSafeInteger(u.tx_pos)
        );
      if (fromWallet.length > 0 && depthRecorded === 0) {
        depthRecorded = fromWallet.length;
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
          void Promise.resolve(log.info('p2p-live', msg)).catch(
            () => undefined
          );
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

  return { tracked, refreshed, depthRecorded, historyRecorded };
}
