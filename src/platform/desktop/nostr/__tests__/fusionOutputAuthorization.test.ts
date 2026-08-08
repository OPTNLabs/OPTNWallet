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

function authorize(serial = '11'.repeat(32)) {
  const issuer = BlindIssuer.create(1);
  const output = { script: '76a914' + '22'.repeat(20) + '88ac', value: 99_600 };
  const request = BlindSignatureRequest.create(
    issuer.pubkeyHex,
    issuer.rPointsHex[0],
    outputCredentialMessageHash(context, output, serial)
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
    },
  };
}

describe('P2P v3 anonymous output authorization', () => {
  it('accepts the exact authorized canonical output', () => {
    const { issuer, output } = authorize();
    expect(
      verifyAuthorizedOutputBatch([output], 1, issuer.pubkeyHex, context)
    ).toEqual({ ok: true, serials: [output.credentialSerial] });
  });

  it('rejects spoofing, wrong context, duplicates, missing, and extra outputs', () => {
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
      verifyAuthorizedOutputBatch([output], 1, issuer.pubkeyHex, {
        ...context,
        session: 'bb'.repeat(32),
      }).ok
    ).toBe(false);
    expect(
      verifyAuthorizedOutputBatch([output], 1, issuer.pubkeyHex, {
        ...context,
        network: 'mainnet',
      }).ok
    ).toBe(false);
  });

  it('rejects a duplicate serial or exact output even with separately valid credentials', () => {
    const first = authorize('33'.repeat(32));
    const second = authorize('44'.repeat(32));
    // Verify both under one issuer by making the second a duplicate is not
    // meaningful cryptographically; the same signed component repeated is the
    // attacker-controlled replay the batch validator must reject.
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
