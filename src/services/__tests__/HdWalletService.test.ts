import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';

import { Network } from '../../state/slices/networkSlice';
import {
  alignHdPublicKeyNetwork,
  buildBchAccountPath,
  deriveBchChild,
  deriveBchAddressFromHdPublicKey,
  deriveBchKeyMaterial,
  deriveBchStandardXpubs,
  deriveBchXpubAtBranch,
  getBchAccountPath,
  getBchCoinType,
  normalizeBchAccountPath,
  parseBchAccountPath,
} from '../HdWalletService';

// Deterministic zero-entropy BIP39 test vector (not a real seed).
const TEST_MNEMONIC = bip39.entropyToMnemonic('0'.repeat(32));

describe('HdWalletService', () => {
  it('uses BCH coin type 145 on mainnet and 1 on chipnet', () => {
    expect(getBchCoinType(Network.MAINNET)).toBe(145);
    expect(getBchCoinType(Network.CHIPNET)).toBe(1);
    expect(getBchAccountPath(Network.CHIPNET, 2)).toBe("m/44'/1'/2'");
    expect(getBchAccountPath(Network.MAINNET, 0)).toBe("m/44'/145'/0'");
  });

  it('accepts only canonical BIP44 account paths', () => {
    expect(normalizeBchAccountPath(" m/44'/1'/7' ")).toBe("m/44'/1'/7'");
    expect(() => normalizeBchAccountPath("m/44'/1'/0'/0/0")).toThrow();
    expect(() => normalizeBchAccountPath("m/49'/1'/0'")).toThrow();
    expect(() => normalizeBchAccountPath("m/44'/2147483648'/0'")).toThrow();
  });

  it('aligns tpub↔xpub version bytes without changing HD node (account index)', async () => {
    // Account-level tpub (depth 3, account 0') as stored from a Trezor chipnet export.
    const tpub =
      'tpubDCCfzARsLdojT3NJp65f2u4TLtHwcARXMyX9fdV3iUgQYhtH6bC9imAocqJSBBLdJNLVQagY9ZFWHeUJyyeiStiRDTDX3MbG1LYfG1aAeYz';
    const asMain = alignHdPublicKeyNetwork(Network.MAINNET, tpub);
    expect(asMain.startsWith('xpub')).toBe(true);
    expect(asMain).not.toBe(tpub);
    // Round-trip back to testnet serialization.
    const asTest = alignHdPublicKeyNetwork(Network.CHIPNET, asMain);
    expect(asTest).toBe(tpub);
    // Same network is a no-op (trimmed).
    expect(alignHdPublicKeyNetwork(Network.MAINNET, asMain)).toBe(asMain);
  });

  it('round-trips editable BIP44 numeric components without exposing hardened markers', () => {
    const parts = parseBchAccountPath("m/44'/1'/7'");

    expect(parts).toEqual({ coinType: 1, accountIndex: 7 });
    expect(buildBchAccountPath(parts)).toBe("m/44'/1'/7'");
    expect(() =>
      buildBchAccountPath({ coinType: 1, accountIndex: 2147483648 })
    ).toThrow();
  });

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
