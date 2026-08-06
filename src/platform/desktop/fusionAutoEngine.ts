// May auto-fusion start a round right now?
//
// Policy only. Deliberately pure: no timers, redux, storage or network. The
// decision to spend a fee is the part that must be exhaustively testable, and
// the surrounding hook is only a clock.
//
// Everything that needs authority lives in FusionRunnerService, not here:
//
//   - whether a round is already running  -> the cross-window lease
//   - whether the fee cooldown has elapsed -> the atomic check-and-claim
//   - whether any coin is still eligible   -> live reconciliation + fuse depth
//
// Those were briefly duplicated here as plain comparisons. That is worse than
// useless for a fee decision: this module cannot see other windows, so a check
// here would pass while the authoritative one refused, and the two would drift.
// Ask once, in the place that can actually answer.

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
  /** P2P cannot run without Tor; server fusion enforces its own policy. */
  torReady: boolean;
}

export type AutoFusionDecision =
  | { run: false; reason: string }
  | { run: true; mode: FusionMode };

/**
 * After a successful paid fuse. Short so Auto keeps cycling; still enough for
 * Electrum to refresh new coins before the next gather.
 */
export const AUTO_FUSION_COOLDOWN_MS = 45_000;
/**
 * Backoff after a failed auto attempt that did not complete a paid round.
 */
export const AUTO_FUSION_RETRY_MS = 25_000;
/**
 * Empty-pool / no-agree retries (same floor as general failure).
 * (Paid success still uses {@link AUTO_FUSION_COOLDOWN_MS}.)
 */
export const AUTO_FUSION_EMPTY_POOL_RETRY_MS = 25_000;

/**
 * Shared UTC rendezvous for **global** P2P auto-fusion (not "open 4 wallets").
 * Production model: strangers worldwide with Auto on; local multi-window is only
 * a stress harness for the same code path.
 *
 * Like server CashFusion JOIN epochs: everyone only *enters* gather in the open
 * part of each UTC slot so independent clients cluster without coordinating.
 */
export const AUTO_RENDEZVOUS_PERIOD_MS = 90_000;
/** First portion of each slot: new auto gathers may start (global peers overlap). */
export const AUTO_RENDEZVOUS_OPEN_MS = 35_000;

/** Ms until the next open rendezvous (0 if already open). */
export function msUntilAutoRendezvousOpen(now = Date.now()): number {
  const into = now % AUTO_RENDEZVOUS_PERIOD_MS;
  if (into < AUTO_RENDEZVOUS_OPEN_MS) return 0;
  return AUTO_RENDEZVOUS_PERIOD_MS - into;
}

export function isAutoRendezvousOpen(now = Date.now()): boolean {
  return now % AUTO_RENDEZVOUS_PERIOD_MS < AUTO_RENDEZVOUS_OPEN_MS;
}

/**
 * Next engine wake: prefer the next shared open window + small jitter
 * (privacy: not a fixed global beat).
 */
export function nextAutoEngineTickMs(now = Date.now()): number {
  const wait = msUntilAutoRendezvousOpen(now);
  const jitter = Math.floor(Math.random() * 8_000);
  // If open now, also allow a mid-slot retry with jitter up to open end.
  if (wait === 0) {
    const into = now % AUTO_RENDEZVOUS_PERIOD_MS;
    const remainOpen = Math.max(0, AUTO_RENDEZVOUS_OPEN_MS - into);
    return Math.min(remainOpen, 5_000) + Math.floor(Math.random() * 4_000);
  }
  return wait + jitter;
}

export function decideAutoFusion(input: AutoFusionInputs): AutoFusionDecision {
  if (!input.cashFusionEnabled) return { run: false, reason: 'CashFusion is off' };
  if (!input.autoFuseEnabled) return { run: false, reason: 'Auto-fusion is off' };
  if (!Number.isInteger(input.walletId) || input.walletId <= 0) {
    return { run: false, reason: 'No wallet open' };
  }
  if (input.p2pFusionEnabled) {
    if (!input.torReady) {
      return { run: false, reason: 'Tor is not ready for P2P fusion' };
    }
    return { run: true, mode: 'p2p' };
  }
  return { run: true, mode: 'server' };
}
