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
import { AUTO_FUSION_COOLDOWN_MS } from './fusionAutoEngine';
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
  return candidate && typeof candidate.request === 'function'
    ? candidate
    : null;
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

function writeJson(key: string, value: unknown): boolean {
  const storage = getLocalStorage();
  if (!storage) return false;
  const serialized = JSON.stringify(value);
  try {
    storage.setItem(key, serialized);
    // Web storage can be wrapped or fail silently. A fee-spending lease is not
    // real until the exact record is readable while we still hold the Web Lock.
    return storage.getItem(key) === serialized;
  } catch {
    return false;
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
  return writeJson(key, { owner, at: nowMs } satisfies LeaseRecord)
    ? owner
    : null;
}

export async function acquireRoundLease(
  walletId: number,
  nowMs = Date.now()
): Promise<string | null> {
  const result = await withWalletLock(walletId, () =>
    takeLeaseIfFree(walletId, nowMs)
  );
  // Every round can spend a fee. Manual starts need the same cross-window
  // atomicity as Auto, so never create a storage-only lease.
  return result.ran ? result.value : null;
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
    return writeJson(key, { owner, at: nowMs } satisfies LeaseRecord);
  });
  // Losing the process-wide lock primitive mid-round is uncertainty, not a
  // single-window mode. Abort before spending rather than refresh non-atomically.
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
export async function reclaimStaleRoundState(
  walletId: number,
  cleanup: () => void
): Promise<boolean> {
  const key = `${LEASE_PREFIX}${walletId}`;
  const result = await withWalletLock(walletId, () => {
    // Re-read inside the wallet lock: another window may have replaced the
    // stale lease while this recovery attempt waited for exclusivity.
    if (leaseIsLive(readJson<LeaseRecord>(key), Date.now())) return false;
    try {
      getLocalStorage()?.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    cleanup();
    return true;
  });
  // Owner-independent deletion has no safe storage-only fallback across
  // windows. Without Web Locks, fail closed and leave the record untouched.
  return result.ran ? result.value : false;
}

export async function forceClearRoundLease(walletId: number): Promise<boolean> {
  return reclaimStaleRoundState(walletId, () => undefined);
}

/** Read-only: whether a non-stale durable lease is recorded for this wallet. */
export function hasLiveRoundLease(
  walletId: number,
  nowMs = Date.now()
): boolean {
  return leaseIsLive(
    readJson<LeaseRecord>(`${LEASE_PREFIX}${walletId}`),
    nowMs
  );
}

/**
 * Cooldown record: when the next auto attempt is allowed (`nextAllowedAt`).
 * Legacy records only had `{ attempt }` (last start time) — treat those as
 * nextAllowedAt = attempt + 90s so we do not keep a 5‑minute death-sentence
 * from failed P2P "no peers" stamps.
 *
 * `reason: 'depth-met'` means Auto is sleeping because rounds-per-coin is
 * already satisfied. Wallet activity (receive, send, any UTXO-changing tx)
 * that leaves coins below depth may clear that idle without waiting out the
 * long timer — short success/fail cooldowns never use this reason.
 */
type CooldownRecord = {
  nextAllowedAt?: number;
  /** @deprecated legacy last-start stamp */
  attempt?: number;
  reason?: 'depth-met' | 'success' | 'fail' | 'claim';
};

function readCooldownRecord(walletId: number): CooldownRecord | null {
  return readJson<CooldownRecord>(`${COOLDOWN_PREFIX}${walletId}`);
}

function readNextAllowedAt(walletId: number): number | null {
  const record = readCooldownRecord(walletId);
  if (!record) return null;
  if (
    typeof record.nextAllowedAt === 'number' &&
    Number.isFinite(record.nextAllowedAt)
  ) {
    return record.nextAllowedAt;
  }
  // Legacy records only stamped `attempt` (old code used ~5 min). Cap residual
  // at success cooldown so upgrades never re-introduce multi-minute silence.
  if (typeof record.attempt === 'number' && Number.isFinite(record.attempt)) {
    return record.attempt + AUTO_FUSION_COOLDOWN_MS;
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
    // Soft hold until outcome stamps success or fail.
    return writeJson(key, {
      nextAllowedAt: nowMs + AUTO_FUSION_COOLDOWN_MS,
      attempt: nowMs,
      reason: 'claim',
    });
  });
  return result.ran ? result.value : false;
}

/** Persist a cooldown stamp; prefer Web Lock, always write as best-effort. */
async function stampCooldown(
  walletId: number,
  record: CooldownRecord
): Promise<void> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  const write = () => writeJson(key, record);
  const result = await withWalletLock(walletId, write);
  // Without a lock (or if request never runs) still write: silent no-op made
  // depth-met / fail stamps vanish and Auto thrashed every engine tick.
  if (!result.ran) write();
}

/** After a successful paid fuse — full spacing. */
export async function stampAutoSuccess(
  walletId: number,
  cooldownMs: number,
  nowMs = Date.now()
): Promise<void> {
  await stampCooldown(walletId, {
    nextAllowedAt: nowMs + cooldownMs,
    attempt: nowMs,
    reason: 'success',
  });
}

/** After a failed auto attempt (no fee spent) — short retry backoff. */
export async function stampAutoFailure(
  walletId: number,
  backoffMs: number,
  nowMs = Date.now()
): Promise<void> {
  await stampCooldown(walletId, {
    nextAllowedAt: nowMs + backoffMs,
    attempt: nowMs,
    reason: 'fail',
  });
}

/**
 * Rounds-per-coin already met (or no BCH coins). Long silent idle — only a
 * wallet UTXO change with below-depth coins should wake Auto early.
 */
export async function stampAutoDepthMetIdle(
  walletId: number,
  idleMs: number,
  nowMs = Date.now()
): Promise<void> {
  await stampCooldown(walletId, {
    nextAllowedAt: nowMs + idleMs,
    attempt: nowMs,
    reason: 'depth-met',
  });
}

/** True while Auto is in the long depth-met sleep (not short success/fail). */
export function isAutoDepthMetIdle(
  walletId: number,
  nowMs = Date.now()
): boolean {
  const record = readCooldownRecord(walletId);
  if (!record || record.reason !== 'depth-met') return false;
  const next = readNextAllowedAt(walletId);
  return next !== null && nowMs < next;
}

/** Allow Auto to run immediately (e.g. after depth-met idle + wallet activity). */
export async function clearAutoCooldown(walletId: number): Promise<void> {
  const key = `${COOLDOWN_PREFIX}${walletId}`;
  await withWalletLock(walletId, () => {
    writeJson(key, { nextAllowedAt: 0, attempt: Date.now() });
  });
}

/**
 * Wallet activity wake: receive, send, change, any committed UTXO snapshot.
 * If any coin is still below rounds-per-coin, clear long idles so Auto runs.
 *
 * Clears:
 *   - explicit depth-met idle (`reason: 'depth-met'`)
 *   - any remaining wait longer than a normal success cooldown (covers legacy
 *     depth stamps that used `reason: 'fail'` with a 30m backoff — those never
 *     woke after send/receive)
 *
 * Does NOT clear short success/fail spacing so post-fuse thrash is avoided when
 * the same UTXO refresh fires after a paid round.
 *
 * Returns true if cooldown was cleared (caller should tick Auto).
 */
export async function wakeAutoFromWalletActivity(
  walletId: number,
  hasCoinsBelowDepth: boolean,
  nowMs = Date.now()
): Promise<boolean> {
  if (!hasCoinsBelowDepth) return false;
  if (isAutoDepthMetIdle(walletId, nowMs)) {
    await clearAutoCooldown(walletId);
    return true;
  }
  // Legacy multi-minute leftovers only — never clear a short success/fail
  // cooldown (remaining is usually ≈ AUTO_FUSION_COOLDOWN_MS).
  const next = readNextAllowedAt(walletId);
  const remaining = next !== null ? next - nowMs : 0;
  if (remaining > 2 * 60_000) {
    await clearAutoCooldown(walletId);
    return true;
  }
  return false;
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
