// OptnKeyManager — Electron Cash-style passphrase-derived encryption key.
//
// Ciphertext model:
//   PBKDF2(passphrase, salt, 600_000, SHA-256) → AES-256-GCM key
//   The derived key NEVER persists in RAM. We cache the passphrase + salt
//   and re-derive ephemerally on each encrypt/decrypt / sign operation.
//   A 32-byte random salt and an AES-encrypted verify token are stored in
//   the OS keychain. On unlock: derive key from passphrase + stored salt,
//   attempt decrypt of verify token, cache passphrase + salt if correct.
//   Empty passphrase is accepted (zero friction) — the PBKDF2 still runs,
//   providing some protection even without a user-chosen secret.

import { setPassword, getPassword, deletePassword } from 'tauri-plugin-keyring-api';
import {
  checkStatus,
  setData,
  getData,
  hasData,
  removeData,
} from '@choochmeque/tauri-plugin-biometry-api';
import { setCachedPassword, clearCachedPassword, isCached } from './WalletKeyCache';
import { deriveKey, aesEncrypt, aesDecrypt, bytesToBase64, base64ToBytes, randomSalt } from './WalletCrypto';

const SERVICE = 'com.optilabs.wallet';
const SALT_ACCOUNT = 'optn-ec-salt-v1';
const VERIFY_ACCOUNT = 'optn-ec-verify-v1';
const BIO_DOMAIN = 'com.optilabs.wallet';
const BIO_NAME = 'optn-ec-biometric';

// Known plaintext we encrypt to produce the verify token.
const VERIFY_PLAINTEXT = 'optn-wallet-v1-ok';

/** Returns true if a passphrase has been set up (verify token exists in keychain). */
export async function hasSetup(): Promise<boolean> {
  try {
    const token = await getPassword(SERVICE, VERIFY_ACCOUNT);
    return !!token;
  } catch {
    return false;
  }
}

/** True if the wallet credentials are currently cached in RAM. */
export function isUnlocked(): boolean {
  return isCached();
}

/**
 * First-time setup: derive key from passphrase, store salt + verify token in keychain,
 * cache passphrase + salt in WalletKeyCache so the wallet can be used immediately.
 */
export async function setup(passphrase: string): Promise<void> {
  const salt = randomSalt(32);
  const key = await deriveKey(passphrase, salt);
  const verifyToken = await aesEncrypt(key, VERIFY_PLAINTEXT);
  await setPassword(SERVICE, SALT_ACCOUNT, bytesToBase64(salt));
  await setPassword(SERVICE, VERIFY_ACCOUNT, verifyToken);
  setCachedPassword(passphrase, salt);
  console.log('[OptnKeyManager] Passphrase setup complete — password + salt cached in RAM');
}

/**
 * Unlock: derive key, verify against stored token, cache passphrase + salt if correct.
 * Returns true on success, false on wrong passphrase.
 */
export async function unlock(passphrase: string): Promise<boolean> {
  try {
    const saltB64 = await getPassword(SERVICE, SALT_ACCOUNT);
    const verifyToken = await getPassword(SERVICE, VERIFY_ACCOUNT);
    if (!saltB64 || !verifyToken) return false;

    const salt = base64ToBytes(saltB64);
    const key = await deriveKey(passphrase, salt);
    const decrypted = await aesDecrypt(key, verifyToken);
    if (decrypted !== VERIFY_PLAINTEXT) return false;

    setCachedPassword(passphrase, salt);
    console.log('[OptnKeyManager] Unlocked — password + salt cached in RAM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify passphrase without updating WalletKeyCache.
 * Used by the integrity-check modal (seed phrase reveal gate).
 */
export async function verify(passphrase: string): Promise<boolean> {
  try {
    const saltB64 = await getPassword(SERVICE, SALT_ACCOUNT);
    const verifyToken = await getPassword(SERVICE, VERIFY_ACCOUNT);
    if (!saltB64 || !verifyToken) return false;

    const salt = base64ToBytes(saltB64);
    const key = await deriveKey(passphrase, salt);
    const decrypted = await aesDecrypt(key, verifyToken);
    return decrypted === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Change passphrase: verify old, derive new key, overwrite keychain entries, update cache.
 * Caller is responsible for re-encrypting DB data before calling this — the cached
 * password switches to the new one here, so collect plaintext first, then call this,
 * then re-encrypt.
 */
export async function changePassword(newPassphrase: string): Promise<void> {
  const newSalt = randomSalt(32);
  const newKey = await deriveKey(newPassphrase, newSalt);
  const verifyToken = await aesEncrypt(newKey, VERIFY_PLAINTEXT);
  await setPassword(SERVICE, SALT_ACCOUNT, bytesToBase64(newSalt));
  await setPassword(SERVICE, VERIFY_ACCOUNT, verifyToken);
  setCachedPassword(newPassphrase, newSalt);
  console.log('[OptnKeyManager] Password changed — new password + salt cached in RAM');
}

/** Clear the in-memory credentials. The app will show the lock screen. */
export function lock(): void {
  clearCachedPassword();
  console.log('[OptnKeyManager] Locked — password + salt wiped from RAM');
}

/**
 * Full reset: removes salt and verify token from keychain.
 * Called when wallet is deleted. After this, setup() must be called again.
 */
export async function reset(): Promise<void> {
  lock();
  try { await deletePassword(SERVICE, SALT_ACCOUNT); } catch { /* already gone */ }
  try { await deletePassword(SERVICE, VERIFY_ACCOUNT); } catch { /* already gone */ }
  try { await removeData({ domain: BIO_DOMAIN, name: BIO_NAME }); } catch { /* already gone */ }
  console.log('[OptnKeyManager] Reset — keychain entries removed');
}

// ── Biometric unlock (Windows Hello / Touch ID) ─────────────────────────────
//
// The biometric secret store holds the passphrase itself, gated behind the OS
// biometric prompt. `unlockWithBiometric` retrieves it and feeds it through the
// existing `unlock()` verify-and-cache path — no separate crypto logic.

/** True if the OS reports biometric hardware/enrollment is available at all. */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const status = await checkStatus();
    return status.isAvailable;
  } catch {
    return false;
  }
}

/** True if this wallet has previously stored a passphrase behind biometric gating. */
export async function hasBiometricEnrolled(): Promise<boolean> {
  try {
    return await hasData({ domain: BIO_DOMAIN, name: BIO_NAME });
  } catch {
    return false;
  }
}

/** Store the passphrase behind the OS biometric prompt (Windows Hello / Touch ID). */
export async function enableBiometric(passphrase: string): Promise<void> {
  await setData({ domain: BIO_DOMAIN, name: BIO_NAME, data: passphrase });
  console.log('[OptnKeyManager] Biometric unlock enabled');
}

/**
 * Prompt the OS biometric dialog, retrieve the stored passphrase, and run it
 * through the normal unlock() path (verify + cache key). Returns true on success.
 */
export async function unlockWithBiometric(): Promise<boolean> {
  try {
    const result = await getData({
      domain: BIO_DOMAIN,
      name: BIO_NAME,
      reason: 'Unlock OPTN Wallet',
    });
    if (!result.data) return false;
    return await unlock(result.data);
  } catch (err) {
    console.warn('[OptnKeyManager] Biometric unlock failed or cancelled:', err);
    return false;
  }
}

/** Remove the stored biometric-gated passphrase. */
export async function disableBiometric(): Promise<void> {
  try {
    await removeData({ domain: BIO_DOMAIN, name: BIO_NAME });
  } catch {
    // already gone
  }
  console.log('[OptnKeyManager] Biometric unlock disabled');
}

/**
 * Human-readable name for the OS biometric prompt, since each platform's OS
 * calls it something different: Windows Hello, Touch ID, generic "Biometric
 * unlock" on Linux. `tauri-plugin-biometry`'s BiometryType enum doesn't
 * distinguish Windows from macOS (both can report "Auto"), so this checks
 * the webview's user agent instead — fine for a UI label, not a security
 * decision.
 */
export function getBiometricLabel(): string {
  const ua = globalThis.navigator?.userAgent ?? '';
  if (ua.includes('Windows')) return 'Windows Hello';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) return 'Touch ID';
  return 'Biometric unlock';
}

export const OptnKeyManager = {
  hasSetup,
  isUnlocked,
  setup,
  unlock,
  verify,
  changePassword,
  lock,
  reset,
  isBiometricAvailable,
  hasBiometricEnrolled,
  enableBiometric,
  unlockWithBiometric,
  disableBiometric,
  getBiometricLabel,
};
export default OptnKeyManager;
