// BCH blind Schnorr — requester + issuer for P2P CashFusion credentials.
//
// Math matches Electron Cash `electroncash/schnorr.py` and our Rust
// `src-tauri/src/fusion/schnorr.rs` so a signature produced here verifies under
// the same BCH convention (R.x || s, jacobi(R.y)=+1, challenge =
// sha256(R.x || compressed(P) || msg32)).
//
// The issuer is the server in classic CashFusion and the **elected coordinator**
// in P2P — no extra infrastructure. Each nonce slot is one-shot: reusing k
// across two challenges leaks the round private key.

import * as ecc from 'tiny-secp256k1';
import { sha256, binToHex, hexToBin } from '@bitauth/libauth';

/** secp256k1 group order n. */
const N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);
/** secp256k1 field prime p (Jacobi test only). */
const P = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'
);

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntTo32(n: bigint): Uint8Array {
  let x = ((n % N) + N) % N;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Uniform non-zero scalar mod n from the CSPRNG. */
function randomScalar(): Uint8Array {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const v = bytesToBigInt(b);
    if (v > 0n && v < N) return b;
  }
}

function scalarAdd(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bigIntTo32(bytesToBigInt(a) + bytesToBigInt(b));
}

function scalarMul(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bigIntTo32(bytesToBigInt(a) * bytesToBigInt(b));
}

function scalarNegate(a: Uint8Array): Uint8Array {
  return bigIntTo32(-bytesToBigInt(a));
}

function scalarReduce(bytes: Uint8Array): Uint8Array {
  return bigIntTo32(bytesToBigInt(bytes));
}

/** Jacobi symbol of y mod p is +1 (quadratic residue, non-zero). */
function yIsQuadraticResidue(yBe: Uint8Array): boolean {
  const y = bytesToBigInt(yBe);
  if (y === 0n) return false;
  const exp = (P - 1n) >> 1n;
  // Modular exponentiation.
  let base = y % P;
  let e = exp;
  let result = 1n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % P;
    base = (base * base) % P;
    e >>= 1n;
  }
  return result === 1n;
}

function pointUncompressed(compressed33: Uint8Array): Uint8Array {
  const u = ecc.pointCompress(compressed33, false);
  if (!u) throw new Error('point compress failed');
  return u;
}

function pointX(compressed33: Uint8Array): Uint8Array {
  return compressed33.slice(1, 33);
}

function pointY(compressed33: Uint8Array): Uint8Array {
  return pointUncompressed(compressed33).slice(33, 65);
}

function challenge(
  rx: Uint8Array,
  pubkeyCompressed: Uint8Array,
  msg32: Uint8Array
): Uint8Array {
  const h = sha256.hash(
    Uint8Array.from([...rx, ...pubkeyCompressed, ...msg32])
  );
  return scalarReduce(new Uint8Array(h));
}

/** Verify a 64-byte BCH Schnorr signature under a compressed (or uncompressed) pubkey. */
export function verifyBchSchnorr(
  pubkey: Uint8Array,
  sig64: Uint8Array,
  msg32: Uint8Array
): boolean {
  if (sig64.length !== 64 || msg32.length !== 32) return false;
  let Pcomp: Uint8Array;
  try {
    if (pubkey.length === 33) Pcomp = pubkey;
    else if (pubkey.length === 65) {
      const c = ecc.pointCompress(pubkey, true);
      if (!c) return false;
      Pcomp = c;
    } else return false;
    if (!ecc.isPoint(Pcomp)) return false;
  } catch {
    return false;
  }

  const rx = sig64.slice(0, 32);
  const s = sig64.slice(32, 64);
  if (bytesToBigInt(s) >= N) return false;

  const e = challenge(rx, Pcomp, msg32);
  // R = s·G - e·P = s·G + (-e)·P
  const sG = ecc.pointFromScalar(s, true);
  if (!sG) return false;
  const negE = scalarNegate(e);
  const minusEP = ecc.pointMultiply(Pcomp, negE);
  if (!minusEP) return false;
  const R = ecc.pointAdd(sG, minusEP);
  if (!R) return false;
  if (!yIsQuadraticResidue(pointY(R))) return false;
  const gotX = pointX(R);
  for (let i = 0; i < 32; i++) if (gotX[i] !== rx[i]) return false;
  return true;
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

/** Requester side — one instance per component credential. */
export class BlindSignatureRequest {
  private readonly pubkey: Uint8Array;
  private readonly messageHash: Uint8Array;
  private readonly a: Uint8Array;
  private readonly rxNew: Uint8Array;
  private readonly signFlip: boolean;
  private readonly e: Uint8Array;

  private constructor(
    pubkey: Uint8Array,
    messageHash: Uint8Array,
    a: Uint8Array,
    rxNew: Uint8Array,
    signFlip: boolean,
    e: Uint8Array
  ) {
    this.pubkey = pubkey;
    this.messageHash = messageHash;
    this.a = a;
    this.rxNew = rxNew;
    this.signFlip = signFlip;
    this.e = e;
  }

  static create(
    roundPubkeyHex: string,
    rPointHex: string,
    messageHash: Uint8Array
  ): BlindSignatureRequest {
    if (messageHash.length !== 32) {
      throw new Error('blind request message hash must be 32 bytes');
    }
    const pubkey = hexToBin(roundPubkeyHex);
    const rPoint = hexToBin(rPointHex);
    if (!ecc.isPoint(pubkey) || !ecc.isPoint(rPoint)) {
      throw new Error('blind request: invalid curve point');
    }

    const a = randomScalar();
    const b = randomScalar();
    // R_new = R + a·G + b·P
    const aG = ecc.pointFromScalar(a, true);
    if (!aG) throw new Error('blind request: a·G failed');
    const bP = ecc.pointMultiply(pubkey, b);
    if (!bP) throw new Error('blind request: b·P failed');
    const rPlusAG = ecc.pointAdd(rPoint, aG);
    if (!rPlusAG) throw new Error('blind request: R+aG at infinity');
    const rNew = ecc.pointAdd(rPlusAG, bP);
    if (!rNew) throw new Error('blind request: blinded R at infinity — retry');

    const rxNew = pointX(rNew);
    const signFlip = !yIsQuadraticResidue(pointY(rNew));
    const eHash = challenge(rxNew, pubkey, messageHash);
    const cEHash = signFlip ? scalarNegate(eHash) : eHash;
    const e = scalarAdd(cEHash, b);

    return new BlindSignatureRequest(
      pubkey,
      messageHash,
      a,
      rxNew,
      signFlip,
      e
    );
  }

  /** 32-byte hex blinded challenge sent to the issuer. */
  requestHex(): string {
    return binToHex(this.e);
  }

  /** Unblind the issuer's 32-byte hex response into a 64-byte hex signature. */
  finalizeHex(sResponseHex: string, check = true): string {
    const s = scalarReduce(hexToBin(sResponseHex));
    const sA = scalarAdd(s, this.a);
    const sNew = this.signFlip ? scalarNegate(sA) : sA;
    const sig = new Uint8Array(64);
    sig.set(this.rxNew, 0);
    sig.set(sNew, 32);
    if (check) {
      if (!verifyBchSchnorr(this.pubkey, sig, this.messageHash)) {
        throw new Error('blind signature verification failed — issuer cheated');
      }
    }
    return binToHex(sig);
  }
}

/**
 * Production issuer: round key + one-shot nonce pool.
 * Slot reuse is a hard error (would leak the round private key).
 */
export class BlindIssuer {
  private readonly x: Uint8Array;
  private readonly nonces: Array<Uint8Array | null>;
  readonly pubkeyHex: string;
  readonly rPointsHex: string[];

  private constructor(x: Uint8Array, nonces: Uint8Array[], rPoints: string[]) {
    this.x = x;
    this.nonces = nonces;
    this.pubkeyHex = binToHex(ecc.pointFromScalar(x, true)!);
    this.rPointsHex = rPoints;
  }

  static create(numNonces: number): BlindIssuer {
    if (numNonces < 1 || numNonces > 1024) {
      throw new Error('BlindIssuer needs 1..1024 nonce slots');
    }
    const x = randomScalar();
    const nonces: Uint8Array[] = [];
    const rPoints: string[] = [];
    for (let i = 0; i < numNonces; i++) {
      const k = randomScalar();
      nonces.push(k);
      const R = ecc.pointFromScalar(k, true);
      if (!R) throw new Error('BlindIssuer: R derivation failed');
      rPoints.push(binToHex(R));
    }
    return new BlindIssuer(x, nonces, rPoints);
  }

  /** Sign blinded challenge at `index`, consuming the slot. Returns 32-byte hex s. */
  signHex(index: number, eHex: string): string {
    if (index < 0 || index >= this.nonces.length) {
      throw new Error(`blind nonce index ${index} out of range`);
    }
    const k = this.nonces[index];
    if (!k) {
      throw new Error(`blind nonce slot ${index} already used`);
    }
    this.nonces[index] = null;
    const e = scalarReduce(hexToBin(eHex));
    // s = k + e·x
    const s = scalarAdd(k, scalarMul(e, this.x));
    return binToHex(s);
  }

  get capacity(): number {
    return this.nonces.length;
  }
}

/** Domain-separated 32-byte hash of a fusion input for credential binding. */
export function inputCredentialMessageHash(input: {
  prevTxid: string;
  prevIndex: number;
  value: number;
  pubkey: string;
}): Uint8Array {
  const payload = `optn-p2p-input-v1|${input.prevTxid.toLowerCase()}|${input.prevIndex}|${input.value}|${input.pubkey.toLowerCase()}`;
  return new Uint8Array(sha256.hash(new TextEncoder().encode(payload)));
}

export function inputCredentialMessageHashHex(input: {
  prevTxid: string;
  prevIndex: number;
  value: number;
  pubkey: string;
}): string {
  return binToHex(inputCredentialMessageHash(input));
}

export interface FusionCredentialContext {
  session: string;
  network: 'mainnet' | 'chipnet';
  tier: number;
}

/**
 * Domain-separated credential message for an anonymously redeemed output.
 * The random serial is disclosed only after the onion shuffle and acts as the
 * coordinator's one-use nullifier. Lower-casing hex fields makes the wire
 * encoding canonical without changing the represented script.
 */
export function outputCredentialMessageHash(
  context: FusionCredentialContext,
  output: { script: string; value: number },
  serial: string
): Uint8Array {
  const payload =
    `optn-p2p-component-v3|${context.network}|${context.session.toLowerCase()}|` +
    `${context.tier}|output|${output.script.toLowerCase()}|${output.value}|${serial.toLowerCase()}`;
  return new Uint8Array(sha256.hash(new TextEncoder().encode(payload)));
}

export function outputCredentialMessageHashHex(
  context: FusionCredentialContext,
  output: { script: string; value: number },
  serial: string
): string {
  return binToHex(outputCredentialMessageHash(context, output, serial));
}

/** One-shot blind-Schnorr nonce capacity reserved for each round participant. */
export const CREDENTIAL_SLOTS_PER_PEER = 24;
/** Output planning may use four slots, so input selection must leave them free. */
export const MAX_OUTPUT_CREDENTIALS_PER_PEER = 4;
export const MAX_INPUT_CREDENTIALS_PER_PEER =
  CREDENTIAL_SLOTS_PER_PEER - MAX_OUTPUT_CREDENTIALS_PER_PEER;

/** Stable base index for a peer's nonce slots (sorted participant order). */
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
