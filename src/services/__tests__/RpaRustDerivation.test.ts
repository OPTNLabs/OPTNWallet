import { describe, expect, it, vi } from 'vitest';

vi.mock('../HdWalletService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HdWalletService')>();
  return {
    ...actual,
    derivePrivateKeyAtPath: vi.fn(() => {
      throw new Error('TypeScript private-key derivation must not run for RPA');
    }),
  };
});

import { Network } from '../../state/slices/networkSlice';
import { deriveRpaKeys, encodePaycode } from '../RpaService';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('RPA Rust key derivation boundary', () => {
  it('derives complete RPA key material without the TypeScript HD implementation', async () => {
    const keys = await deriveRpaKeys(MNEMONIC, 'TREZOR', Network.CHIPNET);

    expect(keys.scanPrivkey).toHaveLength(32);
    expect(keys.scanPubkey).toHaveLength(33);
    expect(keys.spendPrivkey).toHaveLength(32);
    expect(keys.spendPubkey).toHaveLength(33);
    expect(
      encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.CHIPNET)
    ).toMatch(/^cashcodetest:/);
  });
});
