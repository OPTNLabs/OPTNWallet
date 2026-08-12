import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../../redux/networkSlice';
import KeyGeneration from '../KeyGeneration';

vi.mock('@bitauth/libauth', () => ({
  deriveHdPath: vi.fn(),
  secp256k1: {
    derivePublicKeyCompressed: vi.fn(),
  },
  encodeCashAddress: vi.fn(),
  deriveHdPrivateNodeFromSeed: vi.fn(),
}));

vi.mock('@cashscript/utils', () => ({
  hash160: vi.fn(),
}));

vi.mock('bip39', () => ({
  default: {
    generateMnemonic: vi.fn(),
    mnemonicToSeed: vi.fn(),
  },
  generateMnemonic: vi.fn(),
  mnemonicToSeed: vi.fn(),
}));

import {
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
  deriveHdPrivateNodeFromSeed,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';

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
    vi.mocked(bip39.mnemonicToSeed).mockResolvedValue(Uint8Array.from([1, 2, 3]) as never);
    vi.mocked(deriveHdPrivateNodeFromSeed).mockReturnValue({
      privateKey: Uint8Array.from([9, 9, 9]),
    } as never);
    vi.mocked(deriveHdPath).mockReturnValue({
      privateKey: Uint8Array.from([8, 8, 8]),
    } as never);
    vi.mocked(secp256k1.derivePublicKeyCompressed).mockReturnValue(
      Uint8Array.from([7, 7, 7]) as never
    );
    vi.mocked(hash160).mockReturnValue(Uint8Array.from([6, 6, 6]) as never);

    vi.mocked(encodeCashAddress)
      .mockReturnValueOnce({ address: 'bitcoincash:qmain' } as never)
      .mockReturnValueOnce({ address: 'bitcoincash:ztoken' } as never);

    const kg = KeyGeneration();
    const keys = await kg.generateKeys(Network.MAINNET, 'mn', 'pw', 0, 1, 2);

    expect(keys).toEqual({
      alicePub: Uint8Array.from([7, 7, 7]),
      alicePriv: Uint8Array.from([8, 8, 8]),
      alicePkh: Uint8Array.from([6, 6, 6]),
      aliceAddress: 'bitcoincash:qmain',
      aliceTokenAddress: 'bitcoincash:ztoken',
    });

    expect(deriveHdPath).toHaveBeenCalled();
    expect(encodeCashAddress).toHaveBeenCalledTimes(2);
  });

  it('generateKeys returns null if public key derivation fails', async () => {
    vi.mocked(bip39.mnemonicToSeed).mockResolvedValue(Uint8Array.from([1, 2, 3]) as never);
    vi.mocked(deriveHdPrivateNodeFromSeed).mockReturnValue({
      privateKey: Uint8Array.from([9, 9, 9]),
    } as never);
    vi.mocked(deriveHdPath).mockReturnValue({
      privateKey: Uint8Array.from([8, 8, 8]),
    } as never);

    vi.mocked(secp256k1.derivePublicKeyCompressed).mockReturnValue('error' as never);

    const kg = KeyGeneration();
    await expect(
      kg.generateKeys(Network.CHIPNET, 'mn', '', 0, 0, 0)
    ).resolves.toBeNull();
  });
});
