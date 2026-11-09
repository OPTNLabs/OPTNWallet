import { describe, expect, it, vi } from 'vitest';
import { createEncryptedAddonStorage } from '../EncryptedAddonStorage';

const { encryptText, decryptText } = vi.hoisted(() => ({
  encryptText: vi.fn(async (value: string) => `enc:${value}`),
  decryptText: vi.fn(async (value: string) => value.slice(4)),
}));

vi.mock('../../SecretCryptoService', () => ({
  default: { encryptText, decryptText },
}));

describe('EncryptedAddonStorage', () => {
  it('encrypts writes and decrypts reads', async () => {
    let value: string | null = null;
    const storage = createEncryptedAddonStorage<{ id: string }>({
      async read() {
        return value;
      },
      async write(next) {
        value = next;
      },
    });
    await storage.write([{ id: 'proposal-1' }]);
    expect(value).toBe('enc:[{"id":"proposal-1"}]');
    expect(await storage.read()).toEqual([{ id: 'proposal-1' }]);
  });

  it('round-trips bigint amounts without changing their type', async () => {
    let value: string | null = null;
    const storage = createEncryptedAddonStorage<{
      amount: bigint;
      nested: { amount: bigint };
    }>({
      async read() {
        return value;
      },
      async write(next) {
        value = next;
      },
    });
    await storage.write([{ amount: 7n, nested: { amount: 11n } }]);
    expect(await storage.read()).toEqual([
      { amount: 7n, nested: { amount: 11n } },
    ]);
  });

  it('rejects encrypted records copied from another scope', async () => {
    let value: string | null = null;
    const storage = createEncryptedAddonStorage<{ id: string }>(
      {
        async read() {
          return value;
        },
        async write(next) {
          value = next;
        },
      },
      { scope: 'wallet-1:addon-a:chipnet' }
    );
    await storage.write([{ id: 'proposal-1' }]);
    const otherScope = createEncryptedAddonStorage<{ id: string }>(
      {
        async read() {
          return value;
        },
        async write(next) {
          value = next;
        },
      },
      { scope: 'wallet-1:addon-b:chipnet' }
    );
    await expect(otherScope.read()).rejects.toThrow(/scope mismatch/i);
  });

  it('rejects malformed decrypted payloads', async () => {
    const storage = createEncryptedAddonStorage({
      async read() {
        return 'enc:{"not":"an array"}';
      },
      async write() {},
    });
    await expect(storage.read()).rejects.toThrow(
      /invalid addon storage payload/i
    );
  });
});
