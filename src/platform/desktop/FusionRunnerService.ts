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
import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import {
  coinDepth,
  coinsBelowDepth,
  formatAutoDepthGateLog,
  formatAutoDepthMetMessage,
  fuseDepthEligibility,
} from './fusionCoinDepth';
import {
  acquireRoundLease,
  hasLiveRoundLease,
  isAutoCooldownReady,
  isAutoDepthMetIdle,
  LEASE_HEARTBEAT_MS,
  reclaimStaleRoundState,
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
import {
  classifyServerFusionCoins,
  isServerFusionDepthSatisfied,
  selectServerFusionBuckets,
} from './serverFusionCoinPolicy';

/** Structured, so callers never parse a human string to learn what happened. */
export type FusionRunOutcome =
  | {
      status: 'fused';
      mode: FusionMode;
      txid: string;
      warning?: string;
    }
  | {
      status: 'verification-pending';
      mode: FusionMode;
      txid: string;
      message: string;
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
      progress?: {
        onStatus?: (m: string) => void;
        onPhase?: (p: number) => void;
      }
    ) => Promise<{
      txid: string;
      warning?: string;
      verificationPending?: boolean;
    }>;
    runServer: (
      coins: UTXO[],
      signal?: AbortSignal,
      progress?: {
        onStatus?: (m: string) => void;
        onPhase?: (p: number) => void;
      }
    ) => Promise<{
      txid: string;
      warning?: string;
      verificationPending?: boolean;
    }>;
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
 * Service-owned cancellation, separate from any screen component.
 *
 * A settings route may unmount while a manual round is gathering peers; that
 * must not cancel the financial action. Wallet/session lifecycle code can still
 * stop it explicitly on lock, wallet switch, network switch, or mode shutdown.
 */
const activeRoundControllers = new Map<
  number,
  { lease: string; controller: AbortController }
>();

export function cancelFusionRound(
  walletId: number,
  reason = 'wallet session changed'
): boolean {
  const active = activeRoundControllers.get(walletId);
  if (!active || active.controller.signal.aborted) return false;
  active.controller.abort(new Error(reason));
  return true;
}

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
const fusionActivityListeners = new Map<number, Set<FusionActivityListener>>();

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
export async function reconcileIdleFusionState(
  walletId: number
): Promise<void> {
  if (!Number.isInteger(walletId) || walletId <= 0) return;
  if (heldLeases.has(walletId)) return; // real round in this window
  if (fusionActivities.has(walletId)) {
    fusionActivities.delete(walletId);
    emitFusionActivity(walletId);
  }
  // Reclaim durable lock only if stale (another window may still be live).
  if (!hasLiveRoundLease(walletId)) {
    await reclaimStaleRoundState(walletId, () =>
      clearOutpointReservations(walletId)
    ).catch(() => false);
    // Ghost input locks from a dead round (HMR / kill) left Start clickable but
    // every coin "committed" — clear them whenever no live lease remains.
  }
}

// Release our lease if the WebView dies mid-round (reload / close).
if (typeof window !== 'undefined') {
  const releaseOnUnload = () => {
    for (const { controller } of activeRoundControllers.values()) {
      controller.abort(new Error('wallet window closed'));
    }
    activeRoundControllers.clear();
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

function secureRandomUnit(): number {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error(
      'secure randomness is unavailable for server Fusion coin selection'
    );
  }
  const sample = new Uint32Array(1);
  cryptoApi.getRandomValues(sample);
  return sample[0] / 0x1_0000_0000;
}

interface FreshCoinSelection {
  /** Coins used only for depth/status reporting; never a second chain scan. */
  depthCoins: UTXO[];
  /** Exact coins offered to the selected transport. */
  selectedCoins: UTXO[];
  serverDepthSatisfied: boolean;
}

/**
 * Live, spendable, non-token coins for this wallet.
 *
 * `null` from the refresh means this trigger joined an in-progress refresh or the
 * wallet session changed — it is NOT "no coins". Returning an empty array here
 * would read as "nothing to fuse" and, worse, tempt a caller into falling back to
 * the Redux list. The distinction is preserved all the way out to the caller.
 */
async function freshCoinSelection(
  walletId: number,
  mode: FusionMode,
  trigger: 'auto' | 'manual',
  fuseDepth: number,
  freshSnapshot?: WalletUtxoSnapshot,
  signal?: AbortSignal
): Promise<FreshCoinSelection | null> {
  // Exclusive listunspent for fusion — shared reconcile soft-fails (null)
  // whenever a background refresh is in flight, which made Fuse feel broken.
  const snapshot =
    freshSnapshot ??
    (await reconcileActiveWalletUtxosForSpend(walletId, signal));
  if (!snapshot) return null;

  const allCoins = Object.values(snapshot).flat().filter(Boolean) as UTXO[];

  if (mode === 'server') {
    const classified = classifyServerFusionCoins(allCoins);
    const depthCoins = classified.eligibleBuckets.flatMap(
      (bucket) => bucket.coins
    );
    const depth = isServerFusionDepthSatisfied(classified.eligibleBuckets, {
      fuseDepth,
      depthOf: (outpoint) => coinDepth(walletId, outpoint),
    });
    if (trigger === 'auto' && depth.satisfied) {
      return {
        depthCoins,
        selectedCoins: [],
        serverDepthSatisfied: true,
      };
    }

    // Electron Cash's default "normal" mode selects each unrelated address
    // bucket with probability 0.5, keeps the bucket indivisible, and falls back
    // to one bucket when the random sample is empty.
    const selectedBuckets = selectServerFusionBuckets(
      classified.eligibleBuckets,
      {
        fraction: 0.5,
        random: secureRandomUnit,
      }
    );
    return {
      depthCoins,
      selectedCoins: selectedBuckets.flatMap((bucket) => bucket.coins),
      serverDepthSatisfied: false,
    };
  }

  const coins = allCoins.flat().filter(
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
  return {
    depthCoins: coins,
    selectedCoins: limitFusionCoins(eligible),
    serverDepthSatisfied: false,
  };
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

  // A Tor-only broadcast can finish signing while its network receipt remains
  // ambiguous. Starting another fee-spending round with different coins would
  // accumulate unknown transactions and make the wallet's state harder to
  // reconcile. Pause both transports until ordinary wallet evidence resolves
  // the prior transaction as seen (or a deterministic rejection removes it).
  const pendingFusion =
    await OutboundTransactionTracker.findFusionVerificationPending(walletId);
  if (pendingFusion) {
    return {
      status: 'verification-pending',
      mode: /server/i.test(pendingFusion.source) ? 'server' : 'p2p',
      txid: pendingFusion.txid,
      message:
        'A previous Fusion transaction is still awaiting independent network visibility.',
    };
  }

  // Drop orphan UI/durable state before acquire so grey-idle ghosts never block.
  // Only clears the lease when it is STALE (no heartbeat) — a live other window
  // keeps the lock and we return busy below.
  await reconcileIdleFusionState(walletId);

  if (hasLiveRoundLease(walletId)) return { status: 'busy' };

  // Exclusivity first. Stale durable leases (no heartbeat) are reclaimed inside
  // acquireRoundLease — no user-facing "clear stuck" control required.
  const lease = await acquireRoundLease(walletId, Date.now());
  if (lease === null) {
    // Automatic Fusion must not spend fees without an atomic cross-window lock.
    return trigger === 'auto' ? { status: 'cooldown' } : { status: 'busy' };
  }
  heldLeases.set(walletId, lease);
  const callerSignal = options.signal;
  const roundController = new AbortController();
  const forwardCallerAbort = () =>
    roundController.abort(
      callerSignal?.reason ?? new Error('fusion round cancelled')
    );
  callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
  if (callerSignal?.aborted) forwardCallerAbort();
  activeRoundControllers.set(walletId, {
    lease,
    controller: roundController,
  });
  // From this point cancellation is owned by the wallet session, not by the
  // currently mounted route. The caller signal is forwarded into this one.
  options = { ...options, signal: roundController.signal };
  fusionActivities.set(walletId, {
    lease,
    activity: {
      walletId,
      mode,
      trigger,
      startedAt: Date.now(),
      phase: 1,
      status: trigger === 'auto' ? 'Auto-fuse: preparing…' : 'Starting fusion…',
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
    void touchRoundLease(walletId, lease)
      .then((stillOwned) => {
        if (!stillOwned && !roundController.signal.aborted) {
          roundController.abort(new Error('fusion round cancelled'));
        }
      })
      .catch(() => {
        if (!roundController.signal.aborted) {
          roundController.abort(new Error('fusion round cancelled'));
        }
      });
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
    } else if (outcome.status === 'verification-pending') {
      setFusionLastResult(walletId, {
        mode,
        trigger,
        ok: false,
        message: `Fusion verification pending — ${outcome.txid}. ${outcome.message}`,
      });
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
          ? outcome.detail ??
            'Auto: nothing to fuse — all BCH coins already at rounds-per-coin depth (or no BCH coins). Manual Start can still re-fuse.'
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
      const selection = await freshCoinSelection(
        walletId,
        mode,
        trigger,
        options.fuseDepth,
        options.freshSnapshot,
        options.signal
      );
      if (options.signal?.aborted) return finish({ status: 'cancelled' });
      if (selection === null) return finish({ status: 'waiting-for-wallet' });
      const coinsQuiet = selection.selectedCoins;
      if (coinsQuiet.length === 0) {
        const elig = fuseDepthEligibility(
          walletId,
          selection.depthCoins,
          options.fuseDepth
        );
        const detail =
          mode === 'server' &&
          selection.depthCoins.length === 0 &&
          !selection.serverDepthSatisfied
            ? 'Auto: no confirmed, unfrozen, non-token BCH address buckets are eligible for server CashFusion.'
            : formatAutoDepthMetMessage(elig);
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
        if (result.verificationPending) {
          await stampAutoFailure(walletId, AUTO_FUSION_RETRY_MS).catch(
            () => undefined
          );
          return finish({
            status: 'verification-pending',
            mode,
            txid: result.txid,
            message:
              result.warning ??
              'The signed Fusion transaction is awaiting independent network visibility.',
          });
        }
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
    const selection = await freshCoinSelection(
      walletId,
      mode,
      'manual',
      options.fuseDepth,
      options.freshSnapshot,
      options.signal
    );
    if (options.signal?.aborted) return finish({ status: 'cancelled' });
    if (selection === null) return finish({ status: 'waiting-for-wallet' });
    const coins = selection.selectedCoins;
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
      if (result.verificationPending) {
        return finish({
          status: 'verification-pending',
          mode,
          txid: result.txid,
          message:
            result.warning ??
            'The signed Fusion transaction is awaiting independent network visibility.',
        });
      }
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
    callerSignal?.removeEventListener('abort', forwardCallerAbort);
    const activeController = activeRoundControllers.get(walletId);
    if (activeController?.lease === lease) {
      activeRoundControllers.delete(walletId);
    }
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
