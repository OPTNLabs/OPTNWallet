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
 * After a successful paid fuse. Short so Auto keeps cycling like Electron Cash
 * (plugin re-queues as soon as a fusion thread exits).
 *
 * This is NOT a block-confirmation wait. Unconfirmed fusion outputs are eligible
 * immediately (ACCEPT_UNCONFIRMED_FUSION_INPUTS / EC-maintainer-endorsed 0-conf).
 * The delay only covers Electrum listunspent catching the new outpoints before
 * the next JoinPools. Never multi-minute, never “wait for 1 conf”.
 */
/** After a paid success — ~20s so Electrum sees new outpoints (user preference). */
export const AUTO_FUSION_COOLDOWN_MS = 20_000;
/**
 * Backoff after a failed / cancelled / empty-pool auto attempt (no fee spent).
 * ~10s so local multi-wallet Auto re-enters together after a drop.
 */
export const AUTO_FUSION_RETRY_MS = 10_000;
/**
 * Empty-pool / no-agree retries — same as {@link AUTO_FUSION_RETRY_MS}.
 */
export const AUTO_FUSION_EMPTY_POOL_RETRY_MS = AUTO_FUSION_RETRY_MS;
/**
 * All coins already at rounds-per-coin depth (or wallet empty of BCH).
 * Idle hard — no Auto thrash. Wake only on wallet activity that leaves coins
 * below depth: receive, send/change, any UTXO-changing tx (not the poll alone).
 */
export const AUTO_FUSION_DEPTH_MET_IDLE_MS = 30 * 60_000;

/**
 * Shared UTC rendezvous for P2P auto-fusion. Like server CashFusion JOIN epochs:
 * Auto only *enters* gather in the open part of each UTC slot so independent
 * clients can meet without coordinating.
 */
export const AUTO_RENDEZVOUS_PERIOD_MS = 90_000;
/** First portion of each slot: new auto gathers may start (peers overlap). */
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
 * Next engine wake: prefer the next open rendezvous slot + small jitter
 * (privacy: not a fixed beat).
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

/** Electron Cash checks Auto workers on an approximately five-second loop. */
export const SERVER_AUTO_POLL_MS = 5_000;

/**
 * Server Auto has no client-created UTC rendezvous gate. Electron Cash enters
 * JoinPools as soon as an Auto worker is available and lets the Fusion server
 * coordinate the participants.
 */
export function msUntilServerAutoStart(now = Date.now()): number {
  void now;
  return 0;
}

/** @deprecated Use msUntilServerAutoStart. */
export const msUntilServerJoinOpen = msUntilServerAutoStart;

/** Recovery/backstop cadence matching Electron Cash's ~5 second plugin loop. */
export function nextServerAutoEngineTickMs(now = Date.now()): number {
  void now;
  return SERVER_AUTO_POLL_MS;
}

/** Mode-aware Auto recovery poll interval. */
export function nextAutoEngineTickForMode(
  mode: FusionMode,
  now = Date.now()
): number {
  return mode === 'server'
    ? nextServerAutoEngineTickMs(now)
    : nextAutoEngineTickMs(now);
}

/**
 * True when a failed Auto attempt should use the short empty-pool / connect
 * retry (not a multi-minute sleep). Shared by P2P and server paths.
 */
export function isAutoTransientFailure(message: string): boolean {
  return /no other (wallets|players)|no peers|only \d+ wallet|need ≥?\s*3|at least three|could not agree|could not connect|connection refused|actively refused|connection was aborted|os error 10061|os error 10053|timed? ?out waiting|never reported pool|no fusion server|not ready for|route is unavailable|tor is (disabled|not ready)|fusion server address|too few remaining|receive failed/i.test(
    message
  );
}

export function decideAutoFusion(input: AutoFusionInputs): AutoFusionDecision {
  if (!input.cashFusionEnabled)
    return { run: false, reason: 'CashFusion is off' };
  if (!input.autoFuseEnabled)
    return { run: false, reason: 'Auto-fusion is off' };
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
