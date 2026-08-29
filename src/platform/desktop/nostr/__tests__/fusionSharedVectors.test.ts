// The TypeScript half of the shared CashFusion vectors.
//
// `test-vectors/fusion.json` is read by BOTH implementations of these
// primitives — this side, and `crates/optn-core/src/fusion`. The desktop
// backend has always had its own Rust copy of the blind Schnorr and Pedersen
// math and this side has had its own TypeScript copy, and the header of
// fusionBlindSchnorr.ts says outright that the two have to match. Nothing
// checked it. Each side's tests proved only that it agreed with itself.
//
// A drift between them does not crash. It produces a signature or a commitment
// the other side rejects, part-way through a round, after coins are committed.
//
// If a vector fails, the protocol changed or one side broke. Fix the code.
// Regenerating the file to make the test pass throws away the only thing
// keeping the two sides honest.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { verifyBchSchnorr } from '../fusionBlindSchnorr';
import { pedersenCommitWithNonce } from '../fusionPedersen';

type SignatureVector = {
  label: string;
  privkeyHex: string;
  pubkeyHex: string;
  messageHex: string;
  signatureHex: string;
};

type BlindVector = {
  roundPubkeyHex: string;
  rPointHex: string;
  messageHex: string;
  blindedChallengeHex: string;
  issuerResponseHex: string;
  signatureHex: string;
};

type CommitmentVector = {
  amount: number;
  nonceHex: string;
  commitmentHex: string;
};

type FusionVectors = {
  pedersen: {
    hCompressedHex: string;
    commitments: CommitmentVector[];
  };
  schnorr: {
    signatures: SignatureVector[];
    blind: BlindVector[];
  };
};

const vectors: FusionVectors = JSON.parse(
  readFileSync(new URL('../../../../../test-vectors/fusion.json', import.meta.url), 'utf8')
);

describe('shared CashFusion vectors', () => {
  it('has vectors to check', () => {
    // A file that silently lost its contents would make every loop below pass
    // by iterating nothing.
    expect(vectors.schnorr.signatures.length).toBeGreaterThan(0);
    expect(vectors.schnorr.blind.length).toBeGreaterThan(0);
    expect(vectors.pedersen.commitments.length).toBeGreaterThan(0);
  });

  it('verifies signatures the Rust core produced', () => {
    for (const vector of vectors.schnorr.signatures) {
      expect(
        verifyBchSchnorr(
          hexToBin(vector.pubkeyHex),
          hexToBin(vector.signatureHex),
          hexToBin(vector.messageHex)
        ),
        `signature for "${vector.label}" must verify here too`
      ).toBe(true);
    }
  });

  it('verifies blind signatures under the round key', () => {
    // The case most likely to drift: the c = -1 branch fires only about half
    // the time, and getting it wrong is invisible until a peer rejects the
    // signature mid-round.
    for (const vector of vectors.schnorr.blind) {
      expect(
        verifyBchSchnorr(
          hexToBin(vector.roundPubkeyHex),
          hexToBin(vector.signatureHex),
          hexToBin(vector.messageHex)
        ),
        `blind signature over ${vector.messageHex.slice(0, 16)}… must verify`
      ).toBe(true);
    }
  });

  it('rejects a signature whose last byte was flipped', () => {
    // Guards the check above from being vacuous: if verifyBchSchnorr returned
    // true for everything, the assertions would pass and prove nothing.
    const vector = vectors.schnorr.signatures[0];
    const tampered = hexToBin(vector.signatureHex);
    tampered[tampered.length - 1] ^= 0x01;
    expect(
      verifyBchSchnorr(
        hexToBin(vector.pubkeyHex),
        tampered,
        hexToBin(vector.messageHex)
      )
    ).toBe(false);
  });

  it('reproduces Pedersen commitments byte for byte', () => {
    for (const vector of vectors.pedersen.commitments) {
      const { commitmentHex } = pedersenCommitWithNonce(
        vector.amount,
        vector.nonceHex
      );
      expect(commitmentHex, `commitment for ${vector.amount} sats`).toBe(
        vector.commitmentHex
      );
    }
  });

  it('agrees on the nothing-up-my-sleeve generator H', () => {
    // If H differed, every commitment would differ and the round's balance
    // check would fail for reasons no log would explain.
    const h = hexToBin(vectors.pedersen.hCompressedHex);
    expect(h[0]).toBe(0x02);
    expect(Buffer.from(h.slice(1)).toString('ascii')).toBe(
      'CashFusion gives us fungibility.'
    );
  });
});
