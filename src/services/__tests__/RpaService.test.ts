import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import { Network } from '../../state/slices/networkSlice';
import { derivePrivateKeyAtPath } from '../HdWalletService';
import {
  deriveRpaKeys,
  encodePaycode,
  decodePaycode,
  derivePaymentAddress,
  computeSharedSecret,
  getRpaSendBlockReason,
  getRpaKeyPaths,
  looksLikeRpaPaycode,
  rpaGrindString,
  RPA_PREFIX_BITS,
} from '../RpaService';
import { secp256k1 } from '@bitauth/libauth';
import { deriveHdPublicNodeChild } from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { encodeCashAddress } from '@bitauth/libauth';

// A fresh throwaway mnemonic generated per run — no seed phrase is hardcoded in
// the repo. The tests below only compare derivations of this same mnemonic
// (relative checks), so a random one works and nothing sensitive is committed.
const TEST_MNEMONIC = bip39.generateMnemonic();
const PASSPHRASE = '';

// RPA rides on the wallet's normal BIP44 account as a third unhardened chain
// (3), sibling to receive(0)/change(1), matching the Electron Cash reference.
const EXPECTED_MAINNET_SCAN_PATH = "m/44'/145'/0'/3/0";
const EXPECTED_MAINNET_SPEND_PATH = "m/44'/145'/0'/3/1";
const EXPECTED_CHIPNET_SCAN_PATH = "m/44'/1'/0'/3/0";
const EXPECTED_CHIPNET_SPEND_PATH = "m/44'/1'/0'/3/1";

describe('RpaService', () => {
  it('exposes network-specific RPA paths for UI and protocol consumers', () => {
    expect(getRpaKeyPaths(Network.MAINNET)).toEqual({
      scan: EXPECTED_MAINNET_SCAN_PATH,
      spend: EXPECTED_MAINNET_SPEND_PATH,
    });
    expect(getRpaKeyPaths(Network.CHIPNET)).toEqual({
      scan: EXPECTED_CHIPNET_SCAN_PATH,
      spend: EXPECTED_CHIPNET_SPEND_PATH,
    });
  });

  it('derives mainnet scan/spend keys at m/44\'/145\'/0\'/3/{0,1}', async () => {
    const [expectedScanPriv, expectedSpendPriv, keys] = await Promise.all([
      derivePrivateKeyAtPath(TEST_MNEMONIC, PASSPHRASE, EXPECTED_MAINNET_SCAN_PATH),
      derivePrivateKeyAtPath(TEST_MNEMONIC, PASSPHRASE, EXPECTED_MAINNET_SPEND_PATH),
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

  it('rejects a paycode whose checksum was changed', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const paycode = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.MAINNET);
    const replacement = paycode.endsWith('q') ? 'p' : 'q';

    expect(decodePaycode(`${paycode.slice(0, -1)}${replacement}`)).toBeNull();
  });

  it('blocks RPA input before ordinary CashAddress transaction building', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);
    const paycode = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.CHIPNET);

    expect(getRpaSendBlockReason('bchtest:qordinary', Network.CHIPNET)).toBeNull();
    expect(getRpaSendBlockReason(paycode, Network.MAINNET)).toMatch(/Chipnet/i);
    expect(getRpaSendBlockReason(paycode, Network.CHIPNET)).toBeNull();
    const replacement = paycode.endsWith('q') ? 'p' : 'q';
    expect(getRpaSendBlockReason(`${paycode.slice(0, -1)}${replacement}`, Network.CHIPNET)).toMatch(
      /invalid/i
    );
  });

  it('matches the Electron Cash grind string', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);
    expect(RPA_PREFIX_BITS).toBe(16);
    expect(rpaGrindString(keys.scanPubkey, 16)).toHaveLength(4);
    expect(rpaGrindString(keys.scanPubkey, 16)).toMatch(/^[0-9A-F]{4}$/);
  });

  it('pays the hash160 of the compressed child, per spec', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);
    const shared = computeSharedSecret(
      keys.scanPrivkey,
      keys.scanPubkey,
      '11'.repeat(32),
      0
    );
    const child = deriveHdPublicNodeChild(
      {
        publicKey: Uint8Array.from(keys.spendPubkey),
        chainCode: Uint8Array.from(shared),
        depth: 0,
        childIndex: 0,
        parentFingerprint: new Uint8Array(4),
      },
      0
    );
    if (typeof child === 'string') throw new Error(child);
    expect(child.publicKey.length).toBe(33);

    const compressed = encodeCashAddress({
      prefix: 'bchtest',
      type: 'p2pkh',
      payload: hash160(Uint8Array.from(child.publicKey)),
    });
    if (typeof compressed === 'string') throw new Error(compressed);

    expect(derivePaymentAddress(keys.spendPubkey, shared, Network.CHIPNET, 0)).toBe(
      compressed.address
    );

    // Electron Cash's paycode.py sets `use_uncompressed = True`, contradicting
    // both the spec ("Addresses should always be generated from compressed
    // pubkeys") and Selene's bch-rpa. Guard against drifting back to it.
    const uncompressedPubkey = secp256k1.uncompressPublicKey(child.publicKey);
    if (typeof uncompressedPubkey === 'string') throw new Error(uncompressedPubkey);
    const ecAddress = encodeCashAddress({
      prefix: 'bchtest',
      type: 'p2pkh',
      payload: hash160(Uint8Array.from(uncompressedPubkey)),
    });
    if (typeof ecAddress === 'string') throw new Error(ecAddress);
    expect(derivePaymentAddress(keys.spendPubkey, shared, Network.CHIPNET, 0)).not.toBe(
      ecAddress.address
    );
  });

  // Nothing in the wallet emits an offline-only code, so a test has to build
  // one. Same charset and checksum as the encoder, with the version byte left
  // free.
  function craftCode(version: number, prefixBits: number, scan: Uint8Array, spend: Uint8Array): string {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
    const polymod = (values: number[]): bigint => {
      let c = 1n;
      for (const d of values) {
        const high = c >> 35n;
        c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(d);
        for (let i = 0; i < 5; i++) if (((high >> BigInt(i)) & 1n) === 1n) c ^= GEN[i];
      }
      return c ^ 1n;
    };
    const toFive = (data: Uint8Array): number[] => {
      const out: number[] = [];
      let bits = 0;
      let val = 0;
      for (const b of data) {
        val = ((val << 8) | b) >>> 0;
        bits += 8;
        while (bits >= 5) {
          bits -= 5;
          out.push((val >>> bits) & 0x1f);
        }
        val &= (1 << bits) - 1;
      }
      if (bits > 0) out.push((val << (5 - bits)) & 0x1f);
      return out;
    };
    const prefix = version === 0x01 || version === 0x02 ? 'cashcode' : 'cashcodetest';
    const payload = new Uint8Array(72);
    payload[0] = version;
    payload[1] = prefixBits;
    payload.set(scan, 2);
    payload.set(spend, 35);
    const data5 = toFive(new Uint8Array([0x00, ...payload]));
    const expanded = [...prefix].map((c) => c.charCodeAt(0) & 0x1f).concat(0);
    const mod = polymod([...expanded, ...data5, 0, 0, 0, 0, 0, 0, 0, 0]);
    const checksum: number[] = [];
    for (let i = 7; i >= 0; i--) checksum.push(Number((mod >> BigInt(5 * i)) & 31n));
    return `${prefix}:${[...data5, ...checksum].map((c) => CHARSET[c]).join('')}`;
  }

  it('refuses an offline-only code rather than paying it on-chain', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);

    // Spec: "1 and 2 for p2pkh (mainnet), 5 and 6 for p2pkh (testnet), among
    // them 2 and 6 to force offline-communication only", and an offchain relay
    // is "a necessity for version 2, 4, 6 and 8". Such a recipient is not
    // scanning the chain, so an on-chain payment could sit unnoticed.
    const offlineChipnet = craftCode(0x06, RPA_PREFIX_BITS, keys.scanPubkey, keys.spendPubkey);
    expect(decodePaycode(offlineChipnet)).not.toBeNull();
    expect(getRpaSendBlockReason(offlineChipnet, Network.CHIPNET)).toMatch(/offline-only/i);

    const offlineMainnet = craftCode(0x02, RPA_PREFIX_BITS, keys.scanPubkey, keys.spendPubkey);
    expect(getRpaSendBlockReason(offlineMainnet, Network.MAINNET)).toMatch(/offline-only/i);

    // The on-chain versions are unaffected.
    expect(
      getRpaSendBlockReason(
        craftCode(0x05, RPA_PREFIX_BITS, keys.scanPubkey, keys.spendPubkey),
        Network.CHIPNET
      )
    ).toBeNull();
    expect(
      getRpaSendBlockReason(
        craftCode(0x01, RPA_PREFIX_BITS, keys.scanPubkey, keys.spendPubkey),
        Network.MAINNET
      )
    ).toBeNull();
  });

  it('refuses a code with no scan prefix instead of throwing mid-send', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);

    // prefix_size 0 is "no-filter for full-node or offline-communications".
    // decodePaycode accepts it, but rpaGrindString and rpaPrefixTargetHex both
    // throw on 0 — so without this check a decoded code reaches the grind and
    // raises a raw Error instead of declining the payment.
    const noPrefix = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.CHIPNET, 0);
    expect(decodePaycode(noPrefix)?.prefixBits).toBe(0);
    expect(() => rpaGrindString(keys.scanPubkey, 0)).toThrow(/prefix size/i);
    expect(getRpaSendBlockReason(noPrefix, Network.CHIPNET)).toMatch(/no scan prefix/i);
  });

  it('emits cashcode and never paycode', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const mainnet = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.MAINNET);
    const chipnet = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.CHIPNET);

    expect(mainnet.startsWith('cashcode:')).toBe(true);
    expect(chipnet.startsWith('cashcodetest:')).toBe(true);
    expect(mainnet.startsWith('paycode')).toBe(false);
    expect(chipnet.startsWith('paycode')).toBe(false);
  });

  it('still accepts legacy paycode strings so old codes keep working', async () => {
    const keys = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const legacyMainnet = encodePaycode(
      keys.scanPubkey,
      keys.spendPubkey,
      Network.MAINNET,
      RPA_PREFIX_BITS,
      'legacy-paycode'
    );
    const legacyChipnet = encodePaycode(
      keys.scanPubkey,
      keys.spendPubkey,
      Network.CHIPNET,
      RPA_PREFIX_BITS,
      'legacy-paycode'
    );
    expect(legacyMainnet.startsWith('paycode:')).toBe(true);
    expect(legacyChipnet.startsWith('paycodetest:')).toBe(true);

    for (const code of [legacyMainnet, legacyChipnet]) {
      expect(looksLikeRpaPaycode(code)).toBe(true);
      const decoded = decodePaycode(code);
      expect(decoded).not.toBeNull();
      expect(decoded!.legacy).toBe(true);
      expect(Buffer.from(decoded!.scanPubkey).toString('hex')).toBe(
        Buffer.from(keys.scanPubkey).toString('hex')
      );
      expect(Buffer.from(decoded!.spendPubkey).toString('hex')).toBe(
        Buffer.from(keys.spendPubkey).toString('hex')
      );
    }

    // A legacy code is a valid send target, not something we refuse.
    expect(getRpaSendBlockReason(legacyMainnet, Network.MAINNET)).toBeNull();
    expect(getRpaSendBlockReason(legacyChipnet, Network.CHIPNET)).toBeNull();

    const cashcode = encodePaycode(keys.scanPubkey, keys.spendPubkey, Network.MAINNET);
    expect(looksLikeRpaPaycode(cashcode)).toBe(true);
    expect(decodePaycode(cashcode)!.legacy).toBe(false);
  });

  it('uses network-specific coin-type key paths for mainnet and chipnet', async () => {
    const mainnet = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.MAINNET);
    const chipnet = await deriveRpaKeys(TEST_MNEMONIC, PASSPHRASE, Network.CHIPNET);
    expect(Buffer.from(mainnet.scanPubkey).toString('hex')).not.toBe(
      Buffer.from(chipnet.scanPubkey).toString('hex')
    );
    expect(Buffer.from(mainnet.spendPubkey).toString('hex')).not.toBe(
      Buffer.from(chipnet.spendPubkey).toString('hex')
    );
  });
});
