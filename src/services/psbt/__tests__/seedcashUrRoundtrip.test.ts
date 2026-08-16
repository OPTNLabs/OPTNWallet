// Does SeedCash's UR decoder read the animated QR OPTN actually displays?
//
// urPsbt.test.ts encodes and decodes with the same library, which proves the
// two halves of OUR implementation agree. The animated QR is the only channel
// to the device, so the claim that matters is whether SeedCash's decoder —
// `seedcash/helpers/ur2/ur_decoder.py`, the one `decode_qr.py` feeds from the
// camera — reconstructs the exact PSBT bytes we meant to send.
//
// Stock SeedCash feeds `decoder.result_message().cbor` straight to parse_psbt.
// That only works when the UR CBOR field IS the PSBT (`70736274ff…`), which is
// what SeedCash itself emits (`UR("crypto-psbt", self.psbt)`). We encode that
// same payload. These tests run SeedCash's decoder and assert the recovered
// bytes start with PSBT magic — if they ever need a CBOR unwrap, the encoder
// has drifted back to the Keystone wrap that SeedCash rejects.
//
// Opt-in, because it shells out to Python:
//   RUN_SEEDCASH_LIVE=1 npx vitest run src/services/psbt/__tests__/seedcashUrRoundtrip.test.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';

import { encodePsbtToUrFrames, encodePsbtToSingleUr } from '../urPsbt';

const SIGNER = join(process.cwd(), 'scripts', 'seedcash', 'sign_psbt.py');
const CWD = join(process.cwd(), 'scripts', 'seedcash');

const describeLive = process.env.RUN_SEEDCASH_LIVE ? describe : describe.skip;

/** A PSBT-shaped payload big enough to need several UR fragments. */
function payload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x70, 0x73, 0x62, 0x74, 0xff]);
  for (let index = 5; index < size; index += 1) {
    bytes[index] = (index * 7 + 11) & 0xff;
  }
  return bytes;
}

function decodeWithSeedCash(frames: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'seedcash-ur-'));
  const framesPath = join(dir, 'frames.txt');
  const outPath = join(dir, 'decoded.hex');
  writeFileSync(framesPath, frames.join('\n'));
  execFileSync('python', [SIGNER, 'decode-ur', framesPath, outPath], {
    cwd: CWD,
    encoding: 'utf8',
  });
  return readFileSync(outPath, 'utf8').trim();
}

describeLive('SeedCash UR decoding', () => {
  it('reads a multi-frame animated PSBT back byte for byte', () => {
    const psbt = payload(1200);
    const encoder = encodePsbtToUrFrames(psbt);
    expect(encoder.count).toBeGreaterThan(1);

    // Show each fragment once, exactly as the animation would cycle.
    const frames = Array.from({ length: encoder.count }, () => encoder.next());
    expect(frames[0].toLowerCase()).toMatch(/^ur:crypto-psbt\//);

    expect(decodeWithSeedCash(frames)).toBe(binToHex(psbt));
  });

  it('survives frames arriving out of order and duplicated', () => {
    // Over a camera, fragments are read in whatever order the eye catches them
    // and the same one is often read twice before the next appears.
    const psbt = payload(900);
    const encoder = encodePsbtToUrFrames(psbt);
    const frames = Array.from({ length: encoder.count * 3 }, () =>
      encoder.next()
    );
    const shuffled = [...frames].reverse();

    expect(decodeWithSeedCash(shuffled)).toBe(binToHex(psbt));
  });

  it('reads the single-frame form too', () => {
    const psbt = payload(200);
    expect(decodeWithSeedCash([encodePsbtToSingleUr(psbt)])).toBe(
      binToHex(psbt)
    );
  });
});
