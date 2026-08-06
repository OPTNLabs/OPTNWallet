// The ONE place a fusion round starts — manual button or automatic engine.
//
// Both callers route through `startFusionRound`. The alternative considered was
// leaving the manual handlers in the settings component and giving the engine its
// own copy of the start sequence; that was rejected because the server path does
// status query -> tier choice -> output allocation before running, and two copies
// of that would drift. The automatic path is the one nobody is watching when it
// spends a fee, so it is the worst possible place for a silent divergence.
//
// Coin freshness is this service's job, never the screen's: inputs come either
// from a live reconciliation or from the committed snapshot that just woke the
// automatic engine, never from the Redux UI list. Trusting that list is what
// produced signed CoinJoins referencing coins that were already gone.

import {
  reconcileActiveWalletUtxosForSpend,
  type WalletUtxoSnapshot,
} from '../../services/WalletUtxoRefreshService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import {
  coinsBelowDepth,
  formatAutoDepthGateLog,
  formatAutoDepthMetMessage,
  fuseDepthEligibility,
} from './fusionCoinDepth';
import {
  acquireRoundLease,
  forceClearRoundLease,
  hasLiveRoundLease,
  isAutoCooldownReady,
  isAutoDepthMetIdle,
  LEASE_HEARTBEAT_MS,
  releaseRoundLease,
  stampAutoDepthMetIdle,
  stampAutoFailure,
  stampAutoSuccess,
  touchRoundLease,
  tryClaimAutoCooldown,
} from './fusionWalletLease';
import { clearOutpointReservations } from './fusionRoundState';
import {
  AUTO_FUSION_COOLDOWN_MS,
  AUTO_FUSION_DEPTH_MET_IDLE_MS,
  AUTO_FUSION_EMPTY_POOL_RETRY_MS,
  AUTO_FUSION_RETRY_MS,
  isAutoTransientFailure,
  type FusionMode,
} from './fusionAutoEngine';
import {
  ACCEPT_UNCONFIRMED_FUSION_INPUTS,
  EC_DEFAULT_MAX_COINS,
} from './fusionTiming';

/** Structured, so callers never parse a human string to learn what happened. */
export type FusionRunOutcome =
  | {
      status: 'fused';
      mode: FusionMode;
      txid: string;
      warning?: string;
    }
  | { status: 'busy' }
  /** Wallet state is mid-refresh; not an error, and not a reason to use stale coins. */
  | { status: 'waiting-for-wallet' }
  | { status: 'no-eligible-coins'; detail?: string }
  | { status: 'cancelled' }
  /** Automatic only: the durable fee cooldown has not elapsed, or could not be
   *  claimed exclusively. Distinct from `busy` so callers can say which it was. */
  | { status: 'cooldown' }
  | { status: 'failed'; mode: FusionMode; message: string };

export interface StartFusionRoundOptions {
  walletId: number;
  network: Network;
  mode: FusionMode;
  /** Automatic rounds respect fuse depth; a manual round may re-fuse deliberately. */
  trigger: 'auto' | 'manual';
  fuseDepth: number;
  /** Snapshot supplied only by WalletUtxoRefreshService's post-commit event. */
  freshSnapshot?: WalletUtxoSnapshot;
  onStatus?: (message: string) => void;
  onPhase?: (phase: number) => void;
  signal?: AbortSignal;
  /** Injected so this stays testable without the Tauri/Electrum stack. */
  runners: {
    runP2p: (
      coins: UTXO[],
      signal?: AbortSignal,
      progress?: { onStatus?: (m: string) => void; onPhase?: (p: number) => void }
    ) => Promise<{ txid: string; warning?: string }>;
    runServer: (
      coins: UTXO[],
      signal?: AbortSignal,
      progress?: { onStatus?: (m: string) => void; onPhase?: (p: number) => void }
    ) => Promise<{ txid: string; warning?: string }>;
  };
}

/**
 * Windows in which THIS context holds the lease, for cheap UI state only.
 *
 * Exclusivity itself lives in `fusionWalletLease` (Web Lock + durable record),
 * because a module-level Set is per WebView context: two windows on the same
 * wallet each passed it and could both start a round. Outpoint reservations were
 * the stated fallback, but server Fusion never honoured the P2P reservations, so
 * that path had no protection at all.
 */
const heldLeases = new Map<number, string>();

/**
 * UI-visible lifecycle for a round owned by this wallet WebView.
 *
 * This deliberately lives beside the round lease instead of in a screen
 * component. Settings pages can unmount while a round is gathering peers or
 * signing; navigation must not make the round disappear or cancel it.
 */
export interface FusionActivity {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  startedAt: number;
  /** Live phase 0–5 (P2P stepper / server labels). */
  phase?: number;
  /** Latest status line for CashFusion UI / shell (auto + manual). */
  status?: string | null;
}

/** Last finished auto/manual outcome so the panel shows why fuse failed after idle. */
export interface FusionLastResult {
  walletId: number;
  mode: FusionMode;
  trigger: 'auto' | 'manual';
  ok: boolean;
  message: string;
  at: number;
}

const lastResults = new Map<number, FusionLastResult>();

type FusionActivityListener = (activity: FusionActivity | null) => void;

const fusionActivities = new Map<
  number,
  { lease: string; activity: FusionActivity }
>();
const fusionActivityListeners = new Map<
  number,
  Set<FusionActivityListener>
>();

function emitFusionActivity(walletId: number): void {
  const activity = getFusionActivity(walletId);
  for (const listener of fusionActivityListeners.get(walletId) ?? []) {
    try {
      listener(activity);
    } catch {
      // A view subscriber must never be able to interrupt a financial action.
    }
  }
}

export function getFusionActivity(walletId: number): FusionActivity | null {
  // Activity without a live in-memory lease is a ghost (HMR / failed finally).
  // Never let that greyscale the CashFusion UI as "fusing".
  if (!heldLeases.has(walletId)) {
    if (fusionActivities.has(walletId)) {
      fusionActivities.delete(walletId);
    }
    return null;
  }
  return fusionActivities.get(walletId)?.activity ?? null;
}

/** Last disk-logged line per wallet — status every 2s filled the 5MB log cap. */
const lastLoggedStatus = new Map<number, string>();
const lastLoggedPhase = new Map<number, number>();

/** Collapse countdown noise so "up to 94s" / "up to 92s" is one log family. */
function statusLogKey(status: string): string {
  return status
    .replace(/\b\d+s\b/g, 'Ns')
    .replace(/\b\d+\/\d+\b/g, 'N/M')
    .replace(/\bpeak \d+\b/gi, 'peak N');
}

/** Push phase/status into the live activity (auto-fuse and manual share this). */
export function reportFusionProgress(
  walletId: number,
  update: { phase?: number; status?: string | null }
): void {
  const entry = fusionActivities.get(walletId);
  if (!entry || !heldLeases.has(walletId)) return;
  entry.activity = {
    ...entry.activity,
    ...(update.phase !== undefined ? { phase: update.phase } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
  };
  fusionActivities.set(walletId, entry);
  emitFusionActivity(walletId);
  // Disk + stdout via tauri-plugin-log so agents can tail
  // %LOCALAPPDATA%\com.optilabs.wallet\logs\optn-wallet.log live.
  // Dedup: countdown-only changes used to triple-write every 2s × 4 wallets
  // and hit the 5MB rotation cap mid-run (watcher went blind at 04:01).
  if (update.status) {
    const key = statusLogKey(update.status);
    if (lastLoggedStatus.get(walletId) !== key) {
      lastLoggedStatus.set(walletId, key);
      void import('./logger')
        .then(({ log }) =>
          log.info('p2p-live', `w${walletId} ${update.status}`)
        )
        .catch(() => undefined);
    }
  }
  if (update.phase !== undefined) {
    if (lastLoggedPhase.get(walletId) !== update.phase) {
      lastLoggedPhase.set(walletId, update.phase);
      void import('./logger')
        .then(({ log }) =>
          log.info('p2p-live', `w${walletId} phase=${update.phase}`)
        )
        .catch(() => undefined);
    }
  }
}

export function getFusionLastResult(walletId: number): FusionLastResult | null {
  return lastResults.get(walletId) ?? null;
}

export function setFusionLastResult(
  walletId: number,
  result: Omit<FusionLastResult, 'walletId' | 'at'>
): void {
  lastResults.set(walletId, {
    ...result,
    walletId,
    at: Date.now(),
  });
  // Notify listeners so the CashFusion panel can show auto failure without a round.
  emitFusionActivity(walletId);
}

export function subscribeFusionActivity(
  walletId: number,
  listener: FusionActivityListener
): () => void {
  const listeners =
    fusionActivityListeners.get(walletId) ?? new Set<FusionActivityListener>();
  listeners.add(listener);
  fusionActivityListeners.set(walletId, listeners);
  listener(getFusionActivity(walletId));

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) fusionActivityListeners.delete(walletId);
  };
}

function isCancellationError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'AbortError' || error.message === 'fusion round cancelled'
    );
  }
  return error === 'fusion round cancelled';
}

export function isFusionRunning(walletId: number): boolean {
  return heldLeases.has(walletId);
}

/**
 * Drop durable ghost leases and orphan activity for this wallet when THIS
 * window is not running a round. Called automatically on CashFusion mount and
 * before acquire — users should never need a "clear stuck" button.
 */
export async function reconcileIdleFusionState(walletId: number): Promise<void> {
  if (!Number.isInteger(walletId) || walletId <= 0) return;
  if (heldLeases.has(walletId)) return; // real round in this window
  if (fusionActivities.has(walletId)) {
    fusionActivities.delete(walletId);
    emitFusionActivity(walletId);
  }
  // Reclaim durable lock only if stale (another window may still be live).
  if (!hasLiveRoundLease(walletId)) {
    await forceClearRoundLease(walletId).catch(() => undefined);
    // Ghost input locks from a dead round (HMR / kill) left Start clickable but
    // every coin "committed" — clear them whenever no live lease remains.
    clearOutpointReservations(walletId);
  }
}

// Release our lease if the WebView dies mid-round (reload / close).
if (typeof window !== 'undefined') {
  const releaseOnUnload = () => {
    for (const [walletId, owner] of heldLeases) {
      // Sync best-effort: async release may not finish on unload.
      try {
        const key = `optn-fusion-lease-${walletId}`;
        const raw = window.localStorage?.getItem(key);
        if (!raw) continue;
        const held = JSON.parse(raw) as { owner?: string };
        if (held?.owner === owner) window.localStorage?.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    heldLeases.clear();
    fusionActivities.clear();
  };
  window.addEventListener('pagehide', releaseOnUnload);
  window.addEventListener('beforeunload', releaseOnUnload);
}

// Unconfirmed coins are eligible (ACCEPT_UNCONFIRMED_FUSION_INPUTS). EC-maintainer
// direction endorses fusing 0-conf on BCH — we do not wait for a block before the
// next Auto round. Classic EC still excludes unconfirmed in select_coins /
// validation.py; we do not copy that. Trade-off: spending an unconfirmed parent
// dies if that parent is replaced — rare on BCH; waiting costs liquidity/privacy.

/**
 * EC plugin.py DEFAULT_MAX_COINS = 20. Prefer the largest UTXOs so tiers stay
 * affordable (EC samples randomly; we keep the best batch deterministically).
 */
function limitFusionCoins(coins: UTXO[]): UTXO[] {
  if (coins.length <= EC_DEFAULT_MAX_COINS) return coins;
  return [...coins]
    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
    .slice(0, EC_DEFAULT_MAX_COINS);
}

/**
 * Live, spendable, non-token coins for this wallet.
 *
 * `null` from the refresh means this trigger joined an in-progress refresh or the
 * wallet session changed — it is NOT "no coins". Returning an empty array here
 * would read as "nothing to fuse" and, worse, tempt a caller into falling back to
 * the Redux list. The distinction is preserved all the way out to the caller.
 */
async function freshCoins(
  walletId: number,
  trigger: 'auto' | 'manual',
  fuseDepth: number,
  freshSnapshot?: WalletUtxoSnapshot,
  signal?: AbortSignal
): Promise<UTXO[] | null> {
  // Exclusive listunspent for fusion — shared reconcile soft-fails (null)
  // whenever a background refresh is in flight, which made Fuse feel broken.
  const snapshot =
    freshSnapshot ??
    (await reconcileActiveWalletUtxosForSpend(walletId, signal));
  if (!snapshot) return null;

  const coins = Object.values(snapshot)
    .flat()
    .filter(
      // Both token fields: `token` is our normalised shape, `token_data` is what
      // comes straight off Electrum. A coin carrying either must never be fused
      // — that would burn the CashToken.
      // Unconfirmed (height ≤ 0) kept when ACCEPT_UNCONFIRMED_FUSION_INPUTS.
      (coin): coin is UTXO => {
        if (!coin || coin.token || coin.token_data) return false;
        if (
          !ACCEPT_UNCONFIRMED_FUSION_INPUTS &&
          typeof coin.height === 'number' &&
          coin.height <= 0
        ) {
          return false;
        }
        return true;
      }
    );

  // Depth bounds automatic spending only. A user who clicks Fuse Now is making an
  // explicit choice and may re-fuse a coin that has already reached the limit.
  const eligible =
    trigger === 'auto' ? coinsBelowDepth(walletId, coins, fuseDepth) : coins;
  return limitFusionCoins(eligible);
}

export async function startFusionRound(
  options: StartFusionRoundOptions
): Promise<FusionRunOutcome> {
  const { walletId, mode, trigger } = options;
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (!Number.isInteger(walletId) || walletId <= 0) return { status: 'busy' };

  // Durable Fused labels (SQL) into sync cache before depth gate / history.
  void import('./fusionCoinDepth')
    .then(({ hydrateFusionLabels }) => hydrateFusionLabels(walletId))
    .catch(() => undefined);

  // Same-window double Start / Auto+manual race before acquire completes.
  if (heldLeases.has(walletId)) return { status: 'busy' };

  // Most automatic ticks happen during the durable cooldown. Reject those
  // before Web Locks, UI activity, or Electrum work. This is advisory only:
  // the atomic claim below remains the final spending gate.
  if (
    trigger === 'auto' &&
    !isAutoCooldownReady(walletId, AUTO_FUSION_COOLDOWN_MS)
  ) {
    return { status: 'cooldown' };
  }

  // Depth-met long idle: do not re-reconcile / re-log every engine tick.
  // Wake only via wallet UTXO activity (or fuseDepth change) that clears the stamp.
  if (trigger === 'auto' && isAutoDepthMetIdle(walletId)) {
    return { status: 'cooldown' };
  }

  // Auto depth gate BEFORE lease/UI: if rounds-per-coin is already met, idle
  // with no activity event (user: wallet keeps "trying" with no work to do).
  if (trigger === 'auto') {
    const preCoins = await freshCoins(
      walletId,
      'auto',
      options.fuseDepth,
      options.freshSnapshot,
      options.signal
    );
    if (options.signal?.aborted) return { status: 'cancelled' };
    if (preCoins === null) return { status: 'waiting-for-wallet' };
    if (preCoins.length === 0) {
      const snapshot =
        options.freshSnapshot ??
        (await import('../../services/WalletUtxoRefreshService')
          .then((m) =>
            m.reconcileActiveWalletUtxosForSpend(walletId, options.signal)
          )
          .catch(() => null));
      const allNonToken = (snapshot
        ? (Object.values(snapshot).flat() as UTXO[])
        : []
      ).filter(
        (c) =>
          !!c &&
          !c.token &&
          !(c as UTXO & { token_data?: unknown }).token_data
      );
      const elig = fuseDepthEligibility(
        walletId,
        allNonToken,
        options.fuseDepth
      );
      // Target is options.fuseDepth (the box) for both P2P and server Auto.
      const detail = formatAutoDepthMetMessage(elig);
      // Long depth-met idle (not fail backoff). Cleared by UTXO activity that
      // re-introduces below-depth coins (wakeAutoFromWalletActivity).
      await stampAutoDepthMetIdle(walletId, AUTO_FUSION_DEPTH_MET_IDLE_MS).catch(
        () => undefined
      );
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: true,
        message: detail,
      });
      void import('./logger')
        .then(({ log }) =>
          log.info('p2p-live', `w${walletId} OUTCOME idle: ${detail}`)
        )
        .catch(() => undefined);
      return { status: 'no-eligible-coins', detail };
    }
  }

  // Drop orphan UI/durable state before acquire so grey-idle ghosts never block.
  // Only clears the lease when it is STALE (no heartbeat) — a live other window
  // keeps the lock and we return busy below.
  await reconcileIdleFusionState(walletId);

  if (hasLiveRoundLease(walletId)) return { status: 'busy' };

  // Exclusivity first. Stale durable leases (no heartbeat) are reclaimed inside
  // acquireRoundLease — no user-facing "clear stuck" control required.
  const lease = await acquireRoundLease(walletId);
  if (lease === null) return { status: 'busy' };
  heldLeases.set(walletId, lease);
  fusionActivities.set(walletId, {
    lease,
    activity: {
      walletId,
      mode,
      trigger,
      startedAt: Date.now(),
      phase: 1,
      status:
        trigger === 'auto'
          ? 'Auto-fuse: preparing…'
          : 'Starting fusion…',
    },
  });
  emitFusionActivity(walletId);

  const pushProgress = (update: { phase?: number; status?: string | null }) => {
    reportFusionProgress(walletId, update);
    if (update.status !== undefined && update.status !== null) {
      options.onStatus?.(update.status);
    }
    if (update.phase !== undefined) {
      options.onPhase?.(update.phase);
    }
  };

  // Keep the durable lease fresh so other windows see a live holder, not a ghost.
  const heartbeat = setInterval(() => {
    void touchRoundLease(walletId, lease).catch(() => undefined);
  }, LEASE_HEARTBEAT_MS);

  const finish = (outcome: FusionRunOutcome): FusionRunOutcome => {
    // Persist a readable last result so CashFusion still shows auto failures
    // after the live lease is released.
    if (outcome.status === 'fused') {
      const fusedMsg = outcome.warning
        ? `Fused ✓ — ${outcome.txid}. ${outcome.warning}`
        : `Fused ✓ — ${outcome.txid}`;
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: true,
        message: fusedMsg,
      });
      void import('./logger')
        .then(({ log }) =>
          log.info('p2p-live', `w${walletId} OUTCOME fused: ${fusedMsg}`)
        )
        .catch(() => undefined);
    } else if (outcome.status === 'failed') {
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: false,
        message: outcome.message,
      });
      void import('./logger')
        .then(({ log }) =>
          log.info(
            'p2p-live',
            `w${walletId} OUTCOME failed: ${outcome.message}`
          )
        )
        .catch(() => undefined);
    } else if (outcome.status === 'no-eligible-coins') {
      // Not a hard failure for auto: every coin already meets the box target.
      const depthMsg =
        trigger === 'auto'
          ? (outcome.detail ??
            'Auto: nothing to fuse — all BCH coins already at rounds-per-coin depth (or no BCH coins). Manual Start can still re-fuse.')
          : 'No eligible coins to fuse.';
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: true,
        message: depthMsg,
      });
      // One quiet log line — do not spam p2p-live every tick.
      if (trigger === 'auto') {
        void import('./logger')
          .then(({ log }) =>
            log.info('p2p-live', `w${walletId} OUTCOME idle: ${depthMsg}`)
          )
          .catch(() => undefined);
      }
    } else if (outcome.status === 'busy') {
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: false,
        message: 'Fusion busy (another window or round holds the lock).',
      });
    }
    return outcome;
  };

  try {
    if (options.signal?.aborted) return finish({ status: 'cancelled' });

    // Auto: resolve coins first WITHOUT activity spam. If depth is already met,
    // return quietly — no "refreshing coins" lease thrash every engine tick.
    if (trigger === 'auto') {
      const coinsQuiet = await freshCoins(
        walletId,
        trigger,
        options.fuseDepth,
        options.freshSnapshot,
        options.signal
      );
      if (options.signal?.aborted) return finish({ status: 'cancelled' });
      if (coinsQuiet === null) return finish({ status: 'waiting-for-wallet' });
      if (coinsQuiet.length === 0) {
        const snapshot =
          options.freshSnapshot ??
          (await import('../../services/WalletUtxoRefreshService')
            .then((m) =>
              m.reconcileActiveWalletUtxosForSpend(walletId, options.signal)
            )
            .catch(() => null));
        const allNonToken = (snapshot
          ? (Object.values(snapshot).flat() as UTXO[])
          : []
        ).filter(
          (c) =>
            !!c &&
            !c.token &&
            !(c as UTXO & { token_data?: unknown }).token_data
        );
        const elig = fuseDepthEligibility(
          walletId,
          allNonToken,
          options.fuseDepth
        );
        const detail = formatAutoDepthMetMessage(elig);
        // Long depth-met idle so Auto does not thrash every engine tick.
        await stampAutoDepthMetIdle(
          walletId,
          AUTO_FUSION_DEPTH_MET_IDLE_MS
        ).catch(() => undefined);
        return finish({ status: 'no-eligible-coins', detail });
      }
      // Eligible coins exist — now show activity and claim the cooldown.
      pushProgress({
        phase: 1,
        status: 'Auto-fuse: refreshing coins…',
      });
      const claimed = await tryClaimAutoCooldown(
        walletId,
        AUTO_FUSION_COOLDOWN_MS
      );
      if (!claimed) return finish({ status: 'cooldown' });

      try {
        const eligStart = fuseDepthEligibility(
          walletId,
          coinsQuiet,
          options.fuseDepth
        );
        void import('./logger')
          .then(({ log }) =>
            log.info(
              'p2p-live',
              `w${walletId} depth gate: ` +
                formatAutoDepthGateLog(
                  coinsQuiet.length,
                  options.fuseDepth,
                  eligStart.minDepth,
                  eligStart.maxCoinDepth
                )
            )
          )
          .catch(() => undefined);
        pushProgress({
          phase: 1,
          status: `Auto-fuse (${mode}): ${coinsQuiet.length} coin(s) — finding peers…`,
        });
        const progressHooks = {
          onStatus: (message: string) => pushProgress({ status: message }),
          onPhase: (phase: number) => pushProgress({ phase }),
        };
        const result =
          mode === 'p2p'
            ? await options.runners.runP2p(
                coinsQuiet,
                options.signal,
                progressHooks
              )
            : await options.runners.runServer(
                coinsQuiet,
                options.signal,
                progressHooks
              );
        // Inside trigger==='auto' block — always stamp Auto cooldown.
        await stampAutoSuccess(walletId, AUTO_FUSION_COOLDOWN_MS).catch(
          () => undefined
        );
        return finish({
          status: 'fused',
          mode,
          txid: result.txid,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted && isCancellationError(error)) {
          await stampAutoFailure(walletId, AUTO_FUSION_RETRY_MS).catch(
            () => undefined
          );
          return finish({ status: 'cancelled' });
        }
        const msg = error instanceof Error ? error.message : String(error);
        // Server connect refused / empty pool / P2P alone — short retry so Auto
        // keeps looping until a round completes or depth is met.
        const transient = isAutoTransientFailure(msg);
        await stampAutoFailure(
          walletId,
          transient ? AUTO_FUSION_EMPTY_POOL_RETRY_MS : AUTO_FUSION_RETRY_MS
        ).catch(() => undefined);
        return finish({
          status: 'failed',
          mode,
          message: msg,
        });
      }
    }

    // Manual Start path only (Auto returns above).
    pushProgress({
      phase: 1,
      status: 'Refreshing coins…',
    });
    const coins = await freshCoins(
      walletId,
      'manual',
      options.fuseDepth,
      options.freshSnapshot,
      options.signal
    );
    if (options.signal?.aborted) return finish({ status: 'cancelled' });
    if (coins === null) return finish({ status: 'waiting-for-wallet' });
    if (coins.length === 0) {
      return finish({
        status: 'no-eligible-coins',
        detail: 'No eligible coins to fuse.',
      });
    }

    try {
      pushProgress({
        phase: 1,
        status: `Using ${coins.length} coin(s)…`,
      });
      // Expose progress hooks to runners that wire into runP2pFusion/server.
      const progressHooks = {
        onStatus: (message: string) => pushProgress({ status: message }),
        onPhase: (phase: number) => pushProgress({ phase }),
      };
      const result =
        mode === 'p2p'
          ? await options.runners.runP2p(coins, options.signal, progressHooks)
          : await options.runners.runServer(
              coins,
              options.signal,
              progressHooks
            );
      return finish({
        status: 'fused',
        mode,
        txid: result.txid,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted && isCancellationError(error)) {
        return finish({ status: 'cancelled' });
      }
      return finish({
        status: 'failed',
        mode,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearInterval(heartbeat);
    heldLeases.delete(walletId);
    if (fusionActivities.get(walletId)?.lease === lease) {
      fusionActivities.delete(walletId);
      emitFusionActivity(walletId);
    }
    // Conditional, owner-only: a lease we already lost to TTL now belongs to
    // another window, and clearing it would let a third start concurrently.
    await releaseRoundLease(walletId, lease).catch(() => undefined);
  }
}
