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
import { P2P_LEASE_TTL_MS } from './fusionTiming';

const LEASE_PREFIX = 'optn-fusion-lease-';
const COOLDOWN_PREFIX = 'optn-fusion-auto-attempt-';
const LOCK_PREFIX = 'optn-fusion-lock-';

/**
 * Absolute backstop if heartbeats stop being written (process kill + no reclaim).
 * Sized to server session ceiling (join + warmup + close) + small margin —
 * see fusionTiming.P2P_LEASE_TTL_MS. Not a license for longer rounds.
 */
export const LEASE_TTL_MS = P2P_LEASE_TTL_MS;

/**
 * A live round refreshes `at` every LEASE_HEARTBEAT_MS. If `at` is older than
 * this, the holder is considered dead (HMR, crash, closed window) and the next
 * acquire reclaims the lock. This is what fixes "already running" with a grey
 * idle UI after a stuck attempt.
 */
export const LEASE_STALE_MS = 45_000;
/** How often the holding window must refresh the durable lease. */
export const LEASE_HEARTBEAT_MS = 12_000;

interface LeaseRecord {
  owner: string;
  /** Last heartbeat (or grant time). */
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
 * True when another window (or a dead process) still holds a non-stale lease.
 * Stale = no heartbeat within LEASE_STALE_MS, or past absolute LEASE_TTL_MS.
 */
function leaseIsLive(held: LeaseRecord | null, nowMs: number): boolean {
  if (!held) return false;
  const age = nowMs - held.at;
  if (age < 0) return true; // clock skew: treat as held, fail closed
  if (age >= LEASE_TTL_MS) return false;
  if (age >= LEASE_STALE_MS) return false;
  return true;
}

/**
 * Take the round lease for this wallet, covering BOTH transports and both manual
 * and automatic starts. Returns an owner token, or null when another window (or
 * this one) already holds a live lease.
 */
function takeLeaseIfFree(walletId: number, nowMs: number): string | null {
  const key = `${LEASE_PREFIX}${walletId}`;
  const held = readJson<LeaseRecord>(key);
  // Live holder still heartbeating → refuse. Dead/stale → reclaim.
  if (leaseIsLive(held, nowMs)) return null;
  const owner = newOwnerToken();
  writeJson(key, { owner, at: nowMs } satisfies LeaseRecord);
  return owner;
}

export async function acquireRoundLease(
  walletId: number,
  nowMs = Date.now()
): Promise<string | null> {
  const result = await withWalletLock(walletId, () =>
    takeLeaseIfFree(walletId, nowMs)
  );
  if (result.ran) return result.value;
  // No Web Locks (some WebViews): still allow single-window via storage +
  // stale reclaim. Prefer fusing over permanent "busy".
  return takeLeaseIfFree(walletId, nowMs);
}

/**
 * Refresh the durable lease while a round is still running.
 * Call from the holding window on an interval (LEASE_HEARTBEAT_MS).
 */
export async function touchRoundLease(
  walletId: number,
  owner: string,
  nowMs = Date.now()
): Promise<boolean> {
  const key = `${LEASE_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    const held = readJson<LeaseRecord>(key);
    if (!held || held.owner !== owner) return false;
    writeJson(key, { owner, at: nowMs } satisfies LeaseRecord);
    return true;
  });
  return result.ran ? result.value : false;
}

/** Release only if we still hold it: a lease we already lost to TTL now belongs
 *  to another window, and clearing it would let a third start concurrently. */
export async function releaseRoundLease(
  walletId: number,
  owner: string
): Promise<void> {
  const key = `${LEASE_PREFIX}${walletId}`;
  const drop = () => {
    const held = readJson<LeaseRecord>(key);
    if (held && held.owner === owner) {
      try {
        getLocalStorage()?.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    }
  };
  const result = await withWalletLock(walletId, drop);
  if (!result.ran) drop();
}

/**
 * Drop the durable round lease for this wallet regardless of owner.
 *
 * Use for recovery when a round died without `releaseRoundLease` (HMR, crash,
 * killed process) and the 10-minute TTL has not elapsed yet — the UI shows
 * "already running" while nothing is actually fusing. Do not call this while a
 * real round is live in another window of the same wallet.
 */
export async function forceClearRoundLease(walletId: number): Promise<void> {
  const key = `${LEASE_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  });
  if (!result.ran) {
    // No Web Lock API: still try a best-effort remove (single-window recovery).
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Read-only: whether a non-stale durable lease is recorded for this wallet. */
export function hasLiveRoundLease(
  walletId: number,
  nowMs = Date.now()
): boolean {
  return leaseIsLive(readJson<LeaseRecord>(`${LEASE_PREFIX}${walletId}`), nowMs);
}

/**
 * Cooldown record: when the next auto attempt is allowed (`nextAllowedAt`).
 * Legacy records only had `{ attempt }` (last start time) — treat those as
 * nextAllowedAt = attempt + 90s so we do not keep a 5‑minute death-sentence
 * from failed P2P "no peers" stamps.
 */
type CooldownRecord = {
  nextAllowedAt?: number;
  /** @deprecated legacy last-start stamp */
  attempt?: number;
};

function readNextAllowedAt(walletId: number): number | null {
  const record = readJson<CooldownRecord>(`${COOLDOWN_PREFIX}${walletId}`);
  if (!record) return null;
  if (typeof record.nextAllowedAt === 'number' && Number.isFinite(record.nextAllowedAt)) {
    return record.nextAllowedAt;
  }
  // Legacy: failed rounds stamped `attempt=now` then enforced 5 min. Cap the
  // residual wait at 90s so autofuse recovers after upgrades.
  if (typeof record.attempt === 'number' && Number.isFinite(record.attempt)) {
    return record.attempt + 90_000;
  }
  return null;
}

/**
 * Atomically decide whether an automatic round may start.
 * Reserves a short mutual-exclusion window so two windows do not both start;
 * the final nextAllowedAt is set after the outcome (success vs failure).
 */
export async function tryClaimAutoCooldown(
  walletId: number,
  _cooldownMs: number,
  nowMs = Date.now()
): Promise<boolean> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    const next = readNextAllowedAt(walletId);
    if (next !== null && nowMs < next) return false;
    // Soft hold until outcome stamps the real wait (≤ post-success cooldown).
    writeJson(key, { nextAllowedAt: nowMs + 45_000, attempt: nowMs });
    return true;
  });
  return result.ran ? result.value : false;
}

/** After a successful paid fuse — full spacing. */
export async function stampAutoSuccess(
  walletId: number,
  cooldownMs: number,
  nowMs = Date.now()
): Promise<void> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  await withWalletLock(walletId, () => {
    writeJson(key, { nextAllowedAt: nowMs + cooldownMs, attempt: nowMs });
  });
}

/** After a failed auto attempt (no fee spent) — short retry backoff. */
export async function stampAutoFailure(
  walletId: number,
  backoffMs: number,
  nowMs = Date.now()
): Promise<void> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  await withWalletLock(walletId, () => {
    writeJson(key, { nextAllowedAt: nowMs + backoffMs, attempt: nowMs });
  });
}

/** Read-only view, for status text. Never gates spending on its own. */
export function lastAutoAttemptAt(walletId: number): number | null {
  const record = readJson<CooldownRecord>(`${COOLDOWN_PREFIX}${walletId}`);
  if (!record) return null;
  if (typeof record.attempt === 'number') return record.attempt;
  if (typeof record.nextAllowedAt === 'number') return record.nextAllowedAt;
  return null;
}

/**
 * Cheap advisory check used before expensive wallet/network reconciliation.
 */
export function isAutoCooldownReady(
  walletId: number,
  _cooldownMs: number,
  nowMs = Date.now()
): boolean {
  const next = readNextAllowedAt(walletId);
  if (next === null) return true;
  return nowMs >= next;
}
