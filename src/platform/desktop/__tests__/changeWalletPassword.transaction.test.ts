import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureDatabaseStarted, getDatabase, flushDatabaseToFile } = vi.hoisted(
  () => ({
    ensureDatabaseStarted: vi.fn(async () => {}),
    getDatabase: vi.fn(),
    flushDatabaseToFile: vi.fn(async () => {}),
  })
);

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted,
    getDatabase,
    flushDatabaseToFile,
  }),
}));

vi.mock('../walletFile', () => ({
  autoSaveWalletFile: vi.fn(async () => {}),
  parseWalletFile: vi.fn(),
}));

import { changeWalletPassword } from '../DesktopWalletManager';
import {
  aesEncrypt,
  bytesToBase64,
  deriveKey,
  randomSalt,
} from '../WalletCrypto';
import { SECRET_ENC_PREFIX } from '../SecretCryptoService';

function statement(
  row: Record<string, unknown> | null,
  run?: (params: unknown[]) => void
) {
  let read = false;
  return {
    bind: vi.fn(),
    step: vi.fn(() => {
      if (read || !row) return false;
      read = true;
      return true;
    }),
    getAsObject: vi.fn(() => row ?? {}),
    run: vi.fn((params: unknown[]) => run?.(params)),
    free: vi.fn(),
  };
}

describe('changeWalletPassword database transaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back the wallet re-key when a private-key update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const oldPassword = 'old password with enough length';
    const newPassword = 'new password with enough length';
    const salt = randomSalt(32);
    const oldKey = await deriveKey(oldPassword, salt);
    const encryptedMnemonic = `${SECRET_ENC_PREFIX}${await aesEncrypt(
      oldKey,
      'test mnemonic'
    )}`;
    const encryptedPrivateKey = `${SECRET_ENC_PREFIX}${await aesEncrypt(
      oldKey,
      'AQID'
    )}`;
    const saltQuery = statement({ kdf_salt: bytesToBase64(salt) });
    const walletQuery = statement({
      wallet_name: 'Test wallet',
      walletType: 'standard',
      mnemonic: encryptedMnemonic,
      passphrase: '',
    });
    const keysQuery = statement({ id: 3, private_key: encryptedPrivateKey });
    const walletUpdate = statement(null);
    const keyUpdate = statement(null, () => {
      throw new Error('simulated key update failure');
    });
    const exec = vi.fn();
    const db = {
      exec,
      prepare: vi.fn((sql: string) => {
        if (sql === 'SELECT kdf_salt FROM wallets WHERE id = ?') {
          return saltQuery;
        }
        if (sql.includes('FROM wallets WHERE id = ?')) return walletQuery;
        if (sql.includes('SELECT id, private_key FROM keys')) return keysQuery;
        if (sql.startsWith('UPDATE wallets SET mnemonic')) return walletUpdate;
        if (sql.startsWith('UPDATE keys SET private_key')) return keyUpdate;
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    getDatabase.mockReturnValue(db);

    await expect(
      changeWalletPassword(7, oldPassword, newPassword)
    ).resolves.toBe(false);

    expect(exec).toHaveBeenNthCalledWith(1, 'BEGIN TRANSACTION');
    expect(exec).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(flushDatabaseToFile).not.toHaveBeenCalled();
  });
});
