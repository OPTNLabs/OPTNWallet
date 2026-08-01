// The interop contract with SeedCash, asserted field by field.
//
// A round-trip through our own encoder proves nothing about whether another
// implementation can read the result, so these assertions are written against
// what `seedcash/models/psbt_parser.py` actually looks for:
//
//   * amount from PSBT_IN_WITNESS_UTXO (0x01): `int.from_bytes(v[:8], "little")`
//   * ownership from PSBT_IN_BIP32_DERIVATION (0x06): `v[:4] == fingerprint`
//   * signature from PSBT_IN_PARTIAL_SIG (0x02), key `0x02 || pubkey`

import { describe, expect, it } from 'vitest';
import {
  PSBT_MAGIC,
  SIGHASH_ALL_FORKID,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  decodePsbt,
  encodeUnsignedPsbt,
  sighashTypeOf,
  verifySignatureSighashTypes,
  type PsbtInputSpec,
  type PsbtOutputSpec,
} from '../psbtBch';

const PUBKEY = Uint8Array.from([0x02, ...new Array(32).fill(0x11)]);
const FINGERPRINT = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const P2PKH = Uint8Array.from([
  0x76, 0xa9, 0x14, ...new Array(20).fill(0x22), 0x88, 0xac,
]);

const input = (over: Partial<PsbtInputSpec> = {}): PsbtInputSpec => ({
  txid: 'a'.repeat(64),
  vout: 1,
  satoshis: 100_000n,
  lockingBytecode: P2PKH,
  publicKey: PUBKEY,
  masterFingerprint: FINGERPRINT,
  // m/44'/145'/0'/0/5
  derivationPath: [0x8000002c, 0x80000091, 0x80000000, 0, 5],
  ...over,
});

const output = (over: Partial<PsbtOutputSpec> = {}): PsbtOutputSpec => ({
  lockingBytecode: P2PKH,
  satoshis: 90_000n,
  ...over,
});

/** Find `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('BCH PSBT encoding', () => {
  it('starts with the PSBT magic', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    expect([...psbt.subarray(0, 5)]).toEqual([...PSBT_MAGIC]);
  });

  it('requests SIGHASH_ALL|FORKID|ANYONECANPAY by default', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    // PSBT_IN_SIGHASH_TYPE: key 0x03, value uint32 LE 0xc1.
    const field = Uint8Array.from([0x01, 0x03, 0x04, 0xc1, 0x00, 0x00, 0x00]);
    expect(indexOfBytes(psbt, field)).toBeGreaterThan(-1);
  });

  it('refuses a sighash type without FORKID', () => {
    // 0x01 is SIGHASH_ALL without FORKID: a signature no BCH node accepts, and
    // the failure would only surface at broadcast.
    expect(() => encodeUnsignedPsbt([input()], [output()], 0x01)).toThrow(
      /FORKID/
    );
  });

  it('carries the input amount where SeedCash reads it', () => {
    const psbt = encodeUnsignedPsbt([input({ satoshis: 100_000n })], [output()]);
    // 100000 = 0x0186a0, little-endian over 8 bytes, right after key 0x01.
    const amountLE = Uint8Array.from([0xa0, 0x86, 0x01, 0, 0, 0, 0, 0]);
    const at = indexOfBytes(psbt, amountLE);
    expect(at).toBeGreaterThan(-1);
    // Preceded by the WITNESS_UTXO key record: keylen 0x01, key 0x01.
    expect(psbt[at - 3]).toBe(0x01);
    expect(psbt[at - 2]).toBe(0x01);
  });

  it('claims the input for the wallet via fingerprint-first derivation', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    // SeedCash decides an input is its own with `v[:4] == fingerprint`, so the
    // fingerprint must be the first four bytes of the 0x06 value.
    const key = Uint8Array.from([0x06, ...PUBKEY]);
    const at = indexOfBytes(psbt, key);
    expect(at).toBeGreaterThan(-1);
    const valueStart = at + key.length + 1; // + 1-byte value length
    expect([...psbt.subarray(valueStart, valueStart + 4)]).toEqual([
      ...FINGERPRINT,
    ]);
  });

  it('encodes derivation levels as little-endian uint32, hardened bit intact', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    // 0x8000002c little-endian.
    expect(indexOfBytes(psbt, Uint8Array.from([0x2c, 0x00, 0x00, 0x80]))).toBeGreaterThan(-1);
  });

  it('rejects an uncompressed public key rather than emitting an unsignable input', () => {
    expect(() =>
      encodeUnsignedPsbt([input({ publicKey: new Uint8Array(65) })], [output()])
    ).toThrow(/compressed/);
  });

  it('needs at least one input and one output', () => {
    expect(() => encodeUnsignedPsbt([], [output()])).toThrow(/input/);
    expect(() => encodeUnsignedPsbt([input()], [])).toThrow(/output/);
  });

  it('marks change so a device can show it as change', () => {
    const psbt = encodeUnsignedPsbt(
      [input()],
      [
        output(),
        output({
          publicKey: PUBKEY,
          masterFingerprint: FINGERPRINT,
          derivationPath: [0x8000002c, 0x80000091, 0x80000000, 1, 3],
        }),
      ]
    );
    // PSBT_OUT_BIP32_DERIVATION shares key byte 0x02 with PSBT_IN_PARTIAL_SIG;
    // it is the output maps that make it a change marker.
    expect(indexOfBytes(psbt, Uint8Array.from([0x02, ...PUBKEY]))).toBeGreaterThan(-1);
  });
});

describe('BCH PSBT decoding', () => {
  it('round-trips the requested sighash type', () => {
    const psbt = encodeUnsignedPsbt([input(), input({ vout: 2 })], [output()]);
    const parsed = decodePsbt(psbt);
    expect(parsed.requestedSighashTypes.slice(0, 2)).toEqual([0xc1, 0xc1]);
  });

  it('rejects bytes that are not a PSBT', () => {
    expect(() => decodePsbt(Uint8Array.from([1, 2, 3]))).toThrow(/Not a PSBT/);
    expect(() => decodePsbt(new Uint8Array(0))).toThrow(/Not a PSBT/);
  });

  it('does not read past the end of a truncated PSBT', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    expect(() => decodePsbt(psbt.subarray(0, psbt.length - 4))).toThrow();
  });
});

describe('sighash verification on returned signatures', () => {
  const sig = (sighashByte: number) =>
    Uint8Array.from([...new Array(64).fill(0x33), sighashByte]);

  it('reads the trailing sighash byte', () => {
    expect(sighashTypeOf(sig(0xc1))).toBe(0xc1);
    expect(sighashTypeOf(new Uint8Array(0))).toBeNull();
  });

  it('accepts signatures that committed to what we asked for', () => {
    const result = verifySignatureSighashTypes(
      [{ inputIndex: 0, publicKey: PUBKEY, signature: sig(0xc1) }],
      SIGHASH_ALL_FORKID_ANYONECANPAY
    );
    expect(result.ok).toBe(true);
  });

  it('catches a device that signed 0x41 when 0xc1 was requested', () => {
    // Exactly what SeedCash does today: it hard-codes 0x41 and never reads
    // PSBT_IN_SIGHASH_TYPE. Without this check the transaction is assembled,
    // shown as ready, and rejected at broadcast — by which point the user has
    // put the device away and has no idea which step failed.
    const result = verifySignatureSighashTypes(
      [{ inputIndex: 0, publicKey: PUBKEY, signature: sig(SIGHASH_ALL_FORKID) }],
      SIGHASH_ALL_FORKID_ANYONECANPAY
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('0x41');
      expect(result.message).toContain('0xc1');
      expect(result.message).toMatch(/ignored the requested sighash/i);
    }
  });

  it('rejects an empty signature instead of treating it as absent', () => {
    const result = verifySignatureSighashTypes(
      [{ inputIndex: 2, publicKey: PUBKEY, signature: new Uint8Array(0) }],
      SIGHASH_ALL_FORKID_ANYONECANPAY
    );
    expect(result.ok).toBe(false);
  });
});
