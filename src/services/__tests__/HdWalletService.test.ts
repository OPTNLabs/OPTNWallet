import { describe, expect, it } from 'vitest';

import { Network } from '../../redux/networkSlice';
import {
  deriveBchChild,
  deriveBchAddressFromHdPublicKey,
  deriveBchKeyMaterial,
  deriveBchStandardXpubs,
  deriveBchXpubAtBranch,
} from '../HdWalletService';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('HdWalletService', () => {
  it('derives receive addresses from xpubs that match mnemonic-based key material', async () => {
    const receiveIndex = 4;
    const xpubs = await deriveBchStandardXpubs(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0
    );
    const keyMaterial = await deriveBchKeyMaterial(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0,
      0,
      receiveIndex
    );
    const publicAddress = deriveBchAddressFromHdPublicKey(
      Network.MAINNET,
      xpubs.receive,
      BigInt(receiveIndex)
    );

    expect(keyMaterial).not.toBeNull();
    expect(publicAddress).not.toBeNull();
    expect(publicAddress?.address).toBe(keyMaterial?.address);
    expect(publicAddress?.tokenAddress).toBe(keyMaterial?.tokenAddress);
    expect(Array.from(publicAddress?.publicKey ?? [])).toEqual(
      Array.from(keyMaterial?.publicKey ?? [])
    );
    expect(Array.from(publicAddress?.publicKeyHash ?? [])).toEqual(
      Array.from(keyMaterial?.publicKeyHash ?? [])
    );
  });

  it('derives change addresses from branch xpubs that match mnemonic-based key material', async () => {
    const changeIndex = 9;
    const changeXpub = await deriveBchXpubAtBranch(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0,
      1
    );
    const keyMaterial = await deriveBchKeyMaterial(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0,
      1,
      changeIndex
    );
    const publicAddress = deriveBchAddressFromHdPublicKey(
      Network.MAINNET,
      changeXpub,
      BigInt(changeIndex)
    );

    expect(keyMaterial).not.toBeNull();
    expect(publicAddress).not.toBeNull();
    expect(publicAddress?.address).toBe(keyMaterial?.address);
    expect(publicAddress?.tokenAddress).toBe(keyMaterial?.tokenAddress);
  });

  it('unified child derivation produces matching public data from seed and xpub sources', async () => {
    const addressIndex = 2;
    const xpubs = await deriveBchStandardXpubs(
      Network.MAINNET,
      TEST_MNEMONIC,
      '',
      0
    );
    const fromSeed = await deriveBchChild(
      Network.MAINNET,
      {
        mnemonic: TEST_MNEMONIC,
        passphrase: '',
        accountIndex: 0,
        branchIndex: 0,
      },
      addressIndex
    );
    const fromXpub = await deriveBchChild(
      Network.MAINNET,
      {
        kind: 'xpub',
        hdPublicKey: xpubs.receive,
      },
      addressIndex
    );

    expect(fromSeed).not.toBeNull();
    expect(fromXpub).not.toBeNull();
    expect(fromSeed && 'privateKey' in fromSeed).toBe(true);
    expect(fromXpub && 'privateKey' in fromXpub).toBe(false);
    expect(fromSeed?.address).toBe(fromXpub?.address);
    expect(fromSeed?.tokenAddress).toBe(fromXpub?.tokenAddress);
    expect(Array.from(fromSeed?.publicKey ?? [])).toEqual(
      Array.from(fromXpub?.publicKey ?? [])
    );
    expect(Array.from(fromSeed?.publicKeyHash ?? [])).toEqual(
      Array.from(fromXpub?.publicKeyHash ?? [])
    );
  });

  it('uses the correct chipnet prefix for xpub-derived addresses', async () => {
    const xpubs = await deriveBchStandardXpubs(
      Network.CHIPNET,
      TEST_MNEMONIC,
      '',
      0
    );
    const publicAddress = deriveBchAddressFromHdPublicKey(
      Network.CHIPNET,
      xpubs.receive,
      0n
    );

    expect(publicAddress).not.toBeNull();
    expect(publicAddress?.address.startsWith('bchtest:')).toBe(true);
    expect(publicAddress?.tokenAddress.startsWith('bchtest:')).toBe(true);
  });
});
