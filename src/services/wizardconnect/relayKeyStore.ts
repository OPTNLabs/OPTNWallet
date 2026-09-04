import { validateSecp256k1PrivateKey } from '@bitauth/libauth';

import SecretCryptoService from '../SecretCryptoService';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../../utils/browserStorage';
import { sha256 } from '../../utils/hash';

const STORAGE_PREFIX = 'optn-wizardconnect-relay-v1-';

const memory = new Map<string, Uint8Array>();
let persistQueue: Promise<void> = Promise.resolve();

function storageKeyForWallet(walletId: number): string {
  return `${STORAGE_PREFIX}${walletId}`;
}

function memoryKey(walletId: number, pairingId: string): string {
  return `${walletId}:${pairingId}`;
}

function canonicalizePairingUri(uri: string): string {
  const trimmed = uri.trim();
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  return decoded.toLowerCase();
}

export function pairingIdForUri(uri: string): string {
  return sha256.text(canonicalizePairingUri(uri));
}

export function generateRuntimeRelayKey(): Uint8Array {
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    if (validateSecp256k1PrivateKey(candidate)) {
      return candidate;
    }
  }
  throw new Error('Failed to generate WizardConnect relay private key');
}

function readStoredCiphertexts(walletId: number): Record<string, string> {
  const raw = readStorageItem(getLocalStorage(), storageKeyForWallet(walletId));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const entries: Record<string, string> = {};
    for (const [pairingId, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) {
        entries[pairingId] = value;
      }
    }
    return entries;
  } catch {
    return {};
  }
}

function writeStoredCiphertexts(
  walletId: number,
  entries: Record<string, string>
): void {
  writeStorageItem(
    getLocalStorage(),
    storageKeyForWallet(walletId),
    JSON.stringify(entries)
  );
}

async function persistRelayKey(
  walletId: number,
  pairingId: string,
  key: Uint8Array
): Promise<void> {
  const ciphertext = await SecretCryptoService.encryptBytes(key);
  const entries = readStoredCiphertexts(walletId);
  entries[pairingId] = ciphertext;
  writeStoredCiphertexts(walletId, entries);
}

function enqueuePersist(
  walletId: number,
  pairingId: string,
  key: Uint8Array
): Promise<void> {
  persistQueue = persistQueue
    .then(() => persistRelayKey(walletId, pairingId, key))
    .catch(() => undefined);
  return persistQueue;
}

export async function hydrateRelayKeys(walletId: number): Promise<void> {
  const entries = readStoredCiphertexts(walletId);
  for (const [pairingId, ciphertext] of Object.entries(entries)) {
    const mk = memoryKey(walletId, pairingId);
    if (memory.has(mk)) continue;
    const decrypted = await SecretCryptoService.decryptBytes(ciphertext);
    if (!decrypted || decrypted.length !== 32) continue;
    if (!validateSecp256k1PrivateKey(decrypted)) continue;
    memory.set(mk, decrypted);
  }
}

export function getOrCreateRuntimeRelayKey(
  walletId: number,
  uri: string
): Uint8Array {
  const pairingId = pairingIdForUri(uri);
  const mk = memoryKey(walletId, pairingId);
  const existing = memory.get(mk);
  if (existing) return existing;

  const generated = generateRuntimeRelayKey();
  memory.set(mk, generated);
  void enqueuePersist(walletId, pairingId, generated);
  return generated;
}

export async function getOrCreatePersistedRelayKey(
  walletId: number,
  uri: string
): Promise<Uint8Array> {
  await hydrateRelayKeys(walletId);
  const pairingId = pairingIdForUri(uri);
  const key = getOrCreateRuntimeRelayKey(walletId, uri);
  await enqueuePersist(walletId, pairingId, key);
  return key;
}
