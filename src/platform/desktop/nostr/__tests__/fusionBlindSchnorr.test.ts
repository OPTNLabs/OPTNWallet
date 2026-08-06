import { describe, expect, it } from 'vitest';
import { sha256, binToHex } from '@bitauth/libauth';
import {
  BlindIssuer,
  BlindSignatureRequest,
  inputCredentialMessageHash,
  peerCredentialSlotBase,
  totalCredentialSlots,
  verifyBchSchnorrHex,
  CREDENTIAL_SLOTS_PER_PEER,
} from '../fusionBlindSchnorr';
import {
  pedersenBalanceHolds,
  pedersenCommit,
  sumNoncesHex,
} from '../fusionPedersen';

describe('P2P blind Schnorr credential issuer', () => {
  it('round-trips: request → issue → finalize → verify', () => {
    for (let i = 0; i < 10; i++) {
      const issuer = BlindIssuer.create(1);
      const msg = new Uint8Array(
        sha256.hash(new TextEncoder().encode(`component-${i}`))
      );
      const req = BlindSignatureRequest.create(
        issuer.pubkeyHex,
        issuer.rPointsHex[0],
        msg
      );
      const s = issuer.signHex(0, req.requestHex());
      const sig = req.finalizeHex(s, true);
      expect(verifyBchSchnorrHex(issuer.pubkeyHex, sig, binToHex(msg))).toBe(
        true
      );
    }
  });

  it('refuses to reuse a nonce slot (would leak the round key)', () => {
    const issuer = BlindIssuer.create(2);
    const e1 = '11'.repeat(32);
    const e2 = '22'.repeat(32);
    expect(() => issuer.signHex(0, e1)).not.toThrow();
    expect(() => issuer.signHex(0, e2)).toThrow(/already used/);
    expect(() => issuer.signHex(1, e2)).not.toThrow();
  });

  it('binds credentials to the input domain-separated hash', () => {
    const issuer = BlindIssuer.create(1);
    const input = {
      prevTxid: 'aa'.repeat(32),
      prevIndex: 1,
      value: 100_000,
      pubkey: `02${'33'.repeat(32)}`,
    };
    const msg = inputCredentialMessageHash(input);
    const req = BlindSignatureRequest.create(
      issuer.pubkeyHex,
      issuer.rPointsHex[0],
      msg
    );
    const sig = req.finalizeHex(issuer.signHex(0, req.requestHex()), true);
    // Wrong message must not verify.
    const other = inputCredentialMessageHash({ ...input, value: 99_999 });
    expect(
      verifyBchSchnorrHex(issuer.pubkeyHex, sig, binToHex(other))
    ).toBe(false);
  });

  it('allocates non-overlapping peer slot ranges', () => {
    const peers = ['bb'.repeat(32), 'aa'.repeat(32), 'cc'.repeat(32)];
    // Sorted: aa, bb, cc → bases 0, 16, 32
    expect(peerCredentialSlotBase(peers, 'aa'.repeat(32))).toBe(0);
    expect(peerCredentialSlotBase(peers, 'bb'.repeat(32))).toBe(
      CREDENTIAL_SLOTS_PER_PEER
    );
    expect(peerCredentialSlotBase(peers, 'cc'.repeat(32))).toBe(
      2 * CREDENTIAL_SLOTS_PER_PEER
    );
    expect(totalCredentialSlots(3)).toBe(3 * CREDENTIAL_SLOTS_PER_PEER);
  });
});

describe('P2P Pedersen balance check', () => {
  it('holds for a balanced input/output pair (homomorphic sum)', () => {
    // One input +value-fee, one output -value-fee → excess = fees only? 
    // input 100000 fee 141 @ 1000 sat/kB → fee 141, amount 99859
    // output 99000 fee 34 → amount -99034
    // excess = 99859 - 99034 = 825
    const inC = pedersenCommit(100_000 - 141);
    const outC = pedersenCommit(-(99_000 + 34));
    const excess = 100_000 - 141 - 99_000 - 34;
    const totalNonce = sumNoncesHex([inC.nonceHex, outC.nonceHex]);
    expect(
      pedersenBalanceHolds(
        [inC.commitmentHex, outC.commitmentHex],
        excess,
        totalNonce
      )
    ).toBe(true);
  });

  it('rejects a tampered excess fee', () => {
    const c = pedersenCommit(50_000);
    expect(
      pedersenBalanceHolds([c.commitmentHex], 50_001, c.nonceHex)
    ).toBe(false);
  });

  it('commits amount 0 and accepts excessFee 0 (identity ·H)', () => {
    // Blank components and exact fee coverage must not throw / false-blame.
    const blank = pedersenCommit(0);
    expect(blank.commitmentHex.length).toBeGreaterThan(0);
    expect(
      pedersenBalanceHolds([blank.commitmentHex], 0, blank.nonceHex)
    ).toBe(true);
  });
});
