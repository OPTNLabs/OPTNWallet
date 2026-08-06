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
/** Global (all wallets/windows): keys that withdrew or finished a gather. */
const RETIRED_KEYS_KEY = 'optn-fusion-retired-round-keys';
/**
 * Ephemeral session keys that were *verified* blame targets this attempt.
 * Not a person ban — throwaway keys only, short TTL. Never for timeouts.
 */
const BLAMED_SESSION_KEYS_KEY = 'optn-fusion-blamed-session-keys';

/** Long enough to cover a stored announcement's discoverable lifetime. */
const ROUND_KEY_TTL_MS = 10 * 60_000;
/** A round that dies without cleanup must not strand coins beyond this. */
const INPUT_LOCK_TTL_MS = 5 * 60_000;
/**
 * How long other windows treat a finished/withdrawn throwaway key as a ghost.
 * Must cover relay replay of replaceable announcements after withdraw.
 */
const RETIRED_KEY_TTL_MS = 5 * 60_000;
/** How long a blamed throwaway key is excluded from local gather/propose. */
const BLAMED_SESSION_KEY_TTL_MS = 10 * 60_000;

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

/**
 * Mark a throwaway round key as dead for EVERY window.
 * Call on withdraw / after gather ends so other wallets stop counting it as a
 * "live peer" (user: 4 wallets, "7 live peers" from abandoned Start clicks).
 */
export function retireRoundKey(pubkey: string): void {
  if (!pubkey || pubkey.length < 32) return;
  const entries = read(RETIRED_KEYS_KEY);
  entries[pubkey] = Date.now();
  write(RETIRED_KEYS_KEY, entries, RETIRED_KEY_TTL_MS);
}

/**
 * Before minting a new round key, retire every previous attempt of this wallet.
 * Other windows share localStorage and stop counting those throwaways as peers —
 * same wallet double-Start was a main source of "5–7 live with 4 wallets".
 */
export function retireAllOwnRoundKeys(walletId: number): void {
  const keys = live(`${ROUND_KEYS_PREFIX}${walletId}`, ROUND_KEY_TTL_MS);
  keys.forEach((pubkey) => retireRoundKey(pubkey));
}

/** True when any wallet has retired this announcement key. */
export function isRetiredRoundKey(pubkey: string): boolean {
  return live(RETIRED_KEYS_KEY, RETIRED_KEY_TTL_MS).has(pubkey);
}

/**
 * Record a verified blame target (ephemeral session pubkey only).
 * Local-only; does not publish identity or IP.
 */
export function recordBlamedSessionKey(pubkey: string): void {
  if (!pubkey || pubkey.length < 32) return;
  const entries = read(BLAMED_SESSION_KEYS_KEY);
  entries[pubkey] = Date.now();
  write(BLAMED_SESSION_KEYS_KEY, entries, BLAMED_SESSION_KEY_TTL_MS);
}

/** True when this throwaway key was blamed recently (exclude from propose). */
export function isBlamedSessionKey(pubkey: string): boolean {
  return live(BLAMED_SESSION_KEYS_KEY, BLAMED_SESSION_KEY_TTL_MS).has(pubkey);
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

/**
 * Drop every outpoint lock for this wallet. Safe only when no live fusion lease
 * exists (idle reconcile / HMR ghost cleanup). Without this, a crashed round
 * greys out coins for up to {@link INPUT_LOCK_TTL_MS} while Start stayed clickable.
 */
export function clearOutpointReservations(walletId: number): void {
  if (!Number.isInteger(walletId) || walletId <= 0) return;
  try {
    getLocalStorage()?.removeItem(`${INPUT_LOCKS_PREFIX}${walletId}`);
  } catch {
    /* storage unavailable */
  }
}

export const outpointKey = (txid: string, index: number): string =>
  `${txid}:${index}`;

export interface FusionCoinAvailability {
  /** Non-token UTXOs in the wallet view. */
  total: number;
  /** Not reserved by a fusion round. */
  free: number;
  /** Held by a (possibly ghost) fusion reservation. */
  reserved: number;
}

/**
 * How many non-token coins are free to fuse right now.
 * Used by CashFusion UI to grey Start/Fuse instead of failing after click.
 */
export function fusionCoinAvailability(
  walletId: number,
  utxos: ReadonlyArray<{ tx_hash: string; tx_pos: number; token?: unknown }>
): FusionCoinAvailability {
  const nonToken = utxos.filter((utxo) => !utxo.token);
  const claimed = reservedOutpoints(walletId);
  let free = 0;
  for (const utxo of nonToken) {
    if (!claimed.has(outpointKey(utxo.tx_hash, utxo.tx_pos))) free += 1;
  }
  return {
    total: nonToken.length,
    free,
    reserved: nonToken.length - free,
  };
}
