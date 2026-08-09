import { describe, expect, it } from 'vitest';
import { sha256, binToHex } from '@bitauth/libauth';
import {
  BlindIssuer,
  BlindSignatureRequest,
  inputCredentialMessageHash,
  outputCredentialMessageHash,
  peerCredentialSlotBase,
  totalCredentialSlots,
  verifyBchSchnorrHex,
  verifyCredentialOpening,
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
    const salt = '11'.repeat(32);
    const msg = inputCredentialMessageHash(input, salt);
    const req = BlindSignatureRequest.create(
      issuer.pubkeyHex,
      issuer.rPointsHex[0],
      msg
    );
    const sig = req.finalizeHex(issuer.signHex(0, req.requestHex()), true);
    // Wrong message must not verify.
    const other = inputCredentialMessageHash({ ...input, value: 99_999 }, salt);
    expect(verifyBchSchnorrHex(issuer.pubkeyHex, sig, binToHex(other))).toBe(
      false
    );
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

  it('binds an anonymous output credential to the EC component (script/value/salt)', () => {
    const issuer = BlindIssuer.create(1);
    const context = {
      session: 'ab'.repeat(32),
      network: 'chipnet' as const,
      tier: 100_000,
    };
    const output = {
      script: '76a914' + '11'.repeat(20) + '88ac',
      value: 99_600,
    };
    const serial = 'cd'.repeat(32);
    const salt = '22'.repeat(32);
    const message = outputCredentialMessageHash(
      context,
      output,
      serial,
      salt
    );
    const request = BlindSignatureRequest.create(
      issuer.pubkeyHex,
      issuer.rPointsHex[0],
      message
    );
    const signature = request.finalizeHex(
      issuer.signHex(0, request.requestHex()),
      true
    );

    expect(
      verifyBchSchnorrHex(issuer.pubkeyHex, signature, binToHex(message))
    ).toBe(true);
    // Session/network are not in the EC component hash (transport binds them).
    expect(
      verifyBchSchnorrHex(
        issuer.pubkeyHex,
        signature,
        binToHex(
          outputCredentialMessageHash(
            { ...context, session: 'ef'.repeat(32) },
            output,
            serial,
            salt
          )
        )
      )
    ).toBe(true);
    expect(
      verifyBchSchnorrHex(
        issuer.pubkeyHex,
        signature,
        binToHex(
          outputCredentialMessageHash(
            context,
            { ...output, value: output.value - 1 },
            serial,
            salt
          )
        )
      )
    ).toBe(false);
    expect(
      verifyBchSchnorrHex(
        issuer.pubkeyHex,
        signature,
        binToHex(
          outputCredentialMessageHash(context, output, serial, '33'.repeat(32))
        )
      )
    ).toBe(false);
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
    expect(pedersenBalanceHolds([c.commitmentHex], 50_001, c.nonceHex)).toBe(
      false
    );
  });

  it('commits amount 0 and accepts excessFee 0 (identity ·H)', () => {
    // Blank components and exact fee coverage must not throw / false-blame.
    const blank = pedersenCommit(0);
    expect(blank.commitmentHex.length).toBeGreaterThan(0);
    expect(pedersenBalanceHolds([blank.commitmentHex], 0, blank.nonceHex)).toBe(
      true
    );
  });
});

describe('credential opening verifier (post-abort blame proof)', () => {
  const msgFor = (label: string) =>
    new Uint8Array(sha256.hash(new TextEncoder().encode(label)));

  /** One issued slot plus everything a verifier is given about it. */
  function slot(label = 'component-a', slotIndex = 0) {
    const issuer = BlindIssuer.create(4);
    const messageHash = msgFor(label);
    const request = BlindSignatureRequest.create(
      issuer.pubkeyHex,
      issuer.rPointsHex[slotIndex],
      messageHash
    );
    return {
      issuer,
      messageHash,
      request,
      args: {
        roundPubkeyHex: issuer.pubkeyHex,
        rPointHex: issuer.rPointsHex[slotIndex],
        messageHash,
        openingHex: request.openingHex(),
        requestHex: request.requestHex(),
      },
    };
  }

  it('accepts the opening the requester actually derived', () => {
    for (let i = 0; i < 5; i++) {
      expect(verifyCredentialOpening(slot(`component-${i}`).args)).toBe(true);
    }
  });

  it('rejects a forged opening — a griefer cannot invent one', () => {
    const { args } = slot();
    const forged = { ...args, openingHex: 'ab'.repeat(64) };
    expect(verifyCredentialOpening(forged)).toBe(false);
  });

  it('rejects an opening replayed onto a different message', () => {
    const { args } = slot('component-mine');
    // The attack this closes: claim a component you never requested by reusing
    // your own valid opening against someone else's outpoint.
    const stolen = { ...args, messageHash: msgFor('component-someone-else') };
    expect(verifyCredentialOpening(stolen)).toBe(false);
  });

  it('rejects an opening replayed onto a different slot', () => {
    const honest = slot('component-a', 0);
    // Same round, same message, but pointing at a nonce the coordinator handed
    // to a different slot — this is how a peer would dodge its own fault.
    const wrongSlot = {
      ...honest.args,
      rPointHex: honest.issuer.rPointsHex[1],
    };
    expect(verifyCredentialOpening(wrongSlot)).toBe(false);
  });

  it('rejects a mismatched blinded challenge', () => {
    const { args } = slot();
    const other = slot('component-other');
    expect(
      verifyCredentialOpening({ ...args, requestHex: other.args.requestHex })
    ).toBe(false);
  });

  it('returns false rather than throwing on malformed attacker bytes', () => {
    const { args } = slot();
    const cases = [
      { ...args, openingHex: 'ff'.repeat(10) },
      { ...args, openingHex: '00'.repeat(64) }, // zero scalars
      { ...args, requestHex: 'ff'.repeat(8) },
      { ...args, rPointHex: 'not-a-point' },
      { ...args, roundPubkeyHex: '02'.repeat(33) },
      { ...args, messageHash: new Uint8Array(16) },
    ];
    for (const bad of cases) {
      expect(() => verifyCredentialOpening(bad)).not.toThrow();
      expect(verifyCredentialOpening(bad)).toBe(false);
    }
  });
});
