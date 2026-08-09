import { describe, expect, it } from 'vitest';
import {
  createBlameReport,
  findFaultInDisclosures,
  formatBlameAbortReason,
  isBlameCode,
  verifyBlameReport,
  type BlameReport,
} from '../fusionBlame';
import {
  BlindIssuer,
  BlindSignatureRequest,
  CREDENTIAL_SLOTS_PER_PEER,
  inputCredentialMessageHash,
  peerCredentialSlotBase,
} from '../fusionBlindSchnorr';
import { pedersenCommit } from '../fusionPedersen';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const participants = [A, B, C];

describe('fusionBlame (prove-or-don\'t-blame)', () => {
  it('only accepts known blame codes (no timeout codes)', () => {
    expect(isBlameCode('invalid_input_credential')).toBe(true);
    expect(isBlameCode('pedersen_unbalanced')).toBe(true);
    expect(isBlameCode('timeout')).toBe(false);
    expect(isBlameCode('relay_ack')).toBe(false);
    expect(isBlameCode('late_join')).toBe(false);
  });

  it('rejects blame when session or accused is wrong', () => {
    const report = createBlameReport('sess', A, 'duplicate_outpoint', {
      kind: 'duplicate_outpoint',
      prevTxid: '11'.repeat(32),
      prevIndex: 0,
      claimants: [A, B],
    });
    expect(
      verifyBlameReport(report, { session: 'other', participants })
    ).toEqual({ ok: false, reason: 'session mismatch' });
    expect(
      verifyBlameReport(
        { ...report, accused: 'dd'.repeat(32) },
        { session: 'sess', participants }
      )
    ).toEqual({ ok: false, reason: 'accused not in participant set' });
  });

  it('verifies pedersen_unbalanced only when balance actually fails', () => {
    const { commitmentHex, nonceHex } = pedersenCommit(1000);
    const bad: BlameReport = createBlameReport('s', A, 'pedersen_unbalanced', {
      kind: 'pedersen_unbalanced',
      amountCommitments: [commitmentHex],
      pedersenTotalNonce: nonceHex,
      excessFee: 999_999_999,
    });
    expect(verifyBlameReport(bad, { session: 's', participants })).toEqual({
      ok: true,
    });

    const balanced = createBlameReport('s', A, 'pedersen_unbalanced', {
      kind: 'pedersen_unbalanced',
      amountCommitments: [commitmentHex],
      pedersenTotalNonce: nonceHex,
      excessFee: 1000,
    });
    expect(
      verifyBlameReport(balanced, { session: 's', participants })
    ).toEqual({ ok: false, reason: 'pedersen actually balanced' });
  });

  it('verifies credential_slot_oob for slots outside peer range', () => {
    const base = peerCredentialSlotBase(participants, B);
    const report = createBlameReport('s', B, 'credential_slot_oob', {
      kind: 'credential_slot_oob',
      slots: [base + CREDENTIAL_SLOTS_PER_PEER],
      participants: [...participants],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });

    const inRange = createBlameReport('s', B, 'credential_slot_oob', {
      kind: 'credential_slot_oob',
      slots: [base],
      participants: [...participants],
    });
    expect(
      verifyBlameReport(inRange, { session: 's', participants })
    ).toEqual({ ok: false, reason: 'all slots in range' });
  });

  it('verifies invalid_input_credential when sig is garbage', () => {
    const issuer = BlindIssuer.create(48);
    const input = {
      prevTxid: '11'.repeat(32),
      prevIndex: 0,
      value: 10_000,
      pubkey: '02' + 'ab'.repeat(32),
    };
    const badSig = '00'.repeat(64);
    const report = createBlameReport('s', A, 'invalid_input_credential', {
      kind: 'invalid_input_credential',
      roundPubkey: issuer.pubkeyHex,
      inputs: [input],
      credentialSigs: [badSig],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });
  });

  it('verifies invalid_input_credential when a post-abort opening fails (C4)', () => {
    const issuer = BlindIssuer.create(48);
    const input = {
      prevTxid: '33'.repeat(32),
      prevIndex: 2,
      value: 50_000,
      pubkey: '03' + 'cd'.repeat(32),
    };
    const report = createBlameReport('s', A, 'invalid_input_credential', {
      kind: 'invalid_input_credential',
      roundPubkey: issuer.pubkeyHex,
      inputs: [input],
      credentialSigs: [],
      failedOpenings: [
        {
          outpoint: `${input.prevTxid}:${input.prevIndex}`,
          slotIndex: 0,
          openingHex: 'ab'.repeat(64),
          requestHex: '11'.repeat(32),
          rPointHex: issuer.rPointsHex[0],
          saltCommitmentHex: '77'.repeat(32),
        },
      ],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });
  });

  it('rejects invalid_input_credential opening evidence if the opening actually verifies', () => {
    const issuer = BlindIssuer.create(48);
    const input = {
      prevTxid: '44'.repeat(32),
      prevIndex: 0,
      value: 10_000,
      pubkey: '02' + '11'.repeat(32),
    };
    const salt = '88'.repeat(32);
    const req = BlindSignatureRequest.create(
      issuer.pubkeyHex,
      issuer.rPointsHex[0],
      inputCredentialMessageHash(input, salt)
    );
    const report = createBlameReport('s', A, 'invalid_input_credential', {
      kind: 'invalid_input_credential',
      roundPubkey: issuer.pubkeyHex,
      inputs: [input],
      credentialSigs: [],
      failedOpenings: [
        {
          outpoint: `${input.prevTxid}:${input.prevIndex}`,
          slotIndex: 0,
          openingHex: req.openingHex(),
          requestHex: req.requestHex(),
          rPointHex: issuer.rPointsHex[0],
          saltCommitmentHex: salt,
        },
      ],
    });
    expect(
      verifyBlameReport(report, { session: 's', participants }).ok
    ).toBe(false);
  });

  it('verifies duplicate_outpoint with two claimants', () => {
    const report = createBlameReport('s', A, 'duplicate_outpoint', {
      kind: 'duplicate_outpoint',
      prevTxid: '22'.repeat(32),
      prevIndex: 1,
      claimants: [A, B],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });
  });

  it('verifies invalid_signature_set when sets differ', () => {
    const report = createBlameReport('s', A, 'invalid_signature_set', {
      kind: 'invalid_signature_set',
      expectedOutpoints: ['aa:0', 'bb:1'],
      receivedOutpoints: ['aa:0'],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });
    const same = createBlameReport('s', A, 'invalid_signature_set', {
      kind: 'invalid_signature_set',
      expectedOutpoints: ['aa:0'],
      receivedOutpoints: ['aa:0'],
    });
    expect(verifyBlameReport(same, { session: 's', participants })).toEqual({
      ok: false,
      reason: 'signature sets actually match',
    });
  });

  it('formatBlameAbortReason is clear and not a network timeout', () => {
    const report = createBlameReport('s', A, 'duplicate_outpoint', {
      kind: 'duplicate_outpoint',
      prevTxid: '33'.repeat(32),
      prevIndex: 0,
      claimants: [A, B],
    });
    const text = formatBlameAbortReason(report);
    expect(text).toMatch(/Protocol fault/);
    expect(text).toMatch(/Not a network timeout/);
    expect(text).not.toMatch(/relay did not acknowledge/i);
  });
});

describe('findFaultInDisclosures (post-abort blame phase)', () => {
  const participants = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
  const [alice, bob] = participants;
  const outpointA = `${'11'.repeat(32)}:0`;
  const outpointB = `${'22'.repeat(32)}:1`;

  it('finds nothing when disclosures are consistent and all inputs signed', () => {
    const finding = findFaultInDisclosures({
      participants,
      disclosures: new Map([
        [alice, { outpoints: [outpointA], serials: [] }],
        [bob, { outpoints: [outpointB], serials: [] }],
      ]),
      signedOutpoints: new Set([outpointA, outpointB]),
    });
    // A timeout is not a provable component fault — do not manufacture blame.
    expect(finding).toBeNull();
  });

  it('attributes a duplicate outpoint that anonymous components hid', () => {
    const finding = findFaultInDisclosures({
      participants,
      disclosures: new Map([
        [alice, { outpoints: [outpointA], serials: [] }],
        [bob, { outpoints: [outpointA], serials: [] }],
      ]),
      signedOutpoints: new Set([outpointA]),
    });
    expect(finding?.code).toBe('duplicate_outpoint');
    expect(participants).toContain(finding?.accused);
    expect(
      (finding?.evidence as { claimants: string[] }).claimants.sort()
    ).toEqual([alice, bob].sort());
  });

  /**
   * Registration fail-closed: `acceptInputs` throws `duplicate outpoint in round`
   * before a second peer can enter the anonymous pool with the same outpoint.
   * So live E2E rarely reaches two verified disclosures of the same outpoint —
   * this pure rule + verifyBlameReport is the lock for that code. The second
   * claimant is still attributable if both ever disclose (e.g. race / future path).
   */
  it('duplicate_outpoint report is re-verifiable (registration is primary live gate)', () => {
    const report = createBlameReport('s', bob, 'duplicate_outpoint', {
      kind: 'duplicate_outpoint',
      prevTxid: '11'.repeat(32),
      prevIndex: 0,
      claimants: [alice, bob],
    });
    expect(verifyBlameReport(report, { session: 's', participants })).toEqual({
      ok: true,
    });
  });

  it('names the peer that registered inputs and then withheld signatures', () => {
    const finding = findFaultInDisclosures({
      participants,
      disclosures: new Map([
        [alice, { outpoints: [outpointA], serials: [] }],
        [bob, { outpoints: [outpointB], serials: [] }],
      ]),
      signedOutpoints: new Set([outpointA]),
    });
    expect(finding?.code).toBe('invalid_signature_set');
    expect(finding?.accused).toBe(bob);
  });

  // The whole point: the report must survive the verifier that rejected the
  // old anonymous-sender blame attempts.
  it('produces a report that verifyBlameReport accepts', () => {
    const finding = findFaultInDisclosures({
      participants,
      disclosures: new Map([
        [alice, { outpoints: [outpointA], serials: [] }],
        [bob, { outpoints: [outpointA], serials: [] }],
      ]),
      signedOutpoints: new Set([outpointA]),
    });
    expect(finding).not.toBeNull();
    const report = createBlameReport(
      'session-1',
      finding!.accused,
      finding!.code,
      finding!.evidence
    );
    expect(
      verifyBlameReport(report, { session: 'session-1', participants }).ok
    ).toBe(true);
  });
});
