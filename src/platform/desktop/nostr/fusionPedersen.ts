// CashFusion Pedersen commitments for P2P balance checks.
// Matches Electron Cash / our Rust pedersen.rs: C = amount·H + nonce·G with
// H the nothing-up-my-sleeve point 0x02 || "CashFusion gives us fungibility."

import * as ecc from 'tiny-secp256k1';
import { binToHex, hexToBin } from '@bitauth/libauth';

const N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

/** Compressed H (33 bytes). */
const H_HEX =
  '02' +
  Array.from(new TextEncoder().encode('CashFusion gives us fungibility.'))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const H = hexToBin(H_HEX);

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

function randomScalar(): Uint8Array {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const v = bytesToBigInt(b);
    if (v > 0n && v < N) return b;
  }
}

/** Signed amount as a scalar: negatives map to n - |amount|. */
function scalarFromI64(v: number): Uint8Array {
  if (!Number.isSafeInteger(v)) {
    throw new Error('pedersen amount must be a safe integer');
  }
  if (v >= 0) return bigIntTo32(BigInt(v));
  return bigIntTo32(-BigInt(-v));
}

/** True when amount is the zero scalar (point-at-infinity for amount·H). */
function isZeroAmount(v: number): boolean {
  return v === 0;
}

/**
 * Commit to a signed amount (input: +value-fee, output: -value-fee, blank: 0).
 * Returns uncompressed 65-byte point hex and the 32-byte nonce hex.
 *
 * amount == 0 → amount·H is the identity, so C = nonce·G only (ecc.pointMultiply
 * rejects a zero scalar).
 */
export function pedersenCommit(amount: number): {
  commitmentHex: string;
  nonceHex: string;
} {
  const nonce = randomScalar();
  return pedersenCommitWithNonce(amount, binToHex(nonce));
}

/** Recompute an EC Pedersen commitment from an abort-phase nonce opening. */
export function pedersenCommitWithNonce(
  amount: number,
  nonceHex: string
): {
  commitmentHex: string;
  nonceHex: string;
} {
  const nonce = hexToBin(nonceHex.toLowerCase());
  const nonceValue = bytesToBigInt(nonce);
  if (nonce.length !== 32 || nonceValue <= 0n || nonceValue >= N) {
    throw new Error('pedersen nonce must be a non-zero canonical scalar');
  }
  const noncePoint = ecc.pointFromScalar(nonce, true);
  if (!noncePoint) throw new Error('pedersen: nonce·G failed');

  let sum: Uint8Array;
  if (isZeroAmount(amount)) {
    sum = noncePoint;
  } else {
    const amountPoint = ecc.pointMultiply(H, scalarFromI64(amount));
    if (!amountPoint) throw new Error('pedersen: amount·H failed');
    const added = ecc.pointAdd(amountPoint, noncePoint);
    if (!added) throw new Error('pedersen: commitment at infinity');
    sum = added;
  }

  const uncompressed = ecc.pointCompress(sum, false);
  if (!uncompressed) throw new Error('pedersen: uncompress failed');
  return {
    commitmentHex: binToHex(uncompressed),
    nonceHex: binToHex(nonce),
  };
}

/**
 * Homomorphic balance check for one player (the server/coordinator rule):
 *   Σ amount_commitments == excess_fee·H + total_nonce·G
 */
export function pedersenBalanceHolds(
  commitmentHexes: string[],
  excessFee: number,
  totalNonceHex: string
): boolean {
  try {
    let sum: Uint8Array | null = null;
    for (const hex of commitmentHexes) {
      const p = hexToBin(hex);
      if (!ecc.isPoint(p)) return false;
      const compressed = p.length === 65 ? ecc.pointCompress(p, true) : p;
      if (!compressed) return false;
      sum = sum ? ecc.pointAdd(sum, compressed) : compressed;
      if (!sum) return false;
    }
    if (!sum) return false;

    // excessFee == 0 → fee·H is identity; expected = total_nonce·G only.
    // Treating 0 as failure falsely blames honest peers whose inputs cover
    // outputs+fees exactly.
    const nonce = hexToBin(totalNonceHex);
    if (nonce.length !== 32) return false;
    const noncePoint = ecc.pointFromScalar(nonce, true);
    if (!noncePoint) return false;

    let expected: Uint8Array;
    if (isZeroAmount(excessFee)) {
      expected = noncePoint;
    } else {
      const feePoint = ecc.pointMultiply(H, scalarFromI64(excessFee));
      if (!feePoint) return false;
      const added = ecc.pointAdd(feePoint, noncePoint);
      if (!added) return false;
      expected = added;
    }

    // Compare as compressed.
    const sumC = sum.length === 33 ? sum : ecc.pointCompress(sum, true);
    const expC =
      expected.length === 33 ? expected : ecc.pointCompress(expected, true);
    if (!sumC || !expC || sumC.length !== expC.length) return false;
    for (let i = 0; i < sumC.length; i++) if (sumC[i] !== expC[i]) return false;
    return true;
  } catch {
    return false;
  }
}

/** Sum nonce scalars (mod n) for pedersen_total_nonce. */
export function sumNoncesHex(nonceHexes: string[]): string {
  let acc = 0n;
  for (const h of nonceHexes) {
    acc = (acc + bytesToBigInt(hexToBin(h))) % N;
  }
  return binToHex(bigIntTo32(acc));
}
