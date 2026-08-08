import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deriveKey } = vi.hoisted(() => ({ deriveKey: vi.fn() }));
vi.mock('../WalletCrypto', () => ({ deriveKey }));

import SecretCryptoService, { SECRET_ENC_PREFIX } from '../SecretCryptoService';
import { clearCachedPassword, setCachedPassword } from '../WalletKeyCache';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function encrypted(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(text)
    )
  );
  return SECRET_ENC_PREFIX + b64(Uint8Array.from([...iv, ...cipher]));
}

describe('SecretCryptoService.decryptTextBatch', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => clearCachedPassword());

  it('derives one non-extractable key from the bound password and salt', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(7),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    );
    const salt = new Uint8Array([1, 2, 3, 4]);
    setCachedPassword('wallet-password', salt, 42);
    deriveKey.mockResolvedValue(key);

    const values = await SecretCryptoService.decryptTextBatch(
      [await encrypted(key, 'mnemonic'), await encrypted(key, 'passphrase')],
      42
    );

    expect(values).toEqual(['mnemonic', 'passphrase']);
    expect(deriveKey).toHaveBeenCalledOnce();
    expect(deriveKey).toHaveBeenCalledWith('wallet-password', salt);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('rejects a batch scoped to another wallet before deriving', async () => {
    setCachedPassword('wallet-password', new Uint8Array([1, 2]), 42);

    await expect(
      SecretCryptoService.decryptTextBatch([`${SECRET_ENC_PREFIX}payload`], 43)
    ).rejects.toThrow('another wallet');
    expect(deriveKey).not.toHaveBeenCalled();
  });

  it('fails authentication when the password-derived key is wrong', async () => {
    const walletA = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(1),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt']
    );
    const walletB = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(2),
      'AES-GCM',
      false,
      ['decrypt']
    );
    setCachedPassword('wrong-password', new Uint8Array([9, 9]), 42);
    deriveKey.mockResolvedValue(walletB);

    await expect(
      SecretCryptoService.decryptTextBatch([await encrypted(walletA, 'seed')], 42)
    ).rejects.toThrow();
    expect(deriveKey).toHaveBeenCalledOnce();
  });
});
