import { describe, expect, it } from 'vitest';
import {
  SIGHASH_ALL_FORKID,
  encodeUnsignedPsbt,
  type PsbtInputSpec,
  type PsbtOutputSpec,
} from '../psbtBch';
import {
  assertChipnetNetwork,
  encodeWatchOnlyUrFrames,
  parsePsbtBytes,
} from '../watchOnlyUrEncode';
import { DEFAULT_UR_FRAGMENT_LENGTH, UrPsbtScanner } from '../urPsbt';

const PUBKEY = Uint8Array.from([0x02, ...new Array(32).fill(0x11)]);
const FINGERPRINT = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const P2PKH = Uint8Array.from([
  0x76,
  0xa9,
  0x14,
  ...new Array(20).fill(0x22),
  0x88,
  0xac,
]);

const input = (over: Partial<PsbtInputSpec> = {}): PsbtInputSpec => ({
  txid: 'a'.repeat(64),
  vout: 1,
  satoshis: 100_000n,
  lockingBytecode: P2PKH,
  publicKey: PUBKEY,
  masterFingerprint: FINGERPRINT,
  derivationPath: [0x8000002c, 0x80000091, 0x80000000, 0, 5],
  ...over,
});

const output = (over: Partial<PsbtOutputSpec> = {}): PsbtOutputSpec => ({
  lockingBytecode: P2PKH,
  satoshis: 90_000n,
  ...over,
});

describe('watch-only UR encode (CLI/GUI shared)', () => {
  it('emits crypto-psbt UR frames at fragment length 50 and round-trips', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    const frames = encodeWatchOnlyUrFrames(psbt);
    expect(frames.length).toBeGreaterThan(0);
    expect(DEFAULT_UR_FRAGMENT_LENGTH).toBe(50);
    expect(frames.every((frame) => /^UR:CRYPTO-PSBT\//i.test(frame))).toBe(
      true
    );
    const scanner = new UrPsbtScanner();
    let last = scanner.receive(frames[0]);
    for (let i = 1; i < frames.length && !last.complete; i += 1) {
      last = scanner.receive(frames[i]);
    }
    expect(last.complete).toBe(true);
    expect(last.psbt).not.toBeNull();
    expect([...(last.psbt as Uint8Array)]).toEqual([...psbt]);
  });

  it('refuses mainnet', () => {
    expect(() => assertChipnetNetwork('mainnet')).toThrow(/Chipnet/);
  });

  it('parses hex the same as raw bytes', () => {
    const psbt = encodeUnsignedPsbt([input()], [output()]);
    const hex = Buffer.from(psbt).toString('hex');
    expect([...parsePsbtBytes(hex)]).toEqual([...psbt]);
  });
});

describe('watch-only UR encode rejects non-0xc1', () => {
  it('cannot be called with 0x41 because encodeUnsignedPsbt refuses it', () => {
    expect(() =>
      encodeUnsignedPsbt([input()], [output()], SIGHASH_ALL_FORKID)
    ).toThrow(/0xc1/);
  });
});
