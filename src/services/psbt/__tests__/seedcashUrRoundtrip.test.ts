// Does SeedCash's UR decoder read the animated QR OPTN actually displays?
//
// urPsbt.test.ts encodes and decodes with the same library, which proves the
// two halves of OUR implementation agree. The animated QR is the only channel
// to the device, so the claim that matters is whether SeedCash's decoder —
// `seedcash/helpers/ur2/ur_decoder.py`, the one `decode_qr.py` feeds from the
// camera — reconstructs the exact PSBT bytes we meant to send.
//
// FOUND A DEVICE-SIDE BUG, recorded here because it is not ours to fix:
//
// `ur:crypto-psbt` carries the PSBT inside a CBOR byte string (BCR-2020-006),
// so `URDecoder.result_message().cbor` is the WRAPPER, not the payload — for a
// 200-byte PSBT it begins `58 c8` (major type 2, one-byte length 200) and only
// then `70736274ff`. SeedCash's `decode_qr.py:get_data_psbt()` returns `.cbor`
// straight through to `parse_psbt`, which rejects it:
//
//     parse_psbt REJECTS it: ValueError invalid PSBT magic
//
// So stock SeedCash cannot import ANY standards-compliant crypto-psbt QR, from
// this wallet or any other. The fix belongs in SeedCash — CBOR-decode the byte
// string in `get_data_psbt` — and these tests unwrap it on SeedCash's behalf so
// they assert what is really on the wire. If they ever fail, the encoder here
// has drifted; the device bug is separate and lives upstream.
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
