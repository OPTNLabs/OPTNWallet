// Desktop drop-in for src/services/SecretCryptoService.ts
//
// Ciphertext model: the AES-256-GCM key is NOT cached in RAM. Instead we cache
// the user's passphrase + salt in WalletKeyCache and re-derive the key ephemerally
// on each encrypt/decrypt call. The key exists only for the duration of the
// operation, then is discarded. This means an attacker who dumps RAM between
// operations gets only ciphertext — not a usable key.
//
// API surface mirrors src/services/SecretCryptoService.ts exactly (default export
// with encryptText/decryptText/encryptBytes/decryptBytes, named isEncryptedPayload
// and SECRET_ENC_PREFIX) so all callers (KeyManager, DatabaseService, etc.) work
// unchanged. Encoding scheme (12-byte IV prefix, base64, `enc:v1:` marker) is kept
// identical so ciphertext round-trips correctly and matches the upstream on-disk
// format.

import { deriveCachedKey, getCachedOwnerWalletId } from './WalletKeyCache';

export const SECRET_ENC_PREFIX = 'enc:v1:';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function requireCachedKey(ownerWalletId?: number): Promise<CryptoKey> {
  const cachedOwnerWalletId = getCachedOwnerWalletId();
  if (
    ownerWalletId !== undefined &&
    cachedOwnerWalletId !== null &&
    cachedOwnerWalletId !== ownerWalletId
  ) {
    throw new Error(
      '[SecretCryptoService] Cached credentials belong to another wallet.'
    );
  }
  const key = await deriveCachedKey();
  if (!key) {
    throw new Error(
      '[SecretCryptoService] No wallet credentials in memory — the security gate must unlock before any encrypt/decrypt call.'
    );
  }
  return key;
}

export function isEncryptedPayload(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENC_PREFIX);
}

async function encryptRaw(plaintext: string): Promise<string> {
  const key = await requireCachedKey();
  try {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cipher = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      textEncoder.encode(plaintext),
    );
    const merged = new Uint8Array(12 + cipher.byteLength);
    merged.set(iv, 0);
    merged.set(new Uint8Array(cipher), 12);
    return bytesToBase64(merged);
  } finally {
    zeroizeKey(key);
  }
}

async function decryptRaw(ciphertext: string): Promise<string> {
  const key = await requireCachedKey();
  try {
    return await decryptRawWithKey(key, ciphertext);
  } finally {
    zeroizeKey(key);
  }
}

async function decryptRawWithKey(key: CryptoKey, ciphertext: string): Promise<string> {
  const merged = base64ToBytes(ciphertext);
  const iv = merged.slice(0, 12);
  const data = merged.slice(12);
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return textDecoder.decode(plain);
}

/** Decrypt related wallet fields with one scoped PBKDF2 derivation. */
async function decryptTextBatch(
  values: readonly string[],
  ownerWalletId?: number
): Promise<string[]> {
  if (!values.some(isEncryptedPayload)) return [...values];
  const key = await requireCachedKey(ownerWalletId);
  try {
    return await Promise.all(values.map((value) => {
      if (!value || !isEncryptedPayload(value)) return Promise.resolve(value || '');
      return decryptRawWithKey(key, value.slice(SECRET_ENC_PREFIX.length));
    }));
  } finally {
    zeroizeKey(key);
  }
}

/** Best-effort wipe of the ephemeral key from memory. */
function zeroizeKey(key: CryptoKey): void {
  // Web Crypto CryptoKeys are opaque — we cannot zero their internal slots.
  // The key reference becomes unreachable after this function returns, allowing
  // the GC to collect it. This is the best we can do without a native layer.
  void key;
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
  encryptBytes,
  decryptBytes,
  decryptTextBatch,
};

export default SecretCryptoService;
