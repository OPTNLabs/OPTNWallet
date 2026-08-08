import { describe, expect, it } from 'vitest';
import {
  serializeWalletFile,
  parseWalletFile,
  defaultWalletFileName,
  collisionWalletFileName,
  supportsWalletFileV1Type,
} from '../walletFile';

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
      parseWalletFile(
        JSON.stringify({ format: 'optn-wallet', version: 1, name: 'X' })
      )
    ).toThrow(/missing required fields/);
  });

  it('limits v1 wallet packs to seed-backed wallet types', () => {
    expect(supportsWalletFileV1Type('standard')).toBe(true);
    expect(supportsWalletFileV1Type('quantumroot')).toBe(true);
    expect(supportsWalletFileV1Type('hardware')).toBe(false);
    expect(supportsWalletFileV1Type('watch-only')).toBe(false);
  });

  it('sanitizes the wallet name into a safe filename', () => {
    expect(defaultWalletFileName('My/Wallet: Test!')).toBe(
      'My_Wallet_Test_.optn'
    );
  });

  it('names the file after the wallet, with no internal id in it', () => {
    // `wallet-6-wallet_8.optn` read like a window number to the person looking
    // at their own backups. The database row id is ours, not theirs.
    const fileName = defaultWalletFileName('wallet_8');
    expect(fileName).toBe('wallet_8.optn');
    expect(fileName).not.toMatch(/^wallet-\d+-/);
  });

  it('keeps _id<N> when the wallet name is already 40 safe characters', () => {
    // CodeRabbit: concatenating "_id7" then slicing the whole stem to 40 drops
    // the suffix and collapses two wallets onto the same filename.
    const longName = 'A'.repeat(40);
    expect(longName.length).toBe(40);

    const naive = defaultWalletFileName(`${longName}_id7`);
    const fixedA = collisionWalletFileName(longName, '_id7');
    const fixedB = collisionWalletFileName(longName, '_id9');

    expect(naive).toBe(`${'A'.repeat(40)}.optn`); // suffix lost (old bug)
    expect(fixedA).toMatch(/_id7\.optn$/);
    expect(fixedB).toMatch(/_id9\.optn$/);
    expect(fixedA).not.toBe(fixedB);
    expect(fixedA).not.toBe(defaultWalletFileName(longName));
    // Stem (before .optn) stays within the 40-char budget.
    expect(fixedA.replace(/\.optn$/, '').length).toBeLessThanOrEqual(40);
  });

  it('keeps distinct collision paths for two positive sourceIds on a long name', () => {
    const longName = 'B'.repeat(40);
    const a = collisionWalletFileName(longName, '_id12');
    const b = collisionWalletFileName(longName, '_id34');
    expect(a).toContain('_id12');
    expect(b).toContain('_id34');
    expect(a).not.toBe(b);
  });
});
