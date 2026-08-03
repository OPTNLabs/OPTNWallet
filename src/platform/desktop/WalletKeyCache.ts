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

/**
 * Cache wallet credentials so the derived key can be re-derived on demand.
 */
export function setCachedPassword(
  password: string,
  salt: Uint8Array,
  ownerWalletId: number | null = null
): void {
  _cached = { password, salt, ownerWalletId };
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

export function getCachedPasswordSnapshot(): CachedPasswordSnapshot | null {
  return _cached ? { ..._cached } : null;
}

export function clearCachedPassword(): void {
  _cached = null;
  console.log('[WalletKeyCache] Password + salt wiped from memory');
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
 * @deprecated Use deriveCachedKey() + getCachedOwnerWalletId() instead.
 */
export function getCachedWalletKeyForWallet(_walletId: number): CryptoKey | null { // eslint-disable-line @typescript-eslint/no-unused-vars
  console.warn('[WalletKeyCache] getCachedWalletKeyForWallet is deprecated');
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
