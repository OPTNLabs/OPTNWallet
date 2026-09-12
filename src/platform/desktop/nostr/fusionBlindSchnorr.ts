// BCH blind Schnorr for P2P CashFusion credentials.
//
// Curve, scalar, Jacobi, challenge, issuer, and unblinding math live in the
// shared Rust core. TypeScript keeps the existing transport-facing API, owns
// browser CSPRNG access, and retains one-shot nonce state for the coordinator.

import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  ensureOptnCore,
  fusionBlindIssuerNoncePoint,
  fusionBlindIssuerPublicKey,
  fusionBlindIssuerSign,
  fusionBlindRequest,
  fusionFinalizeBlindSignature,
  fusionScalarIsCanonical,
  fusionVerifySchnorr,
} from '../../../wasm/optn-core';
import {
  inputComponentBlindMessage,
  outputComponentBlindMessage,
} from './fusionComponentV4';

function randomScalar(): Uint8Array {
  ensureOptnCore();
  for (;;) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    if (fusionScalarIsCanonical(candidate)) return candidate;
  }
}

/** Verify a 64-byte BCH Schnorr signature. Malformed attacker bytes fail closed. */
export function verifyBchSchnorr(
  pubkey: Uint8Array,
  sig64: Uint8Array,
  msg32: Uint8Array
): boolean {
  try {
    ensureOptnCore();
    return fusionVerifySchnorr(pubkey, sig64, msg32);
  } catch {
    return false;
  }
}

export function verifyBchSchnorrHex(
  pubkeyHex: string,
  sigHex: string,
  msgHashHex: string
): boolean {
  try {
    return verifyBchSchnorr(
      hexToBin(pubkeyHex),
      hexToBin(sigHex),
      hexToBin(msgHashHex)
    );
  } catch {
    return false;
  }
}

/** Requester side: one instance per component credential. */
export class BlindSignatureRequest {
  private constructor(
    private readonly pubkey: Uint8Array,
    private readonly rPoint: Uint8Array,
    private readonly messageHash: Uint8Array,
    private readonly a: Uint8Array,
    private readonly b: Uint8Array,
    private readonly request: Uint8Array
  ) {}

  static create(
    roundPubkeyHex: string,
    rPointHex: string,
    messageHash: Uint8Array
  ): BlindSignatureRequest {
    if (messageHash.length !== 32) {
      throw new Error('blind request message hash must be 32 bytes');
    }
    ensureOptnCore();
    const pubkey = hexToBin(roundPubkeyHex);
    const rPoint = hexToBin(rPointHex);
    const a = randomScalar();
    const b = randomScalar();
    const request = fusionBlindRequest(pubkey, rPoint, messageHash, a, b);
    return new BlindSignatureRequest(
      pubkey,
      rPoint,
      messageHash.slice(),
      a,
      b,
      request
    );
  }

  /** 32-byte hex blinded challenge sent to the issuer. */
  requestHex(): string {
    return binToHex(this.request);
  }

  /** 64-byte `a || b` opening revealed only after an aborted round. */
  openingHex(): string {
    const opening = new Uint8Array(64);
    opening.set(this.a, 0);
    opening.set(this.b, 32);
    return binToHex(opening);
  }

  /** Unblind and verify the issuer response in Rust. */
  finalizeHex(sResponseHex: string, _check = true): string {
    // Kept for source compatibility with the former TS implementation. Rust
    // now always verifies the unblinded signature, so callers cannot disable it.
    void _check;
    ensureOptnCore();
    return binToHex(
      fusionFinalizeBlindSignature(
        this.pubkey,
        this.rPoint,
        this.messageHash,
        this.a,
        this.b,
        hexToBin(sResponseHex)
      )
    );
  }
}

/** Length-checked, non-short-circuiting byte comparison. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verify that an abort-phase opening produced the retained blinded request. */
export function verifyCredentialOpening(args: {
  roundPubkeyHex: string;
  rPointHex: string;
  messageHash: Uint8Array;
  openingHex: string;
  requestHex: string;
}): boolean {
  try {
    ensureOptnCore();
    if (args.messageHash.length !== 32) return false;
    const opening = hexToBin(args.openingHex);
    const expected = hexToBin(args.requestHex);
    if (opening.length !== 64 || expected.length !== 32) return false;
    const a = opening.slice(0, 32);
    const b = opening.slice(32);
    if (!fusionScalarIsCanonical(a) || !fusionScalarIsCanonical(b))
      return false;
    const actual = fusionBlindRequest(
      hexToBin(args.roundPubkeyHex),
      hexToBin(args.rPointHex),
      args.messageHash,
      a,
      b
    );
    return bytesEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Coordinator issuer with caller-owned CSPRNG state and one-shot nonce slots. */
export class BlindIssuer {
  readonly pubkeyHex: string;
  readonly rPointsHex: string[];

  private constructor(
    private readonly x: Uint8Array,
    private readonly nonces: Array<Uint8Array | null>
  ) {
    ensureOptnCore();
    this.pubkeyHex = binToHex(fusionBlindIssuerPublicKey(x));
    this.rPointsHex = nonces.map((nonce) =>
      binToHex(fusionBlindIssuerNoncePoint(nonce!))
    );
  }

  static create(numNonces: number): BlindIssuer {
    if (!Number.isInteger(numNonces) || numNonces < 1 || numNonces > 1024) {
      throw new Error('BlindIssuer needs 1..1024 nonce slots');
    }
    return new BlindIssuer(
      randomScalar(),
      Array.from({ length: numNonces }, () => randomScalar())
    );
  }

  /** Sign at `index`, consuming that nonce slot before returning. */
  signHex(index: number, challengeHex: string): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.nonces.length) {
      throw new Error(`blind nonce index ${index} out of range`);
    }
    const nonce = this.nonces[index];
    if (!nonce) throw new Error(`blind nonce slot ${index} already used`);
    const challenge = hexToBin(challengeHex);
    if (challenge.length !== 32) {
      throw new Error('blinded challenge must be 32 bytes');
    }
    this.nonces[index] = null;
    ensureOptnCore();
    return binToHex(fusionBlindIssuerSign(this.x, nonce, challenge));
  }

  get capacity(): number {
    return this.nonces.length;
  }
}

/**
 * v4: blind message = sha256(EC Input Component) with salt_commitment.
 * Matches server/Electron Cash `sha256(serialized Component)`.
 */
export function inputCredentialMessageHash(
  input: {
    prevTxid: string;
    prevIndex: number;
    value: number;
    pubkey: string;
  },
  saltCommitmentHex: string
): Uint8Array {
  return inputComponentBlindMessage({
    prevTxidDisplayHex: input.prevTxid,
    prevIndex: input.prevIndex,
    pubkeyHex: input.pubkey,
    amount: input.value,
    saltCommitmentHex,
  });
}

export function inputCredentialMessageHashHex(
  input: {
    prevTxid: string;
    prevIndex: number;
    value: number;
    pubkey: string;
  },
  saltCommitmentHex: string
): string {
  return binToHex(inputCredentialMessageHash(input, saltCommitmentHex));
}

export interface FusionCredentialContext {
  session: string;
  network: 'mainnet' | 'chipnet';
  tier: number;
}

/** v4 output component hash; context and serial remain transport/nullifier data. */
export function outputCredentialMessageHash(
  _context: FusionCredentialContext,
  output: { script: string; value: number },
  _serial: string,
  saltCommitmentHex: string
): Uint8Array {
  return outputComponentBlindMessage({
    scriptHex: output.script,
    amount: output.value,
    saltCommitmentHex,
  });
}

export function outputCredentialMessageHashHex(
  context: FusionCredentialContext,
  output: { script: string; value: number },
  serial: string,
  saltCommitmentHex: string
): string {
  return binToHex(
    outputCredentialMessageHash(context, output, serial, saltCommitmentHex)
  );
}

export const CREDENTIAL_SLOTS_PER_PEER = 24;
export const MAX_OUTPUT_CREDENTIALS_PER_PEER = 6;
export const MAX_INPUT_CREDENTIALS_PER_PEER =
  CREDENTIAL_SLOTS_PER_PEER - MAX_OUTPUT_CREDENTIALS_PER_PEER;

export function peerCredentialSlotBase(
  participants: string[],
  peerPubkey: string
): number {
  const sorted = [...participants].sort();
  const idx = sorted.indexOf(peerPubkey);
  if (idx < 0) throw new Error('peer not in participant set');
  return idx * CREDENTIAL_SLOTS_PER_PEER;
}

export function totalCredentialSlots(participantCount: number): number {
  return participantCount * CREDENTIAL_SLOTS_PER_PEER;
}
