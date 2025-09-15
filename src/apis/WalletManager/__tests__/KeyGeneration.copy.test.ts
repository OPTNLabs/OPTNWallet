import { describe, it, expect } from 'vitest';
import KeyGeneration from '../KeyGeneration copy';
import { Network } from '../../../redux/networkSlice';
import {
  decodeCashAddress,
  decodeCashAddressNonStandard,
  decodeCashAddressFormat,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Decode any CashAddr variant to its payload.
 * Tries strict standard → non-standard → general format.
 */
function decodeToPayload(addr: string): Uint8Array {
  const strict = decodeCashAddress(addr);
  if (typeof strict !== 'string') return strict.payload;

  const nonStd = decodeCashAddressNonStandard(addr);
  if (typeof nonStd !== 'string') return nonStd.payload;

  const fmt = decodeCashAddressFormat(addr);
  if (typeof fmt !== 'string') return fmt.payload;

  throw new Error(`Failed to decode CashAddr: ${strict} | ${nonStd} | ${fmt}`);
}

// Helper to pick a non-mainnet enum value without assuming exact name (CHIPNET/TESTNET)
function getNonMainnetNetwork(): Network {
  if ((Network as any).CHIPNET !== undefined) return (Network as any).CHIPNET;
  if ((Network as any).TESTNET !== undefined) return (Network as any).TESTNET;
  const keys = Object.keys(Network).filter((k) => k !== 'MAINNET');
  if (keys.length > 0) return (Network as any)[keys[0]];
  return 999 as unknown as Network;
}

describe('KeyGeneration', () => {
  it('generateMnemonic returns a valid-looking BIP39 phrase', async () => {
    const KG = KeyGeneration();
    const mnemonic = await KG.generateMnemonic();

    expect(typeof mnemonic).toBe('string');

    const words = mnemonic.trim().split(/\s+/);
    // BIP39 mnemonics have length divisible by 3 (12/15/18/21/24)
    expect(words.length % 3).toBe(0);
    expect(words.length).toBeGreaterThanOrEqual(12);
  });

  it('generateKeys is deterministic for same inputs (mainnet)', async () => {
    const KG = KeyGeneration();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const passphrase = '';
    const params: [Network, string, string, number, number, number] = [
      Network.MAINNET,
      mnemonic,
      passphrase,
      0, // account
      0, // change
      0, // address index
    ];

    const a = await KG.generateKeys(...params);
    const b = await KG.generateKeys(...params);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Addresses should be equal
    expect(a!.aliceAddress).toBe(b!.aliceAddress);
    expect(a!.aliceTokenAddress).toBe(b!.aliceTokenAddress);

    // Priv/pub/PKH bytes should be equal
    expect(equalBytes(a!.alicePriv, b!.alicePriv)).toBe(true);
    expect(typeof a!.alicePub).toBe('object'); // Uint8Array path
    expect(typeof b!.alicePub).toBe('object');
    expect(
      equalBytes(a!.alicePub as Uint8Array, b!.alicePub as Uint8Array)
    ).toBe(true);
    expect(equalBytes(a!.alicePkh, b!.alicePkh)).toBe(true);
  });

  it('mainnet vs non-mainnet prefixes are correct', async () => {
    const KG = KeyGeneration();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const passphrase = '';

    const main = await KG.generateKeys(
      Network.MAINNET,
      mnemonic,
      passphrase,
      0,
      0,
      0
    );
    const nonMain = await KG.generateKeys(
      getNonMainnetNetwork(),
      mnemonic,
      passphrase,
      0,
      0,
      0
    );

    expect(main).not.toBeNull();
    expect(nonMain).not.toBeNull();

    // CashAddr prefixes
    expect(main!.aliceAddress.startsWith('bitcoincash:')).toBe(true);
    expect(nonMain!.aliceAddress.startsWith('bchtest:')).toBe(true);

    // Token vs non-token addresses should differ textually…
    expect(main!.aliceTokenAddress).not.toBe(main!.aliceAddress);

    // …but share the same payload (same pubkey hash)
    const payloadStd = decodeToPayload(main!.aliceAddress);
    const payloadToken = decodeToPayload(main!.aliceTokenAddress);
    expect(equalBytes(payloadStd, payloadToken)).toBe(true);
  });

  it('alicePkh matches hash160(alicePub)', async () => {
    const KG = KeyGeneration();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    const out = await KG.generateKeys(Network.MAINNET, mnemonic, '', 0, 0, 0);
    expect(out).not.toBeNull();
    expect(typeof out!.alicePub).toBe('object');

    const pkh = hash160(out!.alicePub as Uint8Array);
    expect(equalBytes(pkh, out!.alicePkh)).toBe(true);
  });

  it('different address_index yields different addresses', async () => {
    const KG = KeyGeneration();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    const a0 = await KG.generateKeys(Network.MAINNET, mnemonic, '', 0, 0, 0);
    const a1 = await KG.generateKeys(Network.MAINNET, mnemonic, '', 0, 0, 1);

    expect(a0).not.toBeNull();
    expect(a1).not.toBeNull();
    expect(a0!.aliceAddress).not.toBe(a1!.aliceAddress);
    expect(a0!.aliceTokenAddress).not.toBe(a1!.aliceTokenAddress);
  });

  it('different passphrase changes derived keys/addresses', async () => {
    const KG = KeyGeneration();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    const p0 = await KG.generateKeys(Network.MAINNET, mnemonic, '', 0, 0, 0);
    const p1 = await KG.generateKeys(
      Network.MAINNET,
      mnemonic,
      'TREZOR',
      0,
      0,
      0
    );

    expect(p0).not.toBeNull();
    expect(p1).not.toBeNull();
    expect(p0!.aliceAddress).not.toBe(p1!.aliceAddress);
    expect(p0!.aliceTokenAddress).not.toBe(p1!.aliceTokenAddress);
    expect(equalBytes(p0!.alicePkh, p1!.alicePkh)).toBe(false);
  });
});
