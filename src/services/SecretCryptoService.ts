import { Capacitor } from '@capacitor/core';
import SecureKeyStore from '../plugins/SecureKeyStore';

export const SECRET_ENC_PREFIX = 'enc:v1:';
const FALLBACK_KEY_STORAGE = 'optn_wallet_fallback_key_v1';

let fallbackCryptoKey: CryptoKey | null = null;

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

async function getFallbackKey(): Promise<CryptoKey> {
  if (fallbackCryptoKey) return fallbackCryptoKey;

  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error('WebCrypto is unavailable');
  }

  let keyMaterialB64 = '';
  try {
    keyMaterialB64 = globalThis.localStorage?.getItem(FALLBACK_KEY_STORAGE) || '';
  } catch {
    keyMaterialB64 = '';
  }

  if (!keyMaterialB64) {
    const random = new Uint8Array(32);
    cryptoObj.getRandomValues(random);
    keyMaterialB64 = bytesToBase64(random);
    try {
      globalThis.localStorage?.setItem(FALLBACK_KEY_STORAGE, keyMaterialB64);
    } catch {
      // ignore storage write failures; key stays in memory for this session
    }
  }

  fallbackCryptoKey = await cryptoObj.subtle.importKey(
    'raw',
    base64ToBytes(keyMaterialB64),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

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
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const { ciphertext } = await SecureKeyStore.encrypt({ plaintext });
      return ciphertext;
    } catch (error) {
      console.warn('SecureKeyStore.encrypt failed, falling back to WebCrypto', error);
    }
  }
  return await encryptWithFallback(plaintext);
}

async function decryptRaw(ciphertext: string): Promise<string> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const { plaintext } = await SecureKeyStore.decrypt({ ciphertext });
      return plaintext;
    } catch (error) {
      console.warn('SecureKeyStore.decrypt failed, falling back to WebCrypto', error);
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
