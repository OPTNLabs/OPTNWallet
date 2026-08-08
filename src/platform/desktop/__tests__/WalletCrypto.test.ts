import { describe, expect, it } from 'vitest';
import { deriveKey, aesEncrypt, aesDecrypt, randomSalt } from '../WalletCrypto';

// These primitives back BOTH the app-level gate (OptnKeyManager) and every
// per-wallet password (DesktopWalletManager.createWalletWithPassword /
// openWalletWithPassword) -- the actual cross-wallet isolation property
// ("wallet A's password can't decrypt wallet B's data") is a direct
// consequence of deriveKey(password, salt) producing a distinct,
// non-interchangeable key per (password, salt) pair, which is what this
// test asserts directly rather than standing up the full DB-backed
// multi-wallet flow.
describe('WalletCrypto', () => {
  it('derives the same key for the same password+salt (reproducible unlock)', async () => {
    const salt = randomSalt(32);
    const keyA = await deriveKey('correct horse battery staple', salt);
    const ciphertext = await aesEncrypt(keyA, 'hello wallet');

    const keyAAgain = await deriveKey('correct horse battery staple', salt);
    expect(await aesDecrypt(keyAAgain, ciphertext)).toBe('hello wallet');
  });

  it('two wallets with different passwords (same salt) cannot decrypt each other', async () => {
    const salt = randomSalt(32);
    const keyWalletA = await deriveKey('wallet-a-password', salt);
    const keyWalletB = await deriveKey('wallet-b-password', salt);

    const ciphertextA = await aesEncrypt(keyWalletA, 'wallet A secret mnemonic');

    await expect(aesDecrypt(keyWalletB, ciphertextA)).rejects.toThrow();
  });

  it('two wallets with different salts (same password) still produce different keys', async () => {
    const saltA = randomSalt(32);
    const saltB = randomSalt(32);
    const keyA = await deriveKey('shared-password', saltA);
    const keyB = await deriveKey('shared-password', saltB);

    const ciphertextA = await aesEncrypt(keyA, 'wallet A secret mnemonic');
    await expect(aesDecrypt(keyB, ciphertextA)).rejects.toThrow();
  });

  it('a wrong password fails to decrypt rather than silently returning garbage', async () => {
    const salt = randomSalt(32);
    const correctKey = await deriveKey('the-real-password', salt);
    const wrongKey = await deriveKey('a-guessed-password', salt);
    const ciphertext = await aesEncrypt(correctKey, 'sensitive data');

    await expect(aesDecrypt(wrongKey, ciphertext)).rejects.toThrow();
  });
});
