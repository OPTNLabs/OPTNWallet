// CashFusion Pedersen commitments for P2P balance checks.
//
// The protocol math runs in optn-core. TypeScript owns only browser CSPRNG
// access and conversion between the existing hex-shaped transport API and the
// Rust/WASM byte boundary.

import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  ensureOptnCore,
  fusionPedersenBalanceHolds,
  fusionPedersenCommitSigned,
  fusionScalarIsCanonical,
  fusionScalarSum,
} from '../../../wasm/optn-core';

function randomScalar(): Uint8Array {
  ensureOptnCore();
  for (;;) {
    const candidate = crypto.getRandomValues(new Uint8Array(32));
    if (fusionScalarIsCanonical(candidate)) return candidate;
  }
}

function amountAsI64(amount: number): bigint {
  if (!Number.isSafeInteger(amount)) {
    throw new Error('pedersen amount must be a safe integer');
  }
  return BigInt(amount);
}

/** Commit to a signed amount using a fresh browser-CSPRNG nonce. */
export function pedersenCommit(amount: number): {
  commitmentHex: string;
  nonceHex: string;
} {
  return pedersenCommitWithNonce(amount, binToHex(randomScalar()));
}

/** Recompute a commitment from an abort-phase nonce opening. */
export function pedersenCommitWithNonce(
  amount: number,
  nonceHex: string
): {
  commitmentHex: string;
  nonceHex: string;
} {
  ensureOptnCore();
  const nonce = hexToBin(nonceHex.toLowerCase());
  if (!fusionScalarIsCanonical(nonce)) {
    throw new Error('pedersen nonce must be a non-zero canonical scalar');
  }
  return {
    commitmentHex: binToHex(
      fusionPedersenCommitSigned(amountAsI64(amount), nonce)
    ),
    nonceHex: binToHex(nonce),
  };
}

/**
 * Homomorphic balance check for one player:
 *   sum(amount_commitments) == excess_fee*H + total_nonce*G
 */
export function pedersenBalanceHolds(
  commitmentHexes: string[],
  excessFee: number,
  totalNonceHex: string
): boolean {
  try {
    ensureOptnCore();
    const commitments = commitmentHexes.map(hexToBin);
    if (
      commitments.length === 0 ||
      commitments.some((commitment) => commitment.length !== 65)
    ) {
      return false;
    }
    const packed = new Uint8Array(commitments.length * 65);
    commitments.forEach((commitment, index) => {
      packed.set(commitment, index * 65);
    });
    return fusionPedersenBalanceHolds(
      packed,
      amountAsI64(excessFee),
      hexToBin(totalNonceHex)
    );
  } catch {
    return false;
  }
}

/** Sum nonce scalars modulo the secp256k1 order for pedersen_total_nonce. */
export function sumNoncesHex(nonceHexes: string[]): string {
  if (nonceHexes.length === 0) return '00'.repeat(32);
  ensureOptnCore();
  const nonces = nonceHexes.map(hexToBin);
  const packed = new Uint8Array(nonces.length * 32);
  nonces.forEach((nonce, index) => {
    if (!fusionScalarIsCanonical(nonce)) {
      throw new Error('pedersen nonce must be a non-zero canonical scalar');
    }
    packed.set(nonce, index * 32);
  });
  return binToHex(fusionScalarSum(packed));
}
