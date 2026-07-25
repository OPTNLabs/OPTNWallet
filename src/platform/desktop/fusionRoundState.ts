// Cross-window, reload-surviving state for P2P Fusion rounds.
//
// Two failures made live rounds unwinnable, and both come from state that only
// lived in one window's memory:
//
// 1. "N peers" counting more peers than there are wallets. Every attempt mints a
//    throwaway round key, and the pool announcement is a STORED event a relay
//    keeps replaying. Remembering our own keys in a module variable is lost on
//    reload, and is invisible to a second window running the SAME wallet, so
//    those keys come back as "peers" — we then try to fuse with ourselves.
//
// 2. "Missing inputs" at broadcast. Nothing reserved the coins a round was
//    using, so two rounds (two windows, or a retry overlapping its predecessor)
//    picked the same UTXOs. The first to broadcast spent them; the second
//    referenced outpoints that no longer existed — and only found out after
//    every peer had signed.
//
// localStorage is shared by every window of the app and survives reloads, which
// is exactly the scope both problems need. Entries are timestamped and pruned,
// so a crashed round cannot lock coins forever.

import { getLocalStorage } from '../../utils/browserStorage';

const ROUND_KEYS_PREFIX = 'optn-fusion-round-keys-';
const INPUT_LOCKS_PREFIX = 'optn-fusion-input-locks-';

/** Long enough to cover a stored announcement's discoverable lifetime. */
const ROUND_KEY_TTL_MS = 10 * 60_000;
/** A round that dies without cleanup must not strand coins beyond this. */
const INPUT_LOCK_TTL_MS = 5 * 60_000;

/** value -> epoch ms it was recorded. */
type Stamped = Record<string, number>;

function read(storageKey: string): Stamped {
  try {
    const raw = getLocalStorage()?.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stamped = {};
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[key] = at;
    }
    return out;
  } catch {
    return {};
  }
}

function write(storageKey: string, entries: Stamped, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  const pruned: Stamped = {};
  for (const [key, at] of Object.entries(entries)) {
    if (at >= cutoff) pruned[key] = at;
  }
  try {
    getLocalStorage()?.setItem(storageKey, JSON.stringify(pruned));
  } catch {
    /* storage unavailable — callers degrade to in-round behaviour only */
  }
}

function live(storageKey: string, ttlMs: number): Set<string> {
  const cutoff = Date.now() - ttlMs;
  return new Set(
    Object.entries(read(storageKey))
      .filter(([, at]) => at >= cutoff)
      .map(([key]) => key)
  );
}

/** Remember a throwaway round key we just minted for this wallet. */
export function recordRoundKey(walletId: number, pubkey: string): void {
  const storageKey = `${ROUND_KEYS_PREFIX}${walletId}`;
  const entries = read(storageKey);
  entries[pubkey] = Date.now();
  write(storageKey, entries, ROUND_KEY_TTL_MS);
}

/** True when this pool announcement is one of THIS wallet's own attempts. */
export function isOwnRoundKey(walletId: number, pubkey: string): boolean {
  return live(`${ROUND_KEYS_PREFIX}${walletId}`, ROUND_KEY_TTL_MS).has(pubkey);
}

/** Outpoints currently claimed by an in-flight round of this wallet. */
export function reservedOutpoints(walletId: number): Set<string> {
  return live(`${INPUT_LOCKS_PREFIX}${walletId}`, INPUT_LOCK_TTL_MS);
}

export function reserveOutpoints(walletId: number, outpoints: string[]): void {
  if (outpoints.length === 0) return;
  const storageKey = `${INPUT_LOCKS_PREFIX}${walletId}`;
  const entries = read(storageKey);
  const now = Date.now();
  outpoints.forEach((outpoint) => {
    entries[outpoint] = now;
  });
  write(storageKey, entries, INPUT_LOCK_TTL_MS);
}

export function releaseOutpoints(walletId: number, outpoints: string[]): void {
  if (outpoints.length === 0) return;
  const storageKey = `${INPUT_LOCKS_PREFIX}${walletId}`;
  const entries = read(storageKey);
  outpoints.forEach((outpoint) => {
    delete entries[outpoint];
  });
  write(storageKey, entries, INPUT_LOCK_TTL_MS);
}

export const outpointKey = (txid: string, index: number): string =>
  `${txid}:${index}`;

const AUTO_ATTEMPT_PREFIX = 'optn-fusion-auto-attempt-';
/** Kept well beyond the engine's cooldown so the stamp outlives the window it
 *  bounds; the engine compares timestamps itself rather than relying on expiry. */
const AUTO_ATTEMPT_TTL_MS = 24 * 60 * 60_000;

/**
 * When this WALLET last started an automatic round, in any window.
 *
 * Deliberately not Redux: the auto-fusion cooldown is the only thing bounding how
 * often the engine spends a fee, and Redux state is per-window and dies on
 * reload. A stamp kept there would let a reload — or simply opening a second
 * window on the same wallet — start another paid round immediately, silently
 * removing the ceiling. localStorage is shared across windows and survives
 * reloads, which is exactly the scope a spending limit needs.
 */
export function lastAutoAttemptAt(walletId: number): number | null {
  const entries = read(`${AUTO_ATTEMPT_PREFIX}${walletId}`);
  const at = entries.attempt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Claim the next automatic attempt for this wallet.
 *
 * Called BEFORE any network work, not after success: a round that dies halfway
 * still consumed the opportunity, and stamping only on success would let a
 * repeatedly-failing wallet retry in a tight loop, paying every time.
 */
export function claimAutoAttempt(walletId: number, nowMs = Date.now()): void {
  const storageKey = `${AUTO_ATTEMPT_PREFIX}${walletId}`;
  write(storageKey, { attempt: nowMs }, AUTO_ATTEMPT_TTL_MS);
}
