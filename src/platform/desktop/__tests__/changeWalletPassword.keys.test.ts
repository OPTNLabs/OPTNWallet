import { describe, expect, it } from 'vitest';
import { deriveKey, aesEncrypt, aesDecrypt, randomSalt } from '../WalletCrypto';
import { SECRET_ENC_PREFIX } from '../SecretCryptoService';
import { reencryptKeyPrivateKeyCell } from '../DesktopWalletManager';

/**
 * keys.private_key is stored as SecretCryptoService.encryptBytes:
 *   enc:v1: + AES-GCM(base64(rawPrivKeyBytes))
 * Password change must re-wrap that cell under the new password-derived key.
 */
describe('reencryptKeyPrivateKeyCell (password change spend-key re-wrap)', () => {
  it('re-wraps enc:v1 private_key so only the new key can decrypt', async () => {
    const saltOld = randomSalt(32);
    const saltNew = randomSalt(32);
    const oldKey = await deriveKey('old-password', saltOld);
    const newKey = await deriveKey('new-password', saltNew);

    // Simulate encryptBytes: plaintext is base64 of raw privkey bytes.
    const rawPriv = new Uint8Array([0x01, 0x02, 0x03, 0xab, 0xcd]);
    let b64 = '';
    for (const b of rawPriv) b64 += String.fromCharCode(b);
    const privAsBase64 = btoa(b64);
    const stored = `${SECRET_ENC_PREFIX}${await aesEncrypt(oldKey, privAsBase64)}`;

    const rewrapped = await reencryptKeyPrivateKeyCell(stored, oldKey, newKey);
    expect(rewrapped).not.toBeNull();
    expect(rewrapped!.startsWith(SECRET_ENC_PREFIX)).toBe(true);

    // Old key must not open the new ciphertext.
    await expect(
      aesDecrypt(oldKey, rewrapped!.slice(SECRET_ENC_PREFIX.length))
    ).rejects.toThrow();

    // New key recovers the same base64 payload KeyManager would decryptBytes.
    const plain = await aesDecrypt(
      newKey,
      rewrapped!.slice(SECRET_ENC_PREFIX.length)
    );
    expect(plain).toBe(privAsBase64);
  });

  it('leaves legacy non-encrypted cells alone (null = no UPDATE)', async () => {
    const salt = randomSalt(32);
    const oldKey = await deriveKey('a', salt);
    const newKey = await deriveKey('b', salt);
    expect(await reencryptKeyPrivateKeyCell('', oldKey, newKey)).toBeNull();
    expect(await reencryptKeyPrivateKeyCell(null, oldKey, newKey)).toBeNull();
    // Plain base64 blob (pre-migration) is not password-bound.
    expect(
      await reencryptKeyPrivateKeyCell('AQID', oldKey, newKey)
    ).toBeNull();
  });

  it('throws when enc:v1 cannot be opened with oldKey (refuse partial re-key)', async () => {
    const salt = randomSalt(32);
    const realKey = await deriveKey('real', salt);
    const wrongKey = await deriveKey('wrong', salt);
    const newKey = await deriveKey('new', salt);
    const stored = `${SECRET_ENC_PREFIX}${await aesEncrypt(realKey, 'cGF5bG9hZA==')}`;

    await expect(
      reencryptKeyPrivateKeyCell(stored, wrongKey, newKey)
    ).rejects.toThrow();
  });
});
