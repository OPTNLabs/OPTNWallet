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
import { claimAutoAttempt } from './fusionRoundState';
import type { FusionMode } from './fusionAutoEngine';

/** Structured, so callers never parse a human string to learn what happened. */
export type FusionRunOutcome =
  | { status: 'fused'; mode: FusionMode; txid: string }
  | { status: 'busy' }
  /** Wallet state is mid-refresh; not an error, and not a reason to use stale coins. */
  | { status: 'waiting-for-wallet' }
  | { status: 'no-eligible-coins' }
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
    runP2p: (coins: UTXO[]) => Promise<{ txid: string }>;
    runServer: (coins: UTXO[]) => Promise<{ txid: string }>;
  };
}

/**
 * One in-flight round per wallet, process-wide.
 *
 * Cross-window outpoint reservations (fusionRoundState) remain the defence
 * against two WINDOWS colliding; this guard is the cheaper one that stops a
 * manual click and an engine tick inside the SAME window from racing, which
 * reservations would only catch after both had already done network work.
 */
const inFlight = new Set<number>();

export function isFusionRunning(walletId: number): boolean {
  return inFlight.has(walletId);
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
  fuseDepth: number
): Promise<UTXO[] | null> {
  const snapshot = await reconcileActiveWalletUtxos(walletId);
  if (!snapshot) return null;

  const coins = Object.values(snapshot)
    .flat()
    .filter((coin): coin is UTXO => Boolean(coin) && !coin.token);

  // Depth bounds automatic spending only. A user who clicks Fuse Now is making an
  // explicit choice and may re-fuse a coin that has already reached the limit.
  return trigger === 'auto' ? coinsBelowDepth(walletId, coins, fuseDepth) : coins;
}

export async function startFusionRound(
  options: StartFusionRoundOptions
): Promise<FusionRunOutcome> {
  const { walletId, mode, trigger } = options;
  if (!Number.isInteger(walletId) || walletId <= 0) return { status: 'busy' };
  if (inFlight.has(walletId)) return { status: 'busy' };

  inFlight.add(walletId);
  try {
    const coins = await freshCoins(walletId, trigger, options.fuseDepth);
    if (coins === null) return { status: 'waiting-for-wallet' };
    if (coins.length === 0) return { status: 'no-eligible-coins' };

    // Claim BEFORE the network work. A round that dies halfway still consumed
    // the attempt; stamping only on success would let a failing wallet retry in
    // a tight loop and pay each time.
    if (trigger === 'auto') claimAutoAttempt(walletId);

    try {
      const result =
        mode === 'p2p'
          ? await options.runners.runP2p(coins)
          : await options.runners.runServer(coins);
      return { status: 'fused', mode, txid: result.txid };
    } catch (error) {
      return {
        status: 'failed',
        mode,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    inFlight.delete(walletId);
  }
}
