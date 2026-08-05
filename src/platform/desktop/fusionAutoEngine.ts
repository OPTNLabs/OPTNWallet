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
 * After a successful paid fuse — long gap so we do not fee-spam.
 * Failed attempts (no peers, Tor blip) use AUTO_FUSION_RETRY_MS instead so
 * autofuse is not silenced for five minutes after every empty gather.
 */
export const AUTO_FUSION_COOLDOWN_MS = 5 * 60_000;
/** Backoff after a failed auto attempt that did not complete a paid round. */
export const AUTO_FUSION_RETRY_MS = 90_000;

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
