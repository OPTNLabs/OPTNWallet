// Which wallet is open in which window — Electron Cash's single-window rule.
//
// EC keys loaded wallets by file path and refuses to open one twice:
// `start_new_window` matches on `w.wallet.storage.path` and raises the existing
// window instead. We allowed the same wallet in two windows and then compensated
// in software — round-key suppression so a wallet does not fuse with itself,
// coin reservations so two windows do not select the same UTXOs. Those guards
// stay (they also cover retries within one window), but the state they defend
// against does not have to exist.
//
// A claim needs to survive reloads, be visible to every window, and be taken
// atomically. localStorage gives the first two and no atomicity; Web Locks give
// atomicity and nothing durable. So the durable record is read and written
// inside the lock, the same pattern the fusion lease uses — verified in the
// running app, where three contending windows serialised with no overlap.

import { getLocalStorage } from '../../utils/browserStorage';
import { withWalletLock } from './fusionWalletLease';

const OPEN_CLAIM_KEY = 'optn-wallet-open-claims';

/**
 * A window that crashed must not lock its wallet away forever, but a live window
 * must never be evicted while its user is looking at it. The heartbeat below
 * refreshes well inside this window.
 */
export const OPEN_CLAIM_TTL_MS = 90_000;
export const OPEN_CLAIM_HEARTBEAT_MS = 30_000;

interface OpenClaim {
  /** Tauri window label, so the holder can be focused rather than guessed at. */
  windowLabel: string;
  at: number;
}

type ClaimMap = Record<string, OpenClaim>;

function readClaims(): ClaimMap {
  try {
    const raw = getLocalStorage()?.getItem(OPEN_CLAIM_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ClaimMap = {};
    for (const [walletId, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (!value || typeof value !== 'object') continue;
      const { windowLabel, at } = value as { windowLabel?: unknown; at?: unknown };
      if (typeof windowLabel === 'string' && typeof at === 'number') {
        out[walletId] = { windowLabel, at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeClaims(claims: ClaimMap): void {
  try {
    getLocalStorage()?.setItem(OPEN_CLAIM_KEY, JSON.stringify(claims));
  } catch {
    /* storage unavailable */
  }
}

const isLive = (claim: OpenClaim, nowMs: number) =>
  nowMs - claim.at < OPEN_CLAIM_TTL_MS;

/**
 * Claim this wallet for `windowLabel`.
 *
 * Returns null on success, or the label of the window that already holds it —
 * the caller needs that label to raise the right window rather than guess.
 *
 * Re-claiming from the same window succeeds: reloads and re-renders must not
 * lock a user out of the wallet they already have open.
 *
 * Unlike the fusion lease this does NOT fail closed without a lock manager.
 * Refusing a round costs a missed round; refusing to open a wallet would make
 * the app unusable, and two windows on one wallet is a correctness annoyance the
 * existing reservations already absorb.
 */
export async function claimWalletOpen(
  walletId: number,
  windowLabel: string,
  nowMs = Date.now(),
  /**
   * Does the window holding this claim still exist?
   *
   * Closing a window releases nothing — the X button runs no handler we can rely
   * on, and a crash or kill runs none at all — so without this the claim lingers
   * for its whole TTL and the user is told a wallet is open in a window they
   * just closed. Existence is the truth; the TTL is only a backstop for the case
   * where we cannot ask.
   */
  isWindowOpen?: (label: string) => Promise<boolean>
): Promise<string | null> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return null;

  // Asked BEFORE taking the lock: the probe is async and the critical section
  // must stay synchronous so two windows cannot interleave inside it.
  let holderIsGone = false;
  let probedHolder: OpenClaim | null = null;
  if (isWindowOpen) {
    const existing = readClaims()[String(walletId)];
    if (existing && existing.windowLabel !== windowLabel) {
      probedHolder = existing;
      try {
        holderIsGone = !(await isWindowOpen(existing.windowLabel));
      } catch {
        // Cannot tell — treat the claim as valid and let the TTL settle it.
        holderIsGone = false;
      }
    }
  }

  const claim = (): string | null => {
    const claims = readClaims();
    const held = claims[String(walletId)];
    const canReplaceProbedHolder =
      holderIsGone &&
      probedHolder !== null &&
      held?.windowLabel === probedHolder.windowLabel &&
      held.at === probedHolder.at;
    if (
      held &&
      held.windowLabel !== windowLabel &&
      isLive(held, nowMs) &&
      !canReplaceProbedHolder
    ) {
      return held.windowLabel;
    }
    claims[String(walletId)] = { windowLabel, at: nowMs };
    // Drop dead claims while we are already writing.
    for (const [key, value] of Object.entries(claims)) {
      if (key !== String(walletId) && !isLive(value, nowMs)) delete claims[key];
    }
    writeClaims(claims);
    return null;
  };

  const result = await withWalletLock(walletId, claim);
  return result.ran ? result.value : claim();
}

/** Keep this window's claim alive; a stopped heartbeat frees it after the TTL. */
export async function refreshWalletOpenClaim(
  walletId: number,
  windowLabel: string,
  nowMs = Date.now()
): Promise<void> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  await withWalletLock(walletId, () => {
    const claims = readClaims();
    const held = claims[String(walletId)];
    // Only the owner refreshes. If another window took over after our TTL
    // lapsed, re-stamping would silently steal it back.
    if (held && held.windowLabel !== windowLabel && isLive(held, nowMs)) return;
    claims[String(walletId)] = { windowLabel, at: nowMs };
    writeClaims(claims);
  });
}

/** Release on close/lock so another window can open the wallet immediately. */
export async function releaseWalletOpen(
  walletId: number,
  windowLabel: string
): Promise<void> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  await withWalletLock(walletId, () => {
    const claims = readClaims();
    const held = claims[String(walletId)];
    if (held && held.windowLabel === windowLabel) {
      delete claims[String(walletId)];
      writeClaims(claims);
    }
  });
}

export type ExclusiveWalletOpenResult<T> =
  | { status: 'opened'; value: T }
  | { status: 'held'; windowLabel: string }
  | { status: 'rejected' };

/**
 * Claim, unlock, and either retain or roll back the wallet claim as one
 * lifecycle. Password and biometric opens must use the same path: claiming
 * before verification prevents duplicate key work, while rollback prevents a
 * wrong password or database error from impersonating a live wallet window.
 */
export async function runExclusiveWalletOpen<T>(
  walletId: number,
  windowLabel: string,
  open: () => Promise<T | null>,
  isWindowOpen?: (label: string) => Promise<boolean>
): Promise<ExclusiveWalletOpenResult<T>> {
  const heldBy = await claimWalletOpen(
    walletId,
    windowLabel,
    Date.now(),
    isWindowOpen
  );
  if (heldBy) return { status: 'held', windowLabel: heldBy };

  try {
    const value = await open();
    if (value === null) {
      await releaseWalletOpen(walletId, windowLabel);
      return { status: 'rejected' };
    }
    return { status: 'opened', value };
  } catch (error) {
    await releaseWalletOpen(walletId, windowLabel).catch(() => undefined);
    throw error;
  }
}

/** Window label holding this wallet, or null when nobody live does. */
export function windowHoldingWallet(
  walletId: number,
  nowMs = Date.now()
): string | null {
  const held = readClaims()[String(walletId)];
  return held && isLive(held, nowMs) ? held.windowLabel : null;
}
