import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../redux/networkSlice';
import KeyGeneration from '../KeyGeneration';

vi.mock('bip39', () => ({
  default: {
    generateMnemonic: vi.fn(),
    mnemonicToSeed: vi.fn(),
  },
  generateMnemonic: vi.fn(),
  mnemonicToSeed: vi.fn(),
}));

vi.mock('../../../services/HdWalletService', () => ({
  deriveBchKeyMaterial: vi.fn(),
}));

import * as bip39 from 'bip39';
import { deriveBchKeyMaterial } from '../../../services/HdWalletService';

describe('KeyGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generateMnemonic returns bip39 mnemonic', async () => {
    vi.mocked(bip39.generateMnemonic).mockReturnValue('test mnemonic');

    const kg = KeyGeneration();
    await expect(kg.generateMnemonic()).resolves.toBe('test mnemonic');
  });

  it('generateKeys derives addresses for mainnet', async () => {
    vi.mocked(deriveBchKeyMaterial).mockResolvedValue({
      publicKey: Uint8Array.from([7, 7, 7]),
      privateKey: Uint8Array.from([8, 8, 8]),
      publicKeyHash: Uint8Array.from([6, 6, 6]),
      address: 'bitcoincash:qmain',
      tokenAddress: 'bitcoincash:ztoken',
    });

    const kg = KeyGeneration();
    const keys = await kg.generateKeys(Network.MAINNET, 'mn', 'pw', 0, 1, 2);

    expect(keys).toEqual({
      publicKey: Uint8Array.from([7, 7, 7]),
      privateKey: Uint8Array.from([8, 8, 8]),
      publicKeyHash: Uint8Array.from([6, 6, 6]),
      address: 'bitcoincash:qmain',
      tokenAddress: 'bitcoincash:ztoken',
    });

    expect(deriveBchKeyMaterial).toHaveBeenCalledWith(
      Network.MAINNET,
      'mn',
      'pw',
      0,
      1,
      2
    );
  });

  it('generateKeys returns null if public key derivation fails', async () => {
    vi.mocked(deriveBchKeyMaterial).mockResolvedValue(null);

    const kg = KeyGeneration();
    await expect(
      kg.generateKeys(Network.CHIPNET, 'mn', '', 0, 0, 0)
    ).resolves.toBeNull();
  });
});
