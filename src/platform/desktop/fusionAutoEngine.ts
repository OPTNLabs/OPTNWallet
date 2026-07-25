// When may auto-fusion start a round on its own?
//
// This is deliberately a pure function with no timers, redux, or network in it.
// Auto-fusion spends a real fee every time it fires, so the decision to fire is
// the part that must be exhaustively testable — the surrounding hook is only a
// clock. Anything that can be decided without I/O is decided here.
//
// Electron Cash parity: fusion is per-coin bounded (`fuse_depth`), only the
// selected transport may run, and a wallet with nothing left under the depth
// limit simply stops rather than re-fusing finished coins forever.

export type FusionMode = 'p2p' | 'server';

export interface AutoFusionInputs {
  /** Master CashFusion switch. Nothing runs when this is off. */
  cashFusionEnabled: boolean;
  /** The shared auto-fusion policy, used by both cards. */
  autoFuseEnabled: boolean;
  /** Which transport the user selected; the two are mutually exclusive. */
  p2pFusionEnabled: boolean;
  /** 0 means no wallet is open. */
  walletId: number;
  /** A round (auto or manual) is already in flight in this window. */
  busy: boolean;
  /** Coins still under the configured fuse depth. */
  eligibleCoinCount: number;
  /** P2P cannot run without Tor; server fusion enforces its own policy. */
  torReady: boolean;
  nowMs: number;
  /** When this window last STARTED an automatic round. */
  lastAttemptMs: number | null;
}

export type AutoFusionDecision =
  | { run: false; reason: string }
  | { run: true; mode: FusionMode };

/**
 * Gap between automatic rounds.
 *
 * Long on purpose. A round already takes up to ~75s to gather peers, and every
 * attempt costs a fee whether or not it completes, so a tight loop would burn
 * money on a wallet that simply cannot find peers. This is a floor between
 * ATTEMPTS, not a schedule: nothing fires while a round is in flight.
 */
export const AUTO_FUSION_COOLDOWN_MS = 5 * 60_000;

/** At least two participants are needed, so a single coin cannot fuse alone. */
export const MIN_ELIGIBLE_COINS = 1;

export function decideAutoFusion(input: AutoFusionInputs): AutoFusionDecision {
  if (!input.cashFusionEnabled) return { run: false, reason: 'CashFusion is off' };
  if (!input.autoFuseEnabled) return { run: false, reason: 'Auto-fusion is off' };
  if (!Number.isInteger(input.walletId) || input.walletId <= 0) {
    return { run: false, reason: 'No wallet open' };
  }
  // Checked before the cooldown: a long-running round must never be joined by a
  // second one just because the cooldown happened to elapse while it ran.
  if (input.busy) return { run: false, reason: 'A fusion round is already running' };
  if (input.eligibleCoinCount < MIN_ELIGIBLE_COINS) {
    return { run: false, reason: 'All coins have reached the fuse depth' };
  }
  if (input.lastAttemptMs !== null) {
    const waited = input.nowMs - input.lastAttemptMs;
    // A clock that jumped backwards must not unlock an immediate retry.
    if (waited < AUTO_FUSION_COOLDOWN_MS) {
      return { run: false, reason: 'Waiting for the auto-fusion cooldown' };
    }
  }
  if (input.p2pFusionEnabled) {
    if (!input.torReady) return { run: false, reason: 'Tor is not ready for P2P fusion' };
    return { run: true, mode: 'p2p' };
  }
  return { run: true, mode: 'server' };
}
