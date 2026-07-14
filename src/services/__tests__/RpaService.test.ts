import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import { Network } from '../../state/slices/networkSlice';
import { derivePrivateKeyAtPath } from '../HdWalletService';
import { deriveRpaKeys, encodePaycode, decodePaycode } from '../RpaService';

// A fresh throwaway mnemonic generated per run — no seed phrase is hardcoded in
// the repo. The tests below only compare derivations of this same mnemonic
// (relative checks), so a random one works and nothing sensitive is committed.
const TEST_MNEMONIC = bip39.generateMnemonic();
const PASSPHRASE = '';

// RPA rides on the wallet's normal BIP44 account as a third unhardened chain
// (3), sibling to receive(0)/change(1), matching the Electron Cash reference.
const EXPECTED_SCAN_PATH = "m/44'/145'/0'/3/0";
const EXPECTED_SPEND_PATH = "m/44'/145'/0'/3/1";

describe('RpaService', () => {
  it('derives scan/spend keys at m/44\'/145\'/0\'/3/{0,1}', async () => {
    const [expectedScanPriv, expectedSpendPriv, keys] = await Promise.all([
      derivePrivateKeyAtPath(TEST_MNEMONIC, PASSPHRASE, EXPECTED_SCAN_PATH),
      derivePrivateKeyAtPath(TEST_MNEMONIC, PASSPHRASE, EXPECTED_SPEND_PATH),
      deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET),
    ]);

    expect(Buffer.from(keys.scanPrivkey).toString('hex')).toBe(
      Buffer.from(expectedScanPriv).toString('hex')
    );
    expect(Buffer.from(keys.spendPrivkey).toString('hex')).toBe(
      Buffer.from(expectedSpendPriv).toString('hex')
    );
  });

  it('derives compressed (33-byte) pubkeys', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    expect(keys.scanPubkey.length).toBe(33);
    expect(keys.spendPubkey.length).toBe(33);
  });

  it('round-trips paycode encode/decode without a version byte size cap', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const paycode = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.MAINNET);
    const decoded = decodePaycode(paycode);

    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!.scanPubkey).toString('hex')).toBe(
      Buffer.from(keys.scanPubkey).toString('hex')
    );
    expect(Buffer.from(decoded!.spendPubkey).toString('hex')).toBe(
      Buffer.from(keys.spendPubkey).toString('hex')
    );
  });

  it('produces different keys for mainnet vs chipnet', async () => {
    const mainnet = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const chipnet = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);
    expect(Buffer.from(mainnet.scanPubkey).toString('hex')).not.toBe(
      Buffer.from(chipnet.scanPubkey).toString('hex')
    );
  });
});
