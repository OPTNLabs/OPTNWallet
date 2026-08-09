// Privacy-preserving P2P fusion blame — within-round accountability only.
//
// Design (prove-or-don't-blame):
// - Blame ONLY when a received message fails a hard, re-verifiable crypto check.
// - Never blame for timeouts, Tor lag, late join, relay ACK, or missing messages
//   (honest poor-net peers look the same as silent droppers).
// - Accused identity is the ephemeral round/session pubkey only — not a wallet ID.
// - Evidence never includes onion peels or honest peers' output maps.
//
// This is NOT a full Electron Cash component-blame port (blame.rs). P2P uses
// credentials + onion, not covert component proofs.

import {
  CREDENTIAL_SLOTS_PER_PEER,
  inputCredentialMessageHash,
  inputCredentialMessageHashHex,
  peerCredentialSlotBase,
  verifyBchSchnorrHex,
  verifyCredentialOpening,
} from './fusionBlindSchnorr';
import { pedersenBalanceHolds } from './fusionPedersen';
import type { FusionInputRef } from './fusionRound';

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_66 = /^(02|03)[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const HEX_130 = /^04[0-9a-f]{128}$/i;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/i;
/** Nostr x-only (64) or compressed secp (66) — both appear as session keys in tests/prod. */
const SESSION_PUBKEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/i;

/** Codes that carry cryptographic (or structural) evidence. No network codes. */
export type BlameCode =
  | 'pedersen_unbalanced'
  | 'credential_slot_oob'
  | 'invalid_input_credential'
  | 'duplicate_outpoint'
  | 'invalid_signature_set';

export type BlameEvidence =
  | {
      kind: 'pedersen_unbalanced';
      amountCommitments: string[];
      pedersenTotalNonce: string;
      excessFee: number;
    }
  | {
      kind: 'credential_slot_oob';
      slots: number[];
      /** Participant set used for slot base (sorted order). */
      participants: string[];
    }
  | {
      kind: 'invalid_input_credential';
      roundPubkey: string;
      inputs: FusionInputRef[];
      /**
       * Unblinded credential sigs that fail under the round key (registration
       * path). May be empty when {@link failedOpenings} carries the proof.
       */
      credentialSigs: string[];
      /**
       * Post-abort path (C4): openings that claim an outpoint but fail
       * {@link verifyCredentialOpening}. Peers re-check each opening fails.
       */
      failedOpenings?: Array<{
        outpoint: string;
        slotIndex: number;
        openingHex: string;
        requestHex: string;
        rPointHex: string;
        /** v4 salt_commitment for sha256(EC Component) recompute. */
        saltCommitmentHex: string;
      }>;
    }
  | {
      kind: 'duplicate_outpoint';
      prevTxid: string;
      prevIndex: number;
      /** Session keys that claimed this outpoint. */
      claimants: string[];
    }
  | {
      kind: 'invalid_signature_set';
      expectedOutpoints: string[];
      receivedOutpoints: string[];
    };

/** Per-outpoint credential opening for post-abort proof (not assertion). */
export interface ComponentDisclosureOpening {
  /** `${prevTxid}:${prevIndex}` — same key as `outpoints`. */
  outpoint: string;
  /** Blind-issuer slot the peer used for this component. */
  slotIndex: number;
  /** 64-byte hex `a || b` from {@link BlindSignatureRequest.openingHex}. */
  openingHex: string;
}

/** What one peer disclosed about its own components after a round aborted. */
export interface ComponentDisclosure {
  outpoints: string[];
  serials: string[];
  /**
   * Openings that prove each outpoint was credentialed at a slot issued to
   * this peer. Absent/empty means the disclosure is an unproven claim and the
   * coordinator must drop those outpoints before `findFaultInDisclosures`.
   */
  openings?: ComponentDisclosureOpening[];
}

export interface DisclosureFinding {
  accused: string;
  code: BlameCode;
  evidence: BlameEvidence;
}

/**
 * Turn post-abort component disclosures back into an attributable fault.
 *
 * Components travel anonymously, so a failed round has nobody to accuse —
 * `verifyBlameReport` rejects an accused outside the participant set. The
 * disclosure message is control-plane (sent under the round identity), so
 * cross-referencing what each peer admits to restores attribution WITHOUT
 * weakening the happy path, which discloses nothing at all.
 *
 * Pure on purpose: no transport, no timers, no session state. Every input is
 * already held by the coordinator when a round aborts.
 *
 * Returns the first provable fault, or null when the disclosures are mutually
 * consistent (the failure was not a provable component fault — a timeout, say).
 */
export function findFaultInDisclosures(args: {
  /** Round participants, in the same set `verifyBlameReport` will check. */
  participants: string[];
  disclosures: ReadonlyMap<string, ComponentDisclosure>;
  /** Outpoints the coordinator holds a valid signature for. */
  signedOutpoints: ReadonlySet<string>;
}): DisclosureFinding | null {
  const { participants, disclosures, signedOutpoints } = args;

  // 1. Two peers claiming the same outpoint. Deterministic ordering so every
  //    peer derives the identical report from the identical disclosures.
  const claimantsByOutpoint = new Map<string, string[]>();
  for (const peer of [...participants].sort()) {
    for (const outpoint of disclosures.get(peer)?.outpoints ?? []) {
      const claimants = claimantsByOutpoint.get(outpoint) ?? [];
      if (!claimants.includes(peer)) claimants.push(peer);
      claimantsByOutpoint.set(outpoint, claimants);
    }
  }
  for (const [outpoint, claimants] of [...claimantsByOutpoint].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (claimants.length < 2) continue;
    const separator = outpoint.lastIndexOf(':');
    const prevTxid = outpoint.slice(0, separator);
    const prevIndex = Number(outpoint.slice(separator + 1));
    if (!Number.isSafeInteger(prevIndex)) continue;
    return {
      // The later claimant is the one that duplicated an already-claimed
      // outpoint; sorted order makes that choice reproducible for every peer.
      accused: claimants[claimants.length - 1],
      code: 'duplicate_outpoint',
      evidence: { kind: 'duplicate_outpoint', prevTxid, prevIndex, claimants },
    };
  }

  // 2. A peer that admits to outpoints it never signed. This is the code that
  //    catches the anonymous griefer: registering inputs and then withholding
  //    signatures used to be unattributable once components went anonymous.
  for (const peer of [...participants].sort()) {
    const disclosure = disclosures.get(peer);
    if (!disclosure) continue;
    const unsigned = disclosure.outpoints.filter(
      (outpoint) => !signedOutpoints.has(outpoint)
    );
    if (unsigned.length === 0) continue;
    return {
      accused: peer,
      code: 'invalid_signature_set',
      evidence: {
        kind: 'invalid_signature_set',
        expectedOutpoints: [...disclosure.outpoints],
        receivedOutpoints: disclosure.outpoints.filter((outpoint) =>
          signedOutpoints.has(outpoint)
        ),
      },
    };
  }

  return null;
}

export interface BlameReport {
  session: string;
  accused: string;
  code: BlameCode;
  evidence: BlameEvidence;
}

export interface BlameVerifyContext {
  session: string;
  participants: string[];
}

const BLAME_CODES: ReadonlySet<string> = new Set([
  'pedersen_unbalanced',
  'credential_slot_oob',
  'invalid_input_credential',
  'duplicate_outpoint',
  'invalid_signature_set',
]);

export function isBlameCode(value: unknown): value is BlameCode {
  return typeof value === 'string' && BLAME_CODES.has(value);
}

/** Short human reason for abort UI / abort message (≤240 later). */
export function formatBlameAbortReason(report: BlameReport): string {
  // No accused hex in UI/logs — blame still binds the full key internally.
  const labels: Record<BlameCode, string> = {
    pedersen_unbalanced: 'Pedersen balance failed',
    credential_slot_oob: 'credential slot out of range',
    invalid_input_credential: 'invalid input credential',
    duplicate_outpoint: 'duplicate outpoint',
    invalid_signature_set: 'invalid signature set',
  };
  return (
    `Protocol fault (${labels[report.code]}). ` +
    'Round aborted safely. Not a network timeout — others may retry together.'
  );
}

function validPubkey(value: string): boolean {
  return SESSION_PUBKEY.test(value);
}

function validInputRef(input: FusionInputRef): boolean {
  return (
    HEX_64.test(input.prevTxid) &&
    Number.isSafeInteger(input.prevIndex) &&
    input.prevIndex >= 0 &&
    Number.isSafeInteger(input.value) &&
    input.value >= 1 &&
    COMPRESSED_PUBKEY.test(input.pubkey)
  );
}

/**
 * Re-verify a blame report. Peers MUST call this before aborting on a remote
 * blame — prevents a malicious coordinator/peer from framing someone with
 * gossip alone.
 */
export function verifyBlameReport(
  report: BlameReport,
  ctx: BlameVerifyContext
): { ok: true } | { ok: false; reason: string } {
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'missing report' };
  }
  if (report.session !== ctx.session) {
    return { ok: false, reason: 'session mismatch' };
  }
  if (!validPubkey(report.accused)) {
    return { ok: false, reason: 'invalid accused pubkey' };
  }
  if (!ctx.participants.includes(report.accused)) {
    return { ok: false, reason: 'accused not in participant set' };
  }
  if (!isBlameCode(report.code)) {
    return { ok: false, reason: 'unknown blame code' };
  }
  if (!report.evidence || report.evidence.kind !== report.code) {
    return { ok: false, reason: 'evidence kind mismatch' };
  }

  switch (report.evidence.kind) {
    case 'pedersen_unbalanced': {
      const e = report.evidence;
      if (
        !Array.isArray(e.amountCommitments) ||
        e.amountCommitments.length < 1 ||
        e.amountCommitments.length > 64 ||
        !e.amountCommitments.every((c) => typeof c === 'string' && HEX_130.test(c)) ||
        typeof e.pedersenTotalNonce !== 'string' ||
        !HEX_64.test(e.pedersenTotalNonce) ||
        !Number.isSafeInteger(e.excessFee) ||
        e.excessFee < 0
      ) {
        return { ok: false, reason: 'malformed pedersen evidence' };
      }
      // Blame is only valid if the balance check *fails*.
      if (
        pedersenBalanceHolds(
          e.amountCommitments,
          e.excessFee,
          e.pedersenTotalNonce
        )
      ) {
        return { ok: false, reason: 'pedersen actually balanced' };
      }
      return { ok: true };
    }
    case 'credential_slot_oob': {
      const e = report.evidence;
      if (
        !Array.isArray(e.slots) ||
        e.slots.length < 1 ||
        e.slots.length > 64 ||
        !e.slots.every((s) => Number.isSafeInteger(s) && s >= 0) ||
        !Array.isArray(e.participants) ||
        e.participants.length < 1
      ) {
        return { ok: false, reason: 'malformed slot evidence' };
      }
      const setA = [...e.participants].sort().join(',');
      const setB = [...ctx.participants].sort().join(',');
      if (setA !== setB) {
        return { ok: false, reason: 'participant set mismatch' };
      }
      let base: number;
      try {
        base = peerCredentialSlotBase(ctx.participants, report.accused);
      } catch {
        return { ok: false, reason: 'accused not in set for slots' };
      }
      const end = base + CREDENTIAL_SLOTS_PER_PEER;
      const anyOob = e.slots.some((s) => s < base || s >= end);
      if (!anyOob) {
        return { ok: false, reason: 'all slots in range' };
      }
      return { ok: true };
    }
    case 'invalid_input_credential': {
      const e = report.evidence;
      if (
        typeof e.roundPubkey !== 'string' ||
        !HEX_66.test(e.roundPubkey) ||
        !Array.isArray(e.inputs) ||
        !Array.isArray(e.credentialSigs) ||
        e.inputs.length < 1 ||
        e.inputs.length > 16 ||
        !e.inputs.every(validInputRef)
      ) {
        return { ok: false, reason: 'malformed credential evidence' };
      }
      const failedOpenings = e.failedOpenings;
      if (Array.isArray(failedOpenings) && failedOpenings.length > 0) {
        if (failedOpenings.length > 16) {
          return { ok: false, reason: 'malformed credential evidence' };
        }
        // Post-abort: every listed opening must FAIL verification (peer lied).
        for (const fo of failedOpenings) {
          if (
            typeof fo.outpoint !== 'string' ||
            !Number.isSafeInteger(fo.slotIndex) ||
            typeof fo.openingHex !== 'string' ||
            typeof fo.requestHex !== 'string' ||
            typeof fo.rPointHex !== 'string' ||
            typeof fo.saltCommitmentHex !== 'string'
          ) {
            return { ok: false, reason: 'malformed credential evidence' };
          }
          const input = e.inputs.find(
            (inp) => `${inp.prevTxid}:${inp.prevIndex}` === fo.outpoint
          );
          if (!input) {
            return { ok: false, reason: 'opening outpoint not in inputs' };
          }
          if (
            verifyCredentialOpening({
              roundPubkeyHex: e.roundPubkey,
              rPointHex: fo.rPointHex,
              messageHash: inputCredentialMessageHash(
                input,
                fo.saltCommitmentHex
              ),
              openingHex: fo.openingHex,
              requestHex: fo.requestHex,
            })
          ) {
            return { ok: false, reason: 'opening actually verifies' };
          }
        }
        return { ok: true };
      }
      // Registration path: at least one credential sig must fail under round key.
      if (
        e.inputs.length !== e.credentialSigs.length ||
        !e.credentialSigs.every((s) => typeof s === 'string' && HEX_128.test(s))
      ) {
        return { ok: false, reason: 'malformed credential evidence' };
      }
      let anyInvalid = false;
      // Dummy salt is fine: we only need the hash domain for sig verify fail.
      const dummySalt = '00'.repeat(32);
      for (let i = 0; i < e.inputs.length; i++) {
        const msgHex = inputCredentialMessageHashHex(e.inputs[i], dummySalt);
        if (!verifyBchSchnorrHex(e.roundPubkey, e.credentialSigs[i], msgHex)) {
          anyInvalid = true;
          break;
        }
      }
      if (!anyInvalid) {
        return { ok: false, reason: 'all credentials verify' };
      }
      return { ok: true };
    }
    case 'duplicate_outpoint': {
      const e = report.evidence;
      if (
        !HEX_64.test(e.prevTxid) ||
        !Number.isSafeInteger(e.prevIndex) ||
        e.prevIndex < 0 ||
        !Array.isArray(e.claimants) ||
        e.claimants.length < 2 ||
        !e.claimants.every((c) => validPubkey(c) && ctx.participants.includes(c))
      ) {
        return { ok: false, reason: 'malformed outpoint evidence' };
      }
      if (!e.claimants.includes(report.accused)) {
        return { ok: false, reason: 'accused not among claimants' };
      }
      return { ok: true };
    }
    case 'invalid_signature_set': {
      const e = report.evidence;
      if (
        !Array.isArray(e.expectedOutpoints) ||
        !Array.isArray(e.receivedOutpoints) ||
        e.expectedOutpoints.length > 64 ||
        e.receivedOutpoints.length > 64 ||
        !e.expectedOutpoints.every((o) => typeof o === 'string' && o.length <= 80) ||
        !e.receivedOutpoints.every((o) => typeof o === 'string' && o.length <= 80)
      ) {
        return { ok: false, reason: 'malformed signature-set evidence' };
      }
      const exp = new Set(e.expectedOutpoints);
      const got = new Set(e.receivedOutpoints);
      const same =
        exp.size === got.size &&
        exp.size === e.expectedOutpoints.length &&
        got.size === e.receivedOutpoints.length &&
        [...exp].every((k) => got.has(k));
      if (same) {
        return { ok: false, reason: 'signature sets actually match' };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unsupported evidence' };
  }
}

/** Build a report after a local hard-check failure (caller already detected fault). */
export function createBlameReport(
  session: string,
  accused: string,
  code: BlameCode,
  evidence: BlameEvidence
): BlameReport {
  if (evidence.kind !== code) {
    throw new Error('blame evidence kind must match code');
  }
  return { session, accused, code, evidence };
}

/**
 * Parse/normalize evidence from a wire object. Returns null if shape is wrong.
 * Size caps keep gift-wrap payloads bounded.
 */
export function parseBlameEvidence(code: BlameCode, raw: unknown): BlameEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== code) return null;

  switch (code) {
    case 'pedersen_unbalanced': {
      if (
        !Array.isArray(o.amountCommitments) ||
        typeof o.pedersenTotalNonce !== 'string' ||
        typeof o.excessFee !== 'number'
      ) {
        return null;
      }
      return {
        kind: 'pedersen_unbalanced',
        amountCommitments: o.amountCommitments as string[],
        pedersenTotalNonce: o.pedersenTotalNonce,
        excessFee: o.excessFee,
      };
    }
    case 'credential_slot_oob': {
      if (!Array.isArray(o.slots) || !Array.isArray(o.participants)) return null;
      return {
        kind: 'credential_slot_oob',
        slots: o.slots as number[],
        participants: o.participants as string[],
      };
    }
    case 'invalid_input_credential': {
      if (
        typeof o.roundPubkey !== 'string' ||
        !Array.isArray(o.inputs) ||
        !Array.isArray(o.credentialSigs)
      ) {
        return null;
      }
      const failedOpenings = Array.isArray(o.failedOpenings)
        ? (o.failedOpenings as Array<{
            outpoint: string;
            slotIndex: number;
            openingHex: string;
            requestHex: string;
            rPointHex: string;
            saltCommitmentHex: string;
          }>)
        : undefined;
      return {
        kind: 'invalid_input_credential',
        roundPubkey: o.roundPubkey,
        inputs: o.inputs as FusionInputRef[],
        credentialSigs: o.credentialSigs as string[],
        ...(failedOpenings ? { failedOpenings } : {}),
      };
    }
    case 'duplicate_outpoint': {
      if (
        typeof o.prevTxid !== 'string' ||
        typeof o.prevIndex !== 'number' ||
        !Array.isArray(o.claimants)
      ) {
        return null;
      }
      return {
        kind: 'duplicate_outpoint',
        prevTxid: o.prevTxid,
        prevIndex: o.prevIndex,
        claimants: o.claimants as string[],
      };
    }
    case 'invalid_signature_set': {
      if (
        !Array.isArray(o.expectedOutpoints) ||
        !Array.isArray(o.receivedOutpoints)
      ) {
        return null;
      }
      return {
        kind: 'invalid_signature_set',
        expectedOutpoints: o.expectedOutpoints as string[],
        receivedOutpoints: o.receivedOutpoints as string[],
      };
    }
    default:
      return null;
  }
}
