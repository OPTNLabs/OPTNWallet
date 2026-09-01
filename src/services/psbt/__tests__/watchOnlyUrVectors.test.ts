import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UR_FRAGMENT_LENGTH,
  UrPsbtScanner,
  extractPsbtFromUrCbor,
} from '../urPsbt';
import {
  assertWatchOnlySighash,
  encodeWatchOnlyUrFrames,
  parsePsbtBytes,
} from '../watchOnlyUrEncode';
import vectorDocument from './vectors/watchOnlyUr.vectors.json';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

describe('watch-only UR test vectors', () => {
  it('has vectors to check', () => {
    // A truncated fixture would make every test below vacuous.
    expect(vectorDocument.vectors.length).toBeGreaterThan(0);
    expect(vectorDocument.urType).toBe('crypto-psbt');
    expect(vectorDocument.fragmentLength).toBe(DEFAULT_UR_FRAGMENT_LENGTH);
  });

  for (const vector of vectorDocument.vectors) {
    describe(vector.name, () => {
      const psbt = bytes(vector.psbtHex);

      it('encodes to exactly the recorded frames', () => {
        // This is the point of the vectors. The frames are what an air-gapped
        // SeedCash actually reads; a change in the UR library, the fragment
        // length, or the CBOR shape silently changes them, and the failure is
        // a camera that will not scan rather than an exception anywhere.
        expect(encodeWatchOnlyUrFrames(psbt)).toEqual(vector.frames);
      });

      it('produces the recorded number of frames at fragment length 50', () => {
        // Density is the whole reason this PR exists: SeedCash cameras could
        // not read the denser encoding. More frames cost seconds; a QR that
        // will not scan costs the air-gap.
        expect(vector.frames).toHaveLength(vector.frameCount);
        expect(vector.fragmentLength).toBe(50);
      });

      it('round-trips those frames back to the same PSBT', () => {
        const scanner = new UrPsbtScanner();
        let progress = scanner.receive(vector.frames[0]);
        for (
          let i = 1;
          i < vector.frames.length && !progress.complete;
          i += 1
        ) {
          progress = scanner.receive(vector.frames[i]);
        }
        expect(progress.complete).toBe(true);
        expect(hex(progress.psbt as Uint8Array)).toBe(vector.psbtHex);
      });

      it('carries the supported 0x41 BCH default on every input', () => {
        // Current SeedCash signs 0x41. The field remains explicit so import can
        // reject any signer that returns a different commitment.
        expect(() => assertWatchOnlySighash(psbt)).not.toThrow();
      });

      it('is a raw PSBT in the UR CBOR, not a spec byte-string wrapper', () => {
        // Stock SeedCash never unwraps the BCR-2020-006 wrapper: a wrapped
        // payload arrives as `59 01 90 70 73 62 74 ff …` and its parser dies
        // on "invalid PSBT magic".
        expect(hex(extractPsbtFromUrCbor(psbt))).toBe(vector.psbtHex);
      });

      it('is accepted from hex and base64, as the CLI reads it', () => {
        expect(hex(parsePsbtBytes(vector.psbtHex))).toBe(vector.psbtHex);
        expect(hex(parsePsbtBytes(Buffer.from(psbt).toString('base64')))).toBe(
          vector.psbtHex
        );
        expect(hex(parsePsbtBytes(psbt))).toBe(vector.psbtHex);
      });
    });
  }

  it('gives every vector a distinct name and payload', () => {
    const names = vectorDocument.vectors.map((v) => v.name);
    const payloads = vectorDocument.vectors.map((v) => v.psbtHex);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(payloads).size).toBe(payloads.length);
  });
});
