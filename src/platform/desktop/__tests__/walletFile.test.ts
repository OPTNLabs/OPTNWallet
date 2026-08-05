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
      network: 'chipnet' as const,
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
    expect(parsed.network).toBe('chipnet');
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
    expect(parsed.network).toBeUndefined();
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
    expect(defaultWalletFileName('My/Wallet: Test!')).toBe('My_Wallet_Test_.optn');
  });

  it('names the file after the wallet, with no internal id in it', () => {
    // `wallet-6-wallet_8.optn` read like a window number to the person looking
    // at their own backups. The database row id is ours, not theirs.
    const fileName = defaultWalletFileName('wallet_8');
    expect(fileName).toBe('wallet_8.optn');
    expect(fileName).not.toMatch(/^wallet-\d+-/);
  });
});
