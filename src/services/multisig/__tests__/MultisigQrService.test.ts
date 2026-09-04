import { describe, expect, it } from 'vitest';
import registry from '@keystonehq/bc-ur-registry';
import {
  decodeMultisigXpubExport,
  decodeMultisigXpubPayload,
  encodeMultisigCosignerUr,
} from '../MultisigQrService';

const { CryptoHDKey, CryptoKeypath, PathComponent } = registry;

const PUBKEY = Buffer.from(
  '02f178b9410d11e47e10bef8a8e4bc53e48d9ae15864a024a54f87a802dad5f514',
  'hex'
);

function cryptoHdKeyExport() {
  return new CryptoHDKey({
    isMaster: false,
    key: PUBKEY,
    chainCode: Buffer.alloc(32, 7),
    origin: new CryptoKeypath(
      [
        new PathComponent({ index: 44, hardened: true }),
        new PathComponent({ index: 145, hardened: true }),
        new PathComponent({ index: 0, hardened: true }),
      ],
      Buffer.from('aabbccdd', 'hex')
    ),
  });
}

function encodeSinglePart(item: {
  toUREncoder: (fragmentLength: number) => {
    nextPart: () => string;
    fragmentsLength: number;
  };
}): string {
  const encoder = item.toUREncoder(1000);
  expect(encoder.fragmentsLength).toBe(1);
  return encoder.nextPart();
}

describe('Multisig QR xpub metadata', () => {
  it('keeps accepting a bare xpub while correctly showing that origin is absent', () => {
    const xpub = 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKp4S5bM5aYx';
    expect(decodeMultisigXpubExport(xpub)).toEqual({ xpub });
    expect(decodeMultisigXpubPayload(xpub)).toBe(xpub);
  });

  it('extracts the master fingerprint and account path from crypto-hdkey UR', () => {
    const decoded = decodeMultisigXpubExport(
      encodeSinglePart(cryptoHdKeyExport())
    );

    expect(decoded.xpub.startsWith('xpub')).toBe(true);
    expect(decoded.masterFingerprintHex).toBe('aabbccdd');
    expect(decoded.accountPath).toBe("m/44'/145'/0'");
  });

  it('round-trips the complete cosigner record without copy-paste fields', () => {
    const source = cryptoHdKeyExport();
    const frames = encodeMultisigCosignerUr({
      xpub: source.getBip32Key(),
      masterFingerprintHex: 'aabbccdd',
      accountPath: "m/44'/145'/0'",
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(decodeMultisigXpubExport(frames[0])).toMatchObject({
      masterFingerprintHex: 'aabbccdd',
      accountPath: "m/44'/145'/0'",
    });
  });
});
