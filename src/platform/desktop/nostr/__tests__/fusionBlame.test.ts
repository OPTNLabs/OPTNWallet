import { describe, expect, it } from 'vitest';
import {
  createBlameReport,
  formatBlameAbortReason,
  isBlameCode,
  verifyBlameReport,
  type BlameReport,
} from '../fusionBlame';
import {
  BlindIssuer,
  peerCredentialSlotBase,
  CREDENTIAL_SLOTS_PER_PEER,
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
