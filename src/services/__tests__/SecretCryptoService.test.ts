import { afterEach, describe, expect, it, vi } from 'vitest';

describe('SecretCryptoService desktop fallback key', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('uses an origin-wide lock before first-run key creation', async () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    };
    const request = vi.fn(
      async <T>(_name: string, callback: () => Promise<T>): Promise<T> =>
        await callback()
    );
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('navigator', { locks: { request } });

    const { default: SecretCryptoService } =
      await import('../SecretCryptoService');
    const [first, second] = await Promise.all([
      SecretCryptoService.encryptText('first secret'),
      SecretCryptoService.encryptText('second secret'),
    ]);

    expect(request).toHaveBeenCalledWith(
      'optn-secret-fallback-key-v1',
      expect.any(Function)
    );
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    expect(await SecretCryptoService.decryptText(first)).toBe('first secret');
    expect(await SecretCryptoService.decryptText(second)).toBe('second secret');
  });
});
