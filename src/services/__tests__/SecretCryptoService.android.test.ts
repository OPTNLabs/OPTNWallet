import { afterEach, describe, expect, it, vi } from 'vitest';

const { decryptMock, getPlatformMock, isNativePlatformMock } = vi.hoisted(
  () => ({
    decryptMock: vi.fn(),
    getPlatformMock: vi.fn(),
    isNativePlatformMock: vi.fn(),
  })
);

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: getPlatformMock,
    isNativePlatform: isNativePlatformMock,
  },
}));

vi.mock('../../platform/plugins/SecureKeyStore', () => ({
  default: {
    decrypt: decryptMock,
    encrypt: vi.fn(),
  },
}));

describe('SecretCryptoService Android storage boundary', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('fails closed instead of falling back after secure decrypt failure', async () => {
    const nativeFailure = new Error('Android keystore key was invalidated');
    isNativePlatformMock.mockReturnValue(true);
    getPlatformMock.mockReturnValue('android');
    decryptMock.mockRejectedValue(nativeFailure);

    const { default: SecretCryptoService } = await import(
      '../SecretCryptoService'
    );

    await expect(
      SecretCryptoService.decryptText('enc:v1:legacy-ciphertext')
    ).rejects.toBe(nativeFailure);
    expect(decryptMock).toHaveBeenCalledWith({
      ciphertext: 'legacy-ciphertext',
    });
  });
});
