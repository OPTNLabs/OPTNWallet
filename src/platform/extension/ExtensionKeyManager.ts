// Browser-extension-only passphrase-derived key manager.
//
// Same PBKDF2(600k)/AES-GCM primitives as the desktop OptnKeyManager, but the
// per-install salt + verify token live in localStorage instead of an OS
// keychain — there is no Tauri keychain bridge inside a browser extension's
// popup page. localStorage here is scoped to the extension's own origin
// (chrome-extension://<id> / moz-extension://<id>), inaccessible to any web
// page or other extension.
//
// Ciphertext model: we cache the passphrase + salt in RAM and re-derive the
// CryptoKey ephemerally on each encrypt/decrypt call. The derived key never
// persists in memory between operations.
//
// No biometric support (out of scope for the extension MVP — WebAuthn would
// be a materially bigger addition, not a drop-in swap like the desktop
// keychain/biometry plugins).
import { setCachedPassword, clearCachedPassword, isCached } from '../desktop/WalletKeyCache';
import { deriveKey, aesEncrypt, aesDecrypt, bytesToBase64, base64ToBytes, randomSalt } from '../desktop/WalletCrypto';

const SALT_KEY = 'optn_ext_salt_v1';
const VERIFY_KEY = 'optn_ext_verify_v1';
const VERIFY_PLAINTEXT = 'optn-wallet-ext-v1-ok';

/** True once a password has been set up for this extension install. */
export function hasSetup(): boolean {
  return !!localStorage.getItem(VERIFY_KEY);
}

/** True if the wallet credentials are currently cached in RAM. */
export function isUnlocked(): boolean {
  return isCached();
}

/** First-time setup: derive key, store salt + verify token, cache credentials in RAM. */
export async function setup(passphrase: string): Promise<void> {
  const salt = randomSalt(32);
  const key = await deriveKey(passphrase, salt);
  const verifyToken = await aesEncrypt(key, VERIFY_PLAINTEXT);
  localStorage.setItem(SALT_KEY, bytesToBase64(salt));
  localStorage.setItem(VERIFY_KEY, verifyToken);
  setCachedPassword(passphrase, salt);
}

/** Unlock: derive key, verify against stored token, cache credentials if correct. */
export async function unlock(passphrase: string): Promise<boolean> {
  const saltB64 = localStorage.getItem(SALT_KEY);
  const verifyToken = localStorage.getItem(VERIFY_KEY);
  if (!saltB64 || !verifyToken) return false;
  try {
    const salt = base64ToBytes(saltB64);
    const key = await deriveKey(passphrase, salt);
    const decrypted = await aesDecrypt(key, verifyToken);
    if (decrypted !== VERIFY_PLAINTEXT) return false;
    setCachedPassword(passphrase, salt);
    return true;
  } catch {
    return false;
  }
}

/** Clear the in-memory credentials. Every popup boot starts locked regardless. */
export function lock(): void {
  clearCachedPassword();
}

const ExtensionKeyManager = { hasSetup, isUnlocked, setup, unlock, lock };
export default ExtensionKeyManager;
