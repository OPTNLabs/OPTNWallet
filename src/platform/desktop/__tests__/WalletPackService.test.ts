import { describe, expect, it } from 'vitest';
import {
  companionColdPath,
  isOptnColdPath,
  isOptnKeystorePath,
  splitWalletPackPaths,
  walletNameFromOptnPath,
  withWalletFileName,
} from '../WalletPackService';

describe('WalletPackService paths', () => {
  it('classifies keystore vs cold paths', () => {
    expect(isOptnKeystorePath('C:\\w\\My.optn')).toBe(true);
    expect(isOptnColdPath('C:\\w\\My.optn')).toBe(false);
    expect(isOptnColdPath('C:\\w\\My.optn-cold')).toBe(true);
    expect(isOptnKeystorePath('C:\\w\\My.optn-cold')).toBe(false);
  });

  it('builds companion path next to keystore', () => {
    expect(companionColdPath('D:/backups/Vault.optn')).toBe(
      'D:/backups/Vault.optn-cold'
    );
  });

  it('splits multi-select into keystore + cold', () => {
    const { keystorePath, coldPath } = splitWalletPackPaths([
      'a.optn-cold',
      'a.optn',
      'noise.txt',
    ]);
    expect(keystorePath).toBe('a.optn');
    expect(coldPath).toBe('a.optn-cold');
  });

  it('takes the Save-as stem as the wallet display name', () => {
    expect(walletNameFromOptnPath('C:\\backups\\wallet7 for testing.optn')).toBe(
      'wallet7 for testing'
    );
    expect(walletNameFromOptnPath('x.optn-cold')).toBeNull();
  });

  it('rewrites only the name field inside .optn JSON', () => {
    const raw = JSON.stringify(
      {
        format: 'optn-wallet',
        version: 1,
        sourceId: 5,
        name: 'wallet7',
        encryptedMnemonic: 'enc:v1:x',
        kdfSalt: 's',
      },
      null,
      2
    );
    const next = JSON.parse(withWalletFileName(raw, 'wallet7 for testing'));
    expect(next.name).toBe('wallet7 for testing');
    expect(next.sourceId).toBe(5);
    expect(next.encryptedMnemonic).toBe('enc:v1:x');
  });
});
