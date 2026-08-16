// Keystone account export -> the fields a watch-only wallet needs.
//
// The exports here are built with Keystone's own registry classes and encoded
// to real `ur:` frames, so the parser is read against the same structure a
// device emits rather than a hand-written fixture that could agree with a
// misreading.

import { describe, expect, it } from 'vitest';
import registry from '@keystonehq/bc-ur-registry';

import {
  isBchAccountPath,
  parseKeystoneAccount,
} from '../keystoneAccount';

const { CryptoHDKey, CryptoKeypath, PathComponent } = registry;

const PUBKEY = Buffer.from(
  '02f178b9410d11e47e10bef8a8e4bc53e48d9ae15864a024a54f87a802dad5f514',
  'hex'
);

function bchAccountExport({
  fingerprint = '73c5da0a',
  path = [44, 145, 0],
  withOrigin = true,
}: {
  fingerprint?: string;
  path?: number[];
  withOrigin?: boolean;
} = {}) {
  const origin = withOrigin
    ? new CryptoKeypath(
        path.map((index) => new PathComponent({ index, hardened: true })),
        Buffer.from(fingerprint, 'hex')
      )
    : undefined;
  return new CryptoHDKey({
    isMaster: false,
    key: PUBKEY,
    chainCode: Buffer.alloc(32, 7),
    origin,
  });
}

/** Encode as the animated QR the device would actually show. */
function frames(item: { toUREncoder: (size: number) => { nextPart: () => string; fragmentsLength: number } }, fragment = 1000): string[] {
  const encoder = item.toUREncoder(fragment);
  return Array.from({ length: encoder.fragmentsLength }, () => encoder.nextPart());
}

describe('Keystone account export', () => {
  it('carries the master fingerprint and path the xPub alone cannot', () => {
    // This is the whole reason Keystone is a separate option from SeedCash:
    // SeedCash's "Export Xpub" is a bare base58 string, so the fingerprint has
    // to be typed off the device screen and the account path assumed. Keystone
    // ships both inside the QR.
    const account = parseKeystoneAccount(frames(bchAccountExport()));

    expect(account.masterFingerprintHex).toBe('73c5da0a');
    expect(account.accountPath).toBe("m/44'/145'/0'");
    expect(account.xpub.startsWith('xpub')).toBe(true);
  });

  it('reads the SOURCE fingerprint, not the parent', () => {
    // getParentFingerprint() is the immediate parent's and is a plausible
    // wrong answer — a signer would never match against it, and the failure
    // would look like "the device does not recognise these coins" rather than
    // like a decoding bug.
    const key = bchAccountExport({ fingerprint: 'aabbccdd' });
    const parsed = parseKeystoneAccount(frames(key));
    expect(parsed.masterFingerprintHex).toBe('aabbccdd');
  });

  it('reassembles a multi-frame animated export', () => {
    const parts = frames(bchAccountExport(), 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(parseKeystoneAccount(parts).masterFingerprintHex).toBe('73c5da0a');
  });

  it('refuses an export with no origin rather than guessing', () => {
    // Without an origin there is no fingerprint and no path. Inventing either
    // would produce a wallet that watches the right coins and cannot be signed
    // for, which is the worst of both. (The registry rejects it even earlier:
    // an xPub cannot be serialized without the depth and parent fingerprint
    // the origin carries, so the failure surfaces as an unusable key.)
    expect(() =>
      parseKeystoneAccount(frames(bchAccountExport({ withOrigin: false })))
    ).toThrow(/usable account xPub|master fingerprint|account path/i);
  });

  it('rejects input that is not a UR at all', () => {
    expect(() => parseKeystoneAccount(['not-a-ur'])).toThrow(/Keystone account/i);
    expect(() => parseKeystoneAccount([])).toThrow(/Nothing was scanned/i);
  });

  it('reports an incomplete animated scan instead of half a key', () => {
    const parts = frames(bchAccountExport(), 20);
    expect(() => parseKeystoneAccount([parts[0]])).toThrow(/part of the animated/i);
  });

  it('recognises a BCH account path and flags anything else', () => {
    expect(isBchAccountPath("m/44'/145'/0'")).toBe(true);
    expect(isBchAccountPath("m/44'/145'/3'")).toBe(true);
    // A BTC account would derive real, watchable addresses that no BCH
    // balance ever appears on.
    expect(isBchAccountPath("m/44'/0'/0'")).toBe(false);
    expect(isBchAccountPath("m/84'/145'/0'")).toBe(false);
  });

  it('surfaces a non-BCH export so the caller can warn', () => {
    const btc = parseKeystoneAccount(
      frames(bchAccountExport({ path: [44, 0, 0] }))
    );
    expect(btc.accountPath).toBe("m/44'/0'/0'");
    expect(isBchAccountPath(btc.accountPath)).toBe(false);
  });
});
