// Shared PBKDF2 + AES-256-GCM primitives used by both:
//   - OptnKeyManager (the app-level gate password)
//   - the per-wallet key derivation in WalletManager.ts (each wallet's own password)
// Factored out so both use identical, single-audited crypto — not two parallel
// implementations that could silently drift apart.

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

if (!subtle) {
  console.error('[WalletCrypto] Web Crypto API (crypto.subtle) is unavailable in this context.');
}

export const PBKDF2_ITERATIONS = 600_000;

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomSalt(length = 32): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** PBKDF2(passphrase, salt, 600_000, SHA-256) -> non-extractable AES-256-GCM key. */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (!subtle) {
    throw new Error('[WalletCrypto] Web Crypto API is unavailable. Run the native Tauri desktop app instead.');
  }
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  if (!subtle) throw new Error('[WalletCrypto] Web Crypto API is unavailable');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const merged = new Uint8Array(12 + cipher.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(cipher), 12);
  return bytesToBase64(merged);
}

export async function aesDecrypt(key: CryptoKey, b64: string): Promise<string> {
  if (!subtle) throw new Error('[WalletCrypto] Web Crypto API is unavailable');
  const merged = base64ToBytes(b64);
  const iv = merged.slice(0, 12);
  const data = merged.slice(12);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return dec.decode(plain);
}
