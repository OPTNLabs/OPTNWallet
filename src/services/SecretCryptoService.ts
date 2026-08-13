import SecureKeyStore from '../platform/plugins/SecureKeyStore';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../utils/browserStorage';
import { isAndroidNativePlatform } from '../utils/platform';

export const SECRET_ENC_PREFIX = 'enc:v1:';
/**
 * localStorage key for the WebCrypto fallback AES material.
 *
 * SECURITY (Mythos HIGH): this stores raw key bytes next to IndexedDB ciphertext
 * on web / iOS / Android-when-SecureKeyStore-unavailable. That is *not* real
 * at-rest secrecy against XSS or local profile theft. Desktop + extension builds
 * replace this entire module with a password-derived key (see vite.*.config.ts).
 * Android encrypt now fails closed instead of writing new secrets under this key.
 */
const FALLBACK_KEY_STORAGE = 'optn_wallet_fallback_key_v1';

let fallbackCryptoKey: CryptoKey | null = null;
const FALLBACK_KEY_LOCK = 'optn-secret-fallback-key-v1';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function loadFallbackKey(): Promise<CryptoKey> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error('WebCrypto is unavailable');
  }

  const storage = getLocalStorage();
  let keyMaterialB64 = readStorageItem(storage, FALLBACK_KEY_STORAGE) || '';

  if (!keyMaterialB64) {
    const random = new Uint8Array(32);
    cryptoObj.getRandomValues(random);
    keyMaterialB64 = bytesToBase64(random);
    writeStorageItem(storage, FALLBACK_KEY_STORAGE, keyMaterialB64);
  }

  return await cryptoObj.subtle.importKey(
    'raw',
    base64ToBytes(keyMaterialB64),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getFallbackKey(): Promise<CryptoKey> {
  if (fallbackCryptoKey) return fallbackCryptoKey;

  const lockManager = (
    globalThis.navigator as
      | (Navigator & {
          locks?: {
            request: <T>(
              name: string,
              callback: () => Promise<T>
            ) => Promise<T>;
          };
        })
      | undefined
  )?.locks;
  if (lockManager?.request) {
    return await lockManager.request(FALLBACK_KEY_LOCK, async () => {
      if (!fallbackCryptoKey) {
        // Re-read storage only after this origin-wide lock is held. Otherwise
        // two first-run wallet windows can generate different keys and persist
        // ciphertext that only one of them can decrypt after restart.
        fallbackCryptoKey = await loadFallbackKey();
      }
      return fallbackCryptoKey;
    });
  }

  fallbackCryptoKey = await loadFallbackKey();
  return fallbackCryptoKey;
}

async function encryptWithFallback(plaintext: string): Promise<string> {
  const cryptoObj = globalThis.crypto;
  const key = await getFallbackKey();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const encoded = textEncoder.encode(plaintext);
  const cipher = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const merged = new Uint8Array(iv.length + cipher.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(cipher), iv.length);
  return bytesToBase64(merged);
}

async function decryptWithFallback(ciphertext: string): Promise<string> {
  const cryptoObj = globalThis.crypto;
  const key = await getFallbackKey();
  const merged = base64ToBytes(ciphertext);
  const iv = merged.slice(0, 12);
  const data = merged.slice(12);
  const plain = await cryptoObj.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return textDecoder.decode(plain);
}

async function encryptRaw(plaintext: string): Promise<string> {
  if (isAndroidNativePlatform()) {
    try {
      const { ciphertext } = await SecureKeyStore.encrypt({ plaintext });
      return ciphertext;
    } catch (error) {
      // FAIL CLOSED: never write *new* secrets under the localStorage AES key.
      // That key lives next to the SQLite/IndexedDB ciphertext (Mythos HIGH) —
      // silent fallback permanently downgrades hardware-backed encryption.
      console.error(
        'SecureKeyStore.encrypt failed; refusing insecure localStorage fallback',
        error
      );
      throw error instanceof Error
        ? error
        : new Error('SecureKeyStore.encrypt failed (no localStorage fallback)');
    }
  }
  // Web / iOS without SecureKeyStore: localStorage-backed AES key (known weak
  // at-rest model — key material adjacent to ciphertext). Desktop and extension
  // builds swap this module for a password-derived implementation.
  return await encryptWithFallback(plaintext);
}

async function decryptRaw(ciphertext: string): Promise<string> {
  if (isAndroidNativePlatform()) {
    try {
      const { plaintext } = await SecureKeyStore.decrypt({ ciphertext });
      return plaintext;
    } catch (error) {
      // Android ciphertext must never silently downgrade to a raw key stored
      // beside the wallet database. A failed decrypt is either a wrong/corrupt
      // payload or an explicit key-migration case that must be handled by a
      // versioned migration flow.
      //
      // Surface one actionable message instead of re-throwing the raw plugin
      // error. Two real cases land here — a row written under the localStorage
      // key by a build from before fail-closed encrypt shipped, and a Keystore
      // key the OS invalidated (lock-screen or biometric change, restore to a
      // new device). Neither is recoverable in-app, and the only thing the user
      // can act on is their recovery phrase. An opaque Keystore error does not
      // tell them that. The original is logged above for diagnosis.
      console.error('SecureKeyStore.decrypt failed; refusing fallback', error);
      throw new Error(
        "This wallet's secure storage key is no longer available on this " +
          'device. Restore the wallet from your recovery phrase to continue.'
      );
    }
  }
  return await decryptWithFallback(ciphertext);
}

export function isEncryptedPayload(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENC_PREFIX);
}

async function encryptText(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  if (isEncryptedPayload(plaintext)) return plaintext;
  const ciphertext = await encryptRaw(plaintext);
  return `${SECRET_ENC_PREFIX}${ciphertext}`;
}

async function decryptText(ciphertextOrPlaintext: string): Promise<string> {
  if (!ciphertextOrPlaintext) return '';
  if (!isEncryptedPayload(ciphertextOrPlaintext)) return ciphertextOrPlaintext;
  return await decryptRaw(ciphertextOrPlaintext.slice(SECRET_ENC_PREFIX.length));
}

/**
 * Decrypt a related set of wallet fields through the platform implementation.
 * Desktop replaces this module with a scoped implementation that derives its
 * password key once for the whole batch; other platforms keep their existing
 * secure-storage/fallback key behavior.
 */
async function decryptTextBatch(
  values: readonly string[],
  _ownerWalletId?: number
): Promise<string[]> {
  // Accepted for signature parity with the desktop replacement, which scopes a
  // derived password key per wallet. This implementation has no such key.
  void _ownerWalletId;
  return await Promise.all(values.map((value) => decryptText(value)));
}

async function encryptBytes(data: Uint8Array): Promise<string> {
  const asBase64 = bytesToBase64(data);
  return await encryptText(asBase64);
}

async function decryptBytes(
  ciphertextOrPlaintext: string
): Promise<Uint8Array | null> {
  if (!ciphertextOrPlaintext) return null;
  const maybeBase64 = await decryptText(ciphertextOrPlaintext);
  try {
    return base64ToBytes(maybeBase64);
  } catch {
    return null;
  }
}

const SecretCryptoService = {
  encryptText,
  decryptText,
  decryptTextBatch,
  encryptBytes,
  decryptBytes,
};

export default SecretCryptoService;
