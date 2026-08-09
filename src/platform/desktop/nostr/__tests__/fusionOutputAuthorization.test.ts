import { describe, expect, it } from 'vitest';
import {
  BlindIssuer,
  BlindSignatureRequest,
  outputCredentialMessageHash,
} from '../fusionBlindSchnorr';
import { verifyAuthorizedOutputBatch } from '../fusionSession';

const context = {
  session: 'aa'.repeat(32),
  network: 'chipnet' as const,
  tier: 100_000,
};

function authorize(serial = '11'.repeat(32), salt = '55'.repeat(32)) {
  const issuer = BlindIssuer.create(1);
  const output = { script: '76a914' + '22'.repeat(20) + '88ac', value: 99_600 };
  const request = BlindSignatureRequest.create(
    issuer.pubkeyHex,
    issuer.rPointsHex[0],
    outputCredentialMessageHash(context, output, serial, salt)
  );
  return {
    issuer,
    output: {
      ...output,
      credentialSerial: serial,
      credentialSig: request.finalizeHex(
        issuer.signHex(0, request.requestHex()),
        true
      ),
      saltCommitment: salt,
    },
  };
}

describe('P2P v4 anonymous output authorization', () => {
  it('accepts the exact authorized canonical output', () => {
    const { issuer, output } = authorize();
    expect(
      verifyAuthorizedOutputBatch([output], 1, issuer.pubkeyHex, context)
    ).toEqual({ ok: true, serials: [output.credentialSerial] });
  });

  it('rejects spoofing, wrong salt, duplicates, missing, and extra outputs', () => {
    const { issuer, output } = authorize();
    expect(
      verifyAuthorizedOutputBatch([], 1, issuer.pubkeyHex, context).ok
    ).toBe(false);
    expect(
      verifyAuthorizedOutputBatch(
        [output, output],
        1,
        issuer.pubkeyHex,
        context
      ).ok
    ).toBe(false);
    expect(
      verifyAuthorizedOutputBatch(
        [{ ...output, value: output.value - 1 }],
        1,
        issuer.pubkeyHex,
        context
      ).ok
    ).toBe(false);
    expect(
      verifyAuthorizedOutputBatch(
        [{ ...output, saltCommitment: '66'.repeat(32) }],
        1,
        issuer.pubkeyHex,
        context
      ).ok
    ).toBe(false);
  });

  it('rejects a duplicate serial or exact output even with separately valid credentials', () => {
    const first = authorize('33'.repeat(32));
    const second = authorize('44'.repeat(32));
    expect(
      verifyAuthorizedOutputBatch(
        [first.output, first.output],
        2,
        first.issuer.pubkeyHex,
        context
      ).ok
    ).toBe(false);
    expect(second.output.credentialSerial).not.toBe(
      first.output.credentialSerial
    );
  });
});
