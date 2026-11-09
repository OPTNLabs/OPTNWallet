import SecretCryptoService from '../SecretCryptoService';
import type { AddonStorageLock } from './AddonStorageLock';

const BIGINT_TAG = '__optn_addon_bigint__';

function serializeRecords(records: unknown[], scope?: string): string {
  const payload = scope ? { version: 1, scope, records } : records;
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return { [BIGINT_TAG]: value.toString() };
    }
    return value;
  });
}

function deserializeRecords<T>(plaintext: string, expectedScope?: string): T[] {
  const parsed: unknown = JSON.parse(plaintext, (_key, value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, BIGINT_TAG)
    ) {
      const encoded = (value as Record<string, unknown>)[BIGINT_TAG];
      if (typeof encoded !== 'string' || !/^-?\d+$/.test(encoded)) {
        throw new Error('Invalid addon storage bigint');
      }
      return BigInt(encoded);
    }
    return value;
  });
  if (expectedScope) {
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 1 ||
      (parsed as Record<string, unknown>).scope !== expectedScope ||
      !Array.isArray((parsed as Record<string, unknown>).records)
    ) {
      throw new Error('Addon storage scope mismatch');
    }
    return (parsed as { records: T[] }).records;
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid addon storage payload');
  return parsed as T[];
}

export type AddonEncryptedValueStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  lock?: AddonStorageLock;
};

export type AddonEncryptedStorageOptions = {
  /** Scope label checked after decryption before records are returned. */
  scope?: string;
};

/**
 * Encrypts host-owned SDK persistence records before they reach the backing
 * store. The backing store and crypto service are never exposed to add-ons.
 */
export function createEncryptedAddonStorage<T>(
  storage: AddonEncryptedValueStorage,
  options: AddonEncryptedStorageOptions = {}
): {
  read(): Promise<T[]>;
  write(records: T[]): Promise<void>;
  lock?: AddonStorageLock;
} {
  return {
    lock: storage.lock,
    async read() {
      const ciphertext = await storage.read();
      if (!ciphertext) return [];
      const plaintext = await SecretCryptoService.decryptText(ciphertext);
      return deserializeRecords<T>(plaintext, options.scope);
    },
    async write(records) {
      const plaintext = serializeRecords(records, options.scope);
      await storage.write(await SecretCryptoService.encryptText(plaintext));
    },
  };
}
