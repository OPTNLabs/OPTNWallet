import { describe, expect, it } from 'vitest';
import {
  companionColdPath,
  isOptnColdPath,
  isOptnKeystorePath,
  splitWalletPackPaths,
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
});
