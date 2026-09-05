// A full air-gap round trip, driven by SeedCash's own code at both ends.
//
// Every other test in this directory checks our encoder against our decoder.
// This one is the only place a transaction leaves here, is understood, signed
// and re-encoded by the *other* implementation, and comes back. The fixture
// was produced by running SeedCash at `origin/main`:
//
//   1. our `buildWatchOnlyPsbt` builds an unsigned PSBT for a coin locked to a
//      key SeedCash derived, so the signer owns the key and we hold only the
//      xpub -- the real topology, not a shared secret
//   2. our `encodePsbtToUrFrames` animates it
//   3. SeedCash's `DecodeQR.add_data` reads those frames and recovers the PSBT
//      byte for byte
//   4. SeedCash's `BitcoinCashSigner.signed_psbt` signs it (425 -> 526 bytes,
//      hash type 0x41 = ALL|FORKID)
//   5. SeedCash's own `UREncoder` animates the signed result
//   6. our `UrPsbtScanner` reads it back -- what this file asserts
//
// Chipnet addresses throughout; nothing here is broadcast and the key is a
// throwaway derived from a fixed harness seed.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { UrPsbtScanner } from '../urPsbt';

type Fixture = {
  unsigned_hex: string;
  signed_hex: string;
} & Record<string, { seq_len: number; frames: string[] }>;

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/seedcash-signed-roundtrip.json', import.meta.url)
    ),
    'utf8'
  )
) as Fixture;

function drain(frames: string[]) {
  const scanner = new UrPsbtScanner();
  for (const frame of frames) {
    const progress = scanner.receive(frame);
    if (progress.complete && progress.psbt) return progress.psbt;
  }
  return null;
}

describe('a PSBT SeedCash actually signed', () => {
  it.each(['50', '200'])(
    'comes back through our scanner at fragment length %s',
    (density) => {
      const recovered = drain(fixture[density].frames);
      expect(recovered, `nothing recovered at ${density}`).not.toBeNull();
      expect(binToHex(recovered!)).toBe(fixture.signed_hex);
    }
  );

  it('is the transaction we sent, with a signature added', () => {
    // The bytes grew and the unsigned transaction inside is unchanged -- the
    // device signed *our* proposal rather than substituting one of its own.
    const recovered = drain(fixture['50'].frames)!;
    const unsigned = hexToBin(fixture.unsigned_hex);

    expect(recovered.length).toBeGreaterThan(unsigned.length);

    // PSBT_IN_PARTIAL_SIG is key type 0x02, and a BCH signature is 0x41 at the
    // end (ALL|FORKID). Neither appears in the unsigned PSBT.
    const signedHex = fixture.signed_hex;
    const unsignedHex = fixture.unsigned_hex;
    expect(signedHex.startsWith(unsignedHex.slice(0, 20))).toBe(true);
    expect(signedHex.length - unsignedHex.length).toBeGreaterThan(100);
  });

  it('still recovers when the camera misreads part of the return scan', () => {
    // The bug this branch exists for, now on a real signed payload rather than
    // a synthetic one. A signed PSBT needs more frames than the unsigned one,
    // so a bad read is close to certain on the return leg.
    const clean = fixture['50'].frames;
    const withMisreads = clean.flatMap((frame, index) =>
      index % 4 === 1 ? ['UR:CRYPTO-PSBT/7-11/NOTBYTEWORDSATALL', frame] : [frame]
    );
    const recovered = drain(withMisreads);
    expect(recovered).not.toBeNull();
    expect(binToHex(recovered!)).toBe(fixture.signed_hex);
  });
});
