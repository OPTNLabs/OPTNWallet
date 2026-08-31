// Does the CashFusion core, reached through wasm from JavaScript, produce the
// same values as the shared vectors?
//
// The Rust core and this browser binding both read test-vectors/fusion.json.
// A binding is exactly where agreement can quietly fail: a wrong argument
// order or missed length check does not fail to compile, it returns a plausible
// wrong answer.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ensureOptnCore,
  fusionBlindRequest,
  fusionBlindIssuerNoncePoint,
  fusionBlindIssuerPublicKey,
  fusionBlindIssuerSign,
  fusionFinalizeBlindSignature,
  fusionPedersenBalanceHolds,
  fusionPedersenCommit,
  fusionPedersenH,
  fusionScalarIsCanonical,
  fusionScalarSum,
  fusionVerifySchnorr,
} from '..';

type FusionVectors = {
  pedersen: {
    hCompressedHex: string;
    commitments: { amount: number; nonceHex: string; commitmentHex: string }[];
  };
  schnorr: {
    signatures: {
      label: string;
      pubkeyHex: string;
      messageHex: string;
      signatureHex: string;
    }[];
    blind: {
      roundPubkeyHex: string;
      rPointHex: string;
      messageHex: string;
      blindAHex: string;
      blindBHex: string;
      blindedChallengeHex: string;
      issuerResponseHex: string;
      signatureHex: string;
    }[];
  };
};

const vectors = JSON.parse(
  readFileSync('test-vectors/fusion.json', 'utf8')
) as FusionVectors;

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hex(value: Uint8Array): string {
  return [...value].map((b) => b.toString(16).padStart(2, '0')).join('');
}

ensureOptnCore();

describe('optn-core fusion bindings through wasm', () => {
  it('has vectors to check', () => {
    expect(vectors.schnorr.signatures.length).toBeGreaterThan(0);
    expect(vectors.schnorr.blind.length).toBeGreaterThan(0);
    expect(vectors.pedersen.commitments.length).toBeGreaterThan(0);
  });

  it('verifies the stored signatures', () => {
    for (const vector of vectors.schnorr.signatures) {
      expect(
        fusionVerifySchnorr(
          bytes(vector.pubkeyHex),
          bytes(vector.signatureHex),
          bytes(vector.messageHex)
        ),
        `signature for "${vector.label}"`
      ).toBe(true);
    }
  });

  it('rejects a tampered signature', () => {
    // Keeps the check above from being vacuous.
    const vector = vectors.schnorr.signatures[0];
    const tampered = bytes(vector.signatureHex);
    tampered[tampered.length - 1] ^= 0x01;
    expect(
      fusionVerifySchnorr(
        bytes(vector.pubkeyHex),
        tampered,
        bytes(vector.messageHex)
      )
    ).toBe(false);
  });

  it('reproduces Pedersen commitments byte for byte', () => {
    for (const vector of vectors.pedersen.commitments) {
      expect(
        hex(
          fusionPedersenCommit(BigInt(vector.amount), bytes(vector.nonceHex))
        ),
        `commitment for ${vector.amount} sats`
      ).toBe(vector.commitmentHex);
    }
  });

  it('agrees on the nothing-up-my-sleeve generator H', () => {
    expect(hex(fusionPedersenH())).toBe(vectors.pedersen.hCompressedHex);
  });

  it('rebuilds the blinded challenge and unblinds to the stored signature', () => {
    // The whole blind flow, driven from JS with the vector's own blinding
    // factors. If the binding mis-ordered `a` and `b`, or dropped one, the
    // challenge would differ here rather than at round time.
    for (const vector of vectors.schnorr.blind) {
      const request = fusionBlindRequest(
        bytes(vector.roundPubkeyHex),
        bytes(vector.rPointHex),
        bytes(vector.messageHex),
        bytes(vector.blindAHex),
        bytes(vector.blindBHex)
      );
      expect(hex(request)).toBe(vector.blindedChallengeHex);

      const signature = fusionFinalizeBlindSignature(
        bytes(vector.roundPubkeyHex),
        bytes(vector.rPointHex),
        bytes(vector.messageHex),
        bytes(vector.blindAHex),
        bytes(vector.blindBHex),
        bytes(vector.issuerResponseHex)
      );
      expect(hex(signature)).toBe(vector.signatureHex);
    }
  });

  it('refuses a non-canonical scalar rather than reducing it', () => {
    // A silently reduced nonce would commit to something the opener cannot
    // reproduce, and the mismatch would only appear during blame.
    expect(() =>
      fusionPedersenCommit(1n, new Uint8Array(32).fill(0xff))
    ).toThrow();
    expect(() => fusionPedersenCommit(1n, new Uint8Array(32))).toThrow();
  });

  it('keeps scalar validation and addition in the Rust core', () => {
    const one = bytes('00'.repeat(31) + '01');
    const two = bytes('00'.repeat(31) + '02');

    expect(fusionScalarIsCanonical(one)).toBe(true);
    expect(fusionScalarIsCanonical(new Uint8Array(32))).toBe(false);
    expect(fusionScalarIsCanonical(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(hex(fusionScalarSum(Uint8Array.from([...one, ...two])))).toBe(
      '00'.repeat(31) + '03'
    );
  });

  it('performs the live issuer key, nonce, and signing math in Rust', () => {
    const one = bytes('00'.repeat(31) + '01');
    const two = bytes('00'.repeat(31) + '02');
    const three = bytes('00'.repeat(31) + '03');

    expect(hex(fusionBlindIssuerPublicKey(one))).toBe(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    );
    expect(fusionBlindIssuerNoncePoint(two)).toHaveLength(33);
    // s = k + e*x = 2 + 3*1 = 5.
    expect(hex(fusionBlindIssuerSign(one, two, three))).toBe(
      '00'.repeat(31) + '05'
    );
  });

  it('checks a published Pedersen commitment in Rust', () => {
    const vector = vectors.pedersen.commitments[0];
    const packed = bytes(vector.commitmentHex);
    expect(
      fusionPedersenBalanceHolds(
        packed,
        BigInt(vector.amount),
        bytes(vector.nonceHex)
      )
    ).toBe(true);
    expect(
      fusionPedersenBalanceHolds(
        packed,
        BigInt(vector.amount + 1),
        bytes(vector.nonceHex)
      )
    ).toBe(false);
  });
});
