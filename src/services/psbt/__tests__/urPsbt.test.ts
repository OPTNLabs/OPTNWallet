import { CryptoPSBT } from '@keystonehq/bc-ur-registry-btc';
import { UR, URDecoder, UREncoder } from '@ngraveio/bc-ur';
import { describe, expect, it } from 'vitest';
import vectorDocument from '../../../../test-vectors/psbt-ur.json';
import {
  UrPsbtScanner,
  encodePsbtToQrDisplay,
  encodePsbtToUrFrames,
  extractPsbtFromUrCbor,
  startsWithPsbtMagic,
  DEFAULT_UR_FRAGMENT_LENGTH,
  PSBT_UR_FRAGMENT_LENGTHS,
  PSBT_UR_QR_DISPLAY_SIZE,
  PSBT_UR_QR_ERROR_LEVEL,
  PSBT_UR_QR_MARGIN_MODULES,
  UR_FRAGMENT_LENGTH_OPTIONS,
} from '../urPsbt';
import { encodeUnsignedPsbt } from '../psbtBch';

const PUBKEY = Uint8Array.from([0x02, ...new Array(32).fill(0x11)]);
const P2PKH = Uint8Array.from([
  0x76,
  0xa9,
  0x14,
  ...new Array(20).fill(0x22),
  0x88,
  0xac,
]);

const psbt = () =>
  encodeUnsignedPsbt(
    [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        satoshis: 50_000n,
        lockingBytecode: P2PKH,
        publicKey: PUBKEY,
        masterFingerprint: Uint8Array.from([1, 2, 3, 4]),
        derivationPath: [0x8000002c, 0x80000091, 0x80000000, 0, 0],
      },
    ],
    [{ lockingBytecode: P2PKH, satoshis: 45_000n }]
  );

describe('UR crypto-psbt transport', () => {
  it('keeps 50/8 as the SeedCash-safe default while exposing bounded densities', () => {
    expect(DEFAULT_UR_FRAGMENT_LENGTH).toBe(50);
    expect(PSBT_UR_FRAGMENT_LENGTHS).toEqual([50, 100, 200, 400]);
    expect(PSBT_UR_QR_MARGIN_MODULES).toBe(8);
    expect(PSBT_UR_QR_DISPLAY_SIZE).toBeGreaterThanOrEqual(400);
    expect(PSBT_UR_QR_ERROR_LEVEL).toBe('L');
  });

  it('animates an ordinary PSBT at the SeedCash-safe density on every surface', () => {
    // Phones used to get this PSBT as one static QR of about 300 characters
    // (up to 2,400 for larger sends), which SeedCash's camera cannot read.
    const display = encodePsbtToQrDisplay(psbt());
    expect(display.mode).toBe('stream');
    expect(display.count).toBeGreaterThan(1);
    expect(display.frames).not.toBeNull();
    const frames = [display.uri];
    for (let i = 1; i < display.count * 2; i += 1) {
      frames.push((display.frames as { next(): string }).next());
    }
    for (const frame of frames) {
      expect(frame).toMatch(/^UR:CRYPTO-PSBT\/\d+-\d+\//);
      expect(frame.length).toBeLessThan(160);
    }
  });

  it('never draws a frame denser than the density control offers', () => {
    const densest = Math.max(...UR_FRAGMENT_LENGTH_OPTIONS);
    expect(() => encodePsbtToQrDisplay(psbt(), densest + 1)).toThrow(
      /fragment length/
    );
    expect(() => encodePsbtToQrDisplay(psbt(), 2_400)).toThrow(
      /fragment length/
    );
    expect(encodePsbtToQrDisplay(psbt(), densest).count).toBeGreaterThan(0);
  });

  it('is static only when the whole PSBT fits in one frame', () => {
    const display = encodePsbtToQrDisplay(psbt(), 450);
    expect(display.mode).toBe('static');
    expect(display.count).toBe(1);
    expect(display.frames).toBeNull();
    expect(display.uri).toMatch(/^UR:CRYPTO-PSBT\/[A-Z]+$/);
  });

  it('refuses bytes that are not a PSBT', () => {
    const wrapped = Uint8Array.from(
      new CryptoPSBT(Buffer.from(psbt())).toCBOR()
    );
    expect(() => encodePsbtToUrFrames(wrapped)).toThrow(/PSBT magic/);
  });

  it('emits ur:crypto-psbt frames', () => {
    const frames = encodePsbtToUrFrames(psbt());
    expect(frames.next().toLowerCase()).toMatch(/^ur:crypto-psbt\//);
    expect(frames.count).toBeGreaterThan(0);
  });

  it('puts the raw PSBT in the UR CBOR so SeedCash parse_psbt can read it', () => {
    // Stock SeedCash does `parse_psbt(decoder.result_message().cbor)`.
    // CryptoPSBT wraps that in a CBOR byte string (59 01 .. 70 73 62 74 ff),
    // which SeedCash rejects as "invalid PSBT magic". Reproduced live against
    // seedcash/helpers/ur2/ur_decoder.py + models/psbt_parser.py.
    const original = psbt();
    const decoder = new URDecoder();
    decoder.receivePart(
      encodePsbtToUrFrames(original, 450).next().toLowerCase()
    );
    expect(decoder.isComplete()).toBe(true);
    const cbor = Uint8Array.from(decoder.resultUR().cbor);
    expect(startsWithPsbtMagic(cbor)).toBe(true);
    expect([...cbor]).toEqual([...original]);
  });

  it('still reads a BCR-2020-006 / Keystone wrapped crypto-psbt', () => {
    const original = psbt();
    const wrapped = new CryptoPSBT(Buffer.from(original))
      .toUREncoder(Math.max(original.length * 3, 1024))
      .nextPart();
    const scanner = new UrPsbtScanner();
    const result = scanner.receive(wrapped);
    expect(result.complete).toBe(true);
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('extracts both raw and CBOR-wrapped payloads', () => {
    const original = psbt();
    expect([...extractPsbtFromUrCbor(original)]).toEqual([...original]);
    const wrapped = Uint8Array.from(
      new CryptoPSBT(Buffer.from(original)).toCBOR()
    );
    expect(startsWithPsbtMagic(wrapped)).toBe(false);
    expect([...extractPsbtFromUrCbor(wrapped)]).toEqual([...original]);
  });

  it('round-trips a PSBT through animated frames', () => {
    const original = psbt();
    const frames = encodePsbtToUrFrames(original, 60);
    const scanner = new UrPsbtScanner();

    let result = scanner.receive(frames.next());
    // Fountain frames repeat; bound the loop so a decoding bug fails the test
    // instead of hanging it.
    for (let i = 0; i < 200 && !result.complete; i += 1) {
      result = scanner.receive(frames.next());
    }

    expect(result.complete).toBe(true);
    expect(result.psbt).not.toBeNull();
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('round-trips a single-frame UR', () => {
    const original = psbt();
    const scanner = new UrPsbtScanner();
    const single = encodePsbtToUrFrames(original, 450);
    expect(single.count).toBe(1);
    const result = scanner.receive(single.next());
    expect(result.complete).toBe(true);
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('ignores non-UR codes instead of poisoning the scan', () => {
    // A camera sees whatever is in frame. Treating a stray QR as a corrupt
    // fragment would force the user to restart a scan that was going fine.
    const scanner = new UrPsbtScanner();
    expect(scanner.receive('https://example.com').complete).toBe(false);
    expect(scanner.receive('bitcoincash:qsomeaddress').complete).toBe(false);
  });

  it('refuses to encode an empty PSBT', () => {
    expect(() => encodePsbtToUrFrames(new Uint8Array(0))).toThrow();
  });

  it('reset() abandons a partial scan', () => {
    const frames = encodePsbtToUrFrames(psbt(), 60);
    const scanner = new UrPsbtScanner();
    scanner.receive(frames.next());
    scanner.receive('UR:CRYPTO-PSBT/7-11/NOTBYTEWORDSATALL');
    expect(scanner.damagedFrames).toBe(1);
    scanner.reset();
    expect(scanner.damagedFrames).toBe(0);
    expect(scanner.receive('not-a-ur').progress).toBe(0);
  });
});

describe('UrPsbtScanner must outlive a single frame', () => {
  // The watch-only Send screen built a new scanner inside its per-frame
  // handler, so every part was thrown away the moment the next one arrived.
  // Nothing failed loudly: a single-frame UR still completed, and a multi-frame
  // one simply never did, which reads on screen as "the camera does not work".
  //
  // This pins the property the call site depends on, from both directions.
  it('completes when one scanner sees every frame', () => {
    const original = psbt();
    const frames = encodePsbtToUrFrames(original, 60);
    const scanner = new UrPsbtScanner();

    let result = scanner.receive(frames.next());
    for (let i = 0; i < 200 && !result.complete; i += 1) {
      result = scanner.receive(frames.next());
    }

    expect(result.complete).toBe(true);
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('never completes when a fresh scanner is built per frame', () => {
    const original = psbt();
    const frames = encodePsbtToUrFrames(original, 60);
    // Same frames, same count, same order as the passing case above -- the only
    // difference is that no scanner survives to see a second part.
    let everCompleted = false;
    for (let i = 0; i < 200; i += 1) {
      const throwaway = new UrPsbtScanner();
      if (throwaway.receive(frames.next()).complete) everCompleted = true;
    }
    expect(everCompleted).toBe(false);
  });

  it('reports rising progress as parts accumulate', () => {
    // The screen shows this to the user, so it has to actually move.
    const original = psbt();
    const frames = encodePsbtToUrFrames(original, 60);
    const scanner = new UrPsbtScanner();

    const first = scanner.receive(frames.next());
    let latest = first;
    for (let i = 0; i < 200 && !latest.complete; i += 1) {
      latest = scanner.receive(frames.next());
    }

    expect(first.complete).toBe(false);
    expect(latest.progress).toBeGreaterThan(first.progress);
  });
});

describe('Rust UR frames match an independent BC-UR encoder', () => {
  // The frames come from crates/optn-core through WASM. @ngraveio/bc-ur is a
  // separate implementation of the same fountain code, so agreeing with it
  // frame for frame, mixed frames included, is agreement with the format
  // rather than with ourselves.
  const reference = (bytes: Uint8Array, fragmentLength: number) =>
    new UREncoder(new UR(Buffer.from(bytes), 'crypto-psbt'), fragmentLength);

  function payload(size: number, seed: number): Uint8Array {
    const bytes = new Uint8Array(size);
    let state = seed;
    for (let index = 0; index < size; index += 1) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      bytes[index] = state >>> 24;
    }
    bytes.set([0x70, 0x73, 0x62, 0x74, 0xff]);
    return bytes;
  }

  it('reproduces the committed vectors', () => {
    for (const vector of vectorDocument.vectors) {
      const frames = encodePsbtToUrFrames(
        Uint8Array.from(Buffer.from(vector.psbtHex, 'hex')),
        vector.maxFragmentLength
      );
      expect(frames.count, vector.description).toBe(vector.frameCount);
      for (const expected of vector.frames) {
        expect(frames.next(), vector.description).toBe(expected);
      }
    }
  });

  it('agrees on every density across payload sizes', () => {
    const sizes = [5, 49, 50, 51, 99, 101, 257, 640, 1_201, 2_399, 4_097];
    sizes.forEach((size, at) => {
      for (const fragmentLength of [10, ...UR_FRAGMENT_LENGTH_OPTIONS]) {
        const bytes = payload(size, at * 977 + fragmentLength);
        const ours = encodePsbtToUrFrames(bytes, fragmentLength);
        const theirs = reference(bytes, fragmentLength);
        expect(ours.count).toBe(theirs.fragmentsLength);
        for (let i = 0; i < Math.min(ours.count * 2 + 5, 120); i += 1) {
          expect(ours.next()).toBe(theirs.nextPart().toUpperCase());
        }
      }
    });
  });

  it('decodes from mixed frames alone when the pure ones were missed', () => {
    const original = payload(1_200, 7);
    const frames = encodePsbtToUrFrames(original);
    const scanner = new UrPsbtScanner();
    // Drop every pure frame: a camera that saw none of the first pass.
    for (let i = 0; i < frames.count; i += 1) frames.next();
    let result = scanner.receive(frames.next());
    for (let i = 0; i < 2_000 && !result.complete; i += 1) {
      result = scanner.receive(frames.next());
    }
    expect(result.complete).toBe(true);
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });
});
