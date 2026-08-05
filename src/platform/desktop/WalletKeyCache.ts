// In-memory cache for the wallet password and KDF salt.
//
// Ciphertext model: the derived CryptoKey NEVER persists in RAM. Instead we
// cache the password + salt and re-derive the key ephemerally on each
// encrypt/decrypt / sign operation. This means an attacker who dumps RAM
// between operations gets only ciphertext + password — they still need the
// salt (in the OS keychain on desktop) to derive the usable key.
//
// Populated on wallet unlock, wiped on lock or app close.

import { deriveKey } from './WalletCrypto';

export type CachedPasswordSnapshot = Readonly<{
  password: string;
  salt: Uint8Array;
  ownerWalletId: number | null;
}>;

let _cached: CachedPasswordSnapshot | null = null;

// Bumped on every unlock and every wipe. Anything derived from an unlock —
// a passed re-auth, for instance — can pin the epoch it was granted under and
// find out later that its session is gone. That makes "still authorised?" a
// question about the current session rather than about wall-clock time, so a
// lock/unlock cycle or a switch to another wallet invalidates it for free.
let _unlockEpoch = 0;

/**
 * Watch-only session marker.
 *
 * A watch-only wallet has no password and no KDF salt — there is nothing to
 * cache. The shell still needs to know "this wallet is intentionally open",
 * otherwise its credential invariant (DesktopAppShell) would eject the wallet
 * the moment it is opened. Marked by openWatchOnlyWallet, cleared by
 * clearCachedPassword (lock) and on wallet switch.
 */
let _watchOnlyWalletId: number | null = null;

/** Identifies the current unlock session. Changes on every unlock and lock. */
export function getUnlockEpoch(): number {
  return _unlockEpoch;
}

/**
 * Mark a watch-only wallet as the intentionally-open session.
 *
 * The wallet itself carries no credentials; this marker is the only thing the
 * shell can check to keep it open. Wiped by clearCachedPassword (lock) so an
 * inactivity lock closes a watch-only wallet like any other.
 */
export function markWatchOnlySession(walletId: number): void {
  _watchOnlyWalletId = walletId;
  _unlockEpoch += 1;
}

export function clearWatchOnlySession(): void {
  _watchOnlyWalletId = null;
  _unlockEpoch += 1;
}

/** Is a watch-only session currently open (optionally for this wallet)? */
export function hasWatchOnlySession(walletId?: number): boolean {
  if (_watchOnlyWalletId === null) return false;
  return walletId === undefined || _watchOnlyWalletId === walletId;
}

/**
 * Cache wallet credentials so the derived key can be re-derived on demand.
 */
export function setCachedPassword(
  password: string,
  salt: Uint8Array,
  ownerWalletId: number | null = null
): void {
  _cached = { password, salt, ownerWalletId };
  _unlockEpoch += 1;
}

/**
 * Re-derive the CryptoKey from the cached password + salt.
 * Returns null if nothing is cached. The caller MUST discard the key after use.
 */
export async function deriveCachedKey(): Promise<CryptoKey | null> {
  if (!_cached) return null;
  return deriveKey(_cached.password, _cached.salt);
}

/** True if wallet credentials are cached (sync check for isUnlocked()). */
export function isCached(): boolean {
  return _cached !== null;
}

export function getCachedOwnerWalletId(): number | null {
  return _cached?.ownerWalletId ?? null;
}

/**
 * Sync session check used by the desktop shell: is this wallet allowed to stay
 * open given what is currently in RAM?
 *
 * - No cache and no watch-only marker → not open.
 * - Watch-only marker matches this wallet → open (it has no credentials by
 *   design; the marker IS its session).
 * - `ownerWalletId === null` → shared/legacy gate credentials (valid for the
 *   wallet that just unlocked them; shell treats any positive walletId as ok
 *   once open, because openWalletWithPassword only runs after verify).
 * - `ownerWalletId === walletId` → this wallet's own session.
 *
 * This is NOT a CryptoKey. After the ciphertext-model migration the derived
 * key is never held in RAM; callers that only need a presence check must use
 * this (or `isCached`) instead of the deprecated `getCachedWalletKey*` stubs.
 */
export function hasCachedCredentialsForWallet(walletId: number): boolean {
  if (_watchOnlyWalletId === walletId) return true;
  if (!_cached) return false;
  if (_cached.ownerWalletId == null) return true;
  return _cached.ownerWalletId === walletId;
}

export function getCachedPasswordSnapshot(): CachedPasswordSnapshot | null {
  return _cached ? { ..._cached } : null;
}

export function clearCachedPassword(): void {
  _cached = null;
  _watchOnlyWalletId = null;
  _unlockEpoch += 1;
  console.log('[WalletKeyCache] Password + salt wiped from memory');
  // Void Never-mode spend window (epoch mismatch also covers this; explicit
  // clear avoids any race with a mid-flight send).
  try {
    // Lazy require avoided circular import at module load in tests.
    void import('./DeviceIntegrityService').then((m) => m.clearSpendAuthCache());
  } catch {
    /* optional */
  }
}

// ── Backward-compat wrappers (deprecated — prefer setCachedPassword / deriveCachedKey) ──

/**
 * @deprecated Use setCachedPassword() instead. This wrapper exists only so
 * callers can be migrated incrementally. It will be removed once all callers
 * have been updated.
 */
export function setCachedWalletKey(
  _key: CryptoKey,
  _ownerWalletId: number | null = null // eslint-disable-line @typescript-eslint/no-unused-vars
): void {
  console.warn('[WalletKeyCache] setCachedWalletKey is deprecated — migrate to setCachedPassword');
}

/**
 * @deprecated Use deriveCachedKey() instead.
 */
export function getCachedWalletKey(): CryptoKey | null {
  console.warn('[WalletKeyCache] getCachedWalletKey is deprecated — migrate to deriveCachedKey');
  return null;
}

/**
 * @deprecated Use hasCachedCredentialsForWallet() / deriveCachedKey().
 * CryptoKeys are not cached; this always returns null. Presence checks must
 * use hasCachedCredentialsForWallet — the desktop shell was broken when it
 * still treated "null key" as "not unlocked".
 */
export function getCachedWalletKeyForWallet(_walletId: number): CryptoKey | null { // eslint-disable-line @typescript-eslint/no-unused-vars
  console.warn(
    '[WalletKeyCache] getCachedWalletKeyForWallet is deprecated — use hasCachedCredentialsForWallet'
  );
  return null;
}

/**
 * @deprecated Use getCachedPasswordSnapshot() instead.
 */
export function getCachedWalletKeySnapshot(): { key: CryptoKey; ownerWalletId: number | null } | null {
  console.warn('[WalletKeyCache] getCachedWalletKeySnapshot is deprecated');
  return null;
}

/**
 * @deprecated Use clearCachedPassword() instead.
 */
export function clearCachedWalletKey(): void {
  clearCachedPassword();
}
