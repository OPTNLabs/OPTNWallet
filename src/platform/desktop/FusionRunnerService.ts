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
  reconcileActiveWalletUtxos,
  type WalletUtxoSnapshot,
} from '../../services/WalletUtxoRefreshService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { coinsBelowDepth } from './fusionCoinDepth';
import {
  acquireRoundLease,
  isAutoCooldownReady,
  releaseRoundLease,
  tryClaimAutoCooldown,
} from './fusionWalletLease';
import { AUTO_FUSION_COOLDOWN_MS, type FusionMode } from './fusionAutoEngine';

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
  | { status: 'no-eligible-coins' }
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
      signal?: AbortSignal
    ) => Promise<{ txid: string; warning?: string }>;
    runServer: (
      coins: UTXO[],
      signal?: AbortSignal
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
}

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
  return fusionActivities.get(walletId)?.activity ?? null;
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
  const snapshot =
    freshSnapshot ?? (await reconcileActiveWalletUtxos(walletId, signal));
  if (!snapshot) return null;

  const coins = Object.values(snapshot)
    .flat()
    .filter((coin): coin is UTXO => Boolean(coin) && !coin.token);

  // Depth bounds automatic spending only. A user who clicks Fuse Now is making an
  // explicit choice and may re-fuse a coin that has already reached the limit.
  return trigger === 'auto'
    ? coinsBelowDepth(walletId, coins, fuseDepth)
    : coins;
}

export async function startFusionRound(
  options: StartFusionRoundOptions
): Promise<FusionRunOutcome> {
  const { walletId, mode, trigger } = options;
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (!Number.isInteger(walletId) || walletId <= 0) return { status: 'busy' };

  // Most automatic ticks happen during the durable cooldown. Reject those
  // before Web Locks, UI activity, or Electrum work. This is advisory only:
  // the atomic claim below remains the final spending gate.
  if (
    trigger === 'auto' &&
    !isAutoCooldownReady(walletId, AUTO_FUSION_COOLDOWN_MS)
  ) {
    return { status: 'cooldown' };
  }

  // Exclusivity first, across every window, covering both transports and both
  // triggers. Null means another window holds it — or that we could not obtain a
  // guarantee at all, in which case refusing is the only safe answer.
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
    },
  });
  emitFusionActivity(walletId);

  try {
    if (options.signal?.aborted) return { status: 'cancelled' };

    const coins = await freshCoins(
      walletId,
      trigger,
      options.fuseDepth,
      options.freshSnapshot,
      options.signal
    );
    if (options.signal?.aborted) return { status: 'cancelled' };
    if (coins === null) return { status: 'waiting-for-wallet' };
    if (coins.length === 0) return { status: 'no-eligible-coins' };

    // Claim only when live eligible coins exist. The wallet-wide round lease is
    // already held across reconciliation, so no second window can pass this
    // point concurrently. Empty/refreshing wallets must not burn five minutes
    // of cooldown before a newly received coin becomes spendable.
    if (trigger === 'auto') {
      const claimed = await tryClaimAutoCooldown(
        walletId,
        AUTO_FUSION_COOLDOWN_MS
      );
      if (!claimed) return { status: 'cooldown' };
    }

    try {
      const result =
        mode === 'p2p'
          ? await options.runners.runP2p(coins, options.signal)
          : await options.runners.runServer(coins, options.signal);
      // A runner only resolves after its irreversible broadcast/finalization
      // path is complete. An AbortSignal can race with that resolution, but it
      // cannot undo a transaction that may already be on the network. Trust the
      // structured runner result here so the wallet always records a successful
      // Fusion instead of misreporting it as cancelled.
      return {
        status: 'fused',
        mode,
        txid: result.txid,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    } catch (error) {
      // The signal alone is insufficient here: it can race with a relay or
      // observation error after signatures have escaped. Only an explicit
      // transport cancellation is safely reported as cancelled.
      if (options.signal?.aborted && isCancellationError(error)) {
        return { status: 'cancelled' };
      }
      return {
        status: 'failed',
        mode,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
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
