import { describe, expect, it } from 'vitest';
import { serializeWalletFile, parseWalletFile, defaultWalletFileName } from '../walletFile';

describe('walletFile serialize/parse round-trip', () => {
  it('round-trips all fields exactly', () => {
    const original = {
      sourceId: 3,
      name: 'My Wallet',
      walletType: 'standard',
      encryptedMnemonic: 'enc:v1:abc123',
      encryptedPassphrase: 'enc:v1:def456',
      kdfSalt: 'c29tZS1zYWx0LWJhc2U2NA==',
    };
    const text = serializeWalletFile(original);
    const parsed = parseWalletFile(text);

    expect(parsed.format).toBe('optn-wallet');
    expect(parsed.version).toBe(1);
    expect(parsed.sourceId).toBe(original.sourceId);
    expect(parsed.name).toBe(original.name);
    expect(parsed.walletType).toBe(original.walletType);
    expect(parsed.encryptedMnemonic).toBe(original.encryptedMnemonic);
    expect(parsed.encryptedPassphrase).toBe(original.encryptedPassphrase);
    expect(parsed.kdfSalt).toBe(original.kdfSalt);
  });

  it('defaults an empty encryptedPassphrase and missing sourceId/walletType on import', () => {
    const parsed = parseWalletFile(
      JSON.stringify({
        format: 'optn-wallet',
        version: 1,
        name: 'Legacy',
        encryptedMnemonic: 'enc:v1:xyz',
        kdfSalt: 'c2FsdA==',
      })
    );
    expect(parsed.encryptedPassphrase).toBe('');
    expect(parsed.sourceId).toBe(0);
    expect(parsed.walletType).toBe('standard');
  });

  it('rejects a file with the wrong format/version marker', () => {
    expect(() =>
      parseWalletFile(JSON.stringify({ format: 'not-optn', version: 1 }))
    ).toThrow(/Not a valid OPTN wallet file/);
    expect(() =>
      parseWalletFile(JSON.stringify({ format: 'optn-wallet', version: 2 }))
    ).toThrow(/Not a valid OPTN wallet file/);
  });

  it('rejects a file missing required fields', () => {
    expect(() =>
      parseWalletFile(JSON.stringify({ format: 'optn-wallet', version: 1, name: 'X' }))
    ).toThrow(/missing required fields/);
  });

  it('sanitizes the wallet name into a safe filename', () => {
    expect(defaultWalletFileName(1, 'My/Wallet: Test!')).toBe('wallet-1-My_Wallet_Test_.optn');
  });
});
