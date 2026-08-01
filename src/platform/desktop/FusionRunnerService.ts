// The ONE place a fusion round starts — manual button or automatic engine.
//
// Both callers route through `startFusionRound`. The alternative considered was
// leaving the manual handlers in the settings component and giving the engine its
// own copy of the start sequence; that was rejected because the server path does
// status query -> tier choice -> output allocation before running, and two copies
// of that would drift. The automatic path is the one nobody is watching when it
// spends a fee, so it is the worst possible place for a silent divergence.
//
// Coin freshness is this service's job, never the caller's: the round's inputs
// come from `reconcileActiveWalletUtxos`, never from the Redux UI list. Trusting
// that list is what produced signed CoinJoins referencing coins that were already
// gone.

import { reconcileActiveWalletUtxos } from '../../services/WalletUtxoRefreshService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { coinsBelowDepth } from './fusionCoinDepth';
import {
  acquireRoundLease,
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
  signal?: AbortSignal
): Promise<UTXO[] | null> {
  const snapshot = await reconcileActiveWalletUtxos(walletId, signal);
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

  // Exclusivity first, across every window, covering both transports and both
  // triggers. Null means another window holds it — or that we could not obtain a
  // guarantee at all, in which case refusing is the only safe answer.
  const lease = await acquireRoundLease(walletId);
  if (lease === null) return { status: 'busy' };
  heldLeases.set(walletId, lease);

  try {
    if (options.signal?.aborted) return { status: 'cancelled' };

    const coins = await freshCoins(
      walletId,
      trigger,
      options.fuseDepth,
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
    // Conditional, owner-only: a lease we already lost to TTL now belongs to
    // another window, and clearing it would let a third start concurrently.
    await releaseRoundLease(walletId, lease).catch(() => undefined);
  }
}
