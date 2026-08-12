// Desktop drop-in for src/services/SecretCryptoService.ts
//
// EC (Electron Cash) model: the AES-256-GCM key is NOT generated or stored by
// this file. It is derived from the user's passphrase by EcKeyManager (PBKDF2,
// 600k iterations) and cached in RAM by WalletKeyCache after DesktopSecurityGate
// unlocks. This file only reads that cached key — it never persists a key of its
// own and never silently unlocks anything.
//
// API surface mirrors src/services/SecretCryptoService.ts exactly (default export
// with encryptText/decryptText/encryptBytes/decryptBytes, named isEncryptedPayload
// and SECRET_ENC_PREFIX) so all callers (KeyManager, DatabaseService, etc.) work
// unchanged. Encoding scheme (12-byte IV prefix, base64, `enc:v1:` marker) is kept
// identical so ciphertext round-trips correctly and matches the upstream on-disk
// format.

import { getCachedWalletKey } from './WalletKeyCache';

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

function requireCachedKey(): CryptoKey {
  const key = getCachedWalletKey();
  if (!key) {
    throw new Error(
      '[SecretCryptoService] No wallet key in memory — the security gate must unlock before any encrypt/decrypt call.'
    );
  }
  return key;
}

export function isEncryptedPayload(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENC_PREFIX);
}

async function encryptRaw(plaintext: string): Promise<string> {
  const key = requireCachedKey();
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
}

async function decryptRaw(ciphertext: string): Promise<string> {
  const key = requireCachedKey();
  const merged = base64ToBytes(ciphertext);
  const iv = merged.slice(0, 12);
  const data = merged.slice(12);
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return textDecoder.decode(plain);
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
};

export default SecretCryptoService;
