// Cross-window mutual exclusion for anything that can spend a fusion fee.
//
// Two separate defects made the previous guards insufficient:
//
// 1. The in-flight guard was a module-level Set, i.e. per WebView context. Two
//    windows holding the same wallet each passed it and could both start a
//    round. Outpoint reservations were the stated fallback, but SERVER fusion
//    does not honour the P2P reservations, so that path was unprotected.
// 2. The auto-fusion cooldown was a plain localStorage read-then-write. That
//    sequence is not atomic across windows: two windows can both read "cooldown
//    elapsed" and both write a fresh stamp, and both then pay a fee.
//
// localStorage gives durability (survives reload, shared across windows) but no
// atomicity. The Web Locks API gives atomicity across same-origin contexts but no
// durability. Neither alone is enough, so every durable read-modify-write here
// happens INSIDE a Web Lock: the lock serialises the windows, the storage record
// survives them.
//
// Where the lock is unavailable, auto-fusion fails CLOSED. Not fusing costs a
// missed round; double-fusing costs a real fee twice.

import { getLocalStorage } from '../../utils/browserStorage';

const LEASE_PREFIX = 'optn-fusion-lease-';
const COOLDOWN_PREFIX = 'optn-fusion-auto-attempt-';
const LOCK_PREFIX = 'optn-fusion-lock-';

/**
 * A round that dies without releasing must not lock the wallet forever, but this
 * must outlive a legitimately slow round: gather alone can take 75s, and the
 * whole round can exceed two minutes on Tor.
 */
const LEASE_TTL_MS = 10 * 60_000;

interface LeaseRecord {
  owner: string;
  at: number;
}

type LockManagerLike = {
  request: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

function lockManager(): LockManagerLike | null {
  const candidate = (globalThis as { navigator?: { locks?: LockManagerLike } })
    .navigator?.locks;
  return candidate && typeof candidate.request === 'function' ? candidate : null;
}

/**
 * Run `critical` with cross-window exclusivity for this wallet.
 *
 * Returns `null` when no lock manager exists, so callers can distinguish
 * "ran and produced a result" from "could not guarantee exclusivity" and decide
 * for themselves. Fee-spending callers must treat null as failure.
 */
export async function withWalletLock<T>(
  walletId: number,
  critical: () => T | Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  const locks = lockManager();
  if (!locks) return { ran: false };
  const value = await locks.request(`${LOCK_PREFIX}${walletId}`, async () =>
    critical()
  );
  return { ran: true, value };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = getLocalStorage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    getLocalStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function newOwnerToken(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Take the round lease for this wallet, covering BOTH transports and both manual
 * and automatic starts. Returns an owner token, or null when another window (or
 * this one) already holds a live lease.
 */
export async function acquireRoundLease(
  walletId: number,
  nowMs = Date.now()
): Promise<string | null> {
  const key = `${LEASE_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    const held = readJson<LeaseRecord>(key);
    // An expired lease belongs to a round that died; reclaiming it is the only
    // way a crashed window does not lock the wallet out permanently.
    if (held && nowMs - held.at < LEASE_TTL_MS) return null;
    const owner = newOwnerToken();
    writeJson(key, { owner, at: nowMs } satisfies LeaseRecord);
    return owner;
  });
  // No lock manager => exclusivity cannot be guaranteed => refuse.
  return result.ran ? result.value : null;
}

/** Release only if we still hold it: a lease we already lost to TTL now belongs
 *  to another window, and clearing it would let a third start concurrently. */
export async function releaseRoundLease(
  walletId: number,
  owner: string
): Promise<void> {
  const key = `${LEASE_PREFIX}${walletId}`;
  await withWalletLock(walletId, () => {
    const held = readJson<LeaseRecord>(key);
    if (held && held.owner === owner) {
      try {
        getLocalStorage()?.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    }
  });
}

/**
 * Atomically decide whether an automatic round may start, and claim the slot in
 * the same critical section.
 *
 * Check and claim must not be separable. Checking, doing network I/O, then
 * claiming lets a second window pass the check during that I/O window and pay a
 * second fee. Returns false — fail closed — when exclusivity is unavailable.
 */
export async function tryClaimAutoCooldown(
  walletId: number,
  cooldownMs: number,
  nowMs = Date.now()
): Promise<boolean> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    const previous = readJson<{ attempt: number }>(key);
    const last = typeof previous?.attempt === 'number' ? previous.attempt : null;
    // A clock that moved backwards must read as "not yet", never as "elapsed".
    if (last !== null && nowMs - last < cooldownMs) return false;
    writeJson(key, { attempt: nowMs });
    return true;
  });
  return result.ran ? result.value : false;
}

/** Read-only view, for status text. Never gates spending on its own. */
export function lastAutoAttemptAt(walletId: number): number | null {
  const record = readJson<{ attempt: number }>(`${COOLDOWN_PREFIX}${walletId}`);
  return typeof record?.attempt === 'number' ? record.attempt : null;
}
