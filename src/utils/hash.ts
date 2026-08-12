// src/utils/hash160.ts

import {
  ripemd160,
  sha256 as _sha256,
  Sha256 as _Sha256,
} from '@bitauth/libauth';
import { binToHex } from './hex';

/**
 * hash160 - Calculate the sha256, ripemd160 hash of a value
 *
 * @param {Uint8Array} message - Value to hash as a binary array
 * @returns {Uint8Array} - The hash160 value of the input
 */
export function hash160(message: Uint8Array): Uint8Array {
  const sha256Hash = sha256.hash(message);
  return ripemd160.hash(sha256Hash);
}

interface Sha256 extends _Sha256 {
  /**
   * Compute SHA-256 hash of UTF-8 text and return hex-encoded string
   */
  text(payload: string): string;
}

// Extend the _sha256 object with a text() helper
(_sha256 as Sha256).text = (payload: string): string => {
  const encoded = new TextEncoder().encode(payload);
  const hashBytes = _sha256.hash(encoded);
  return binToHex(hashBytes);
};

export const sha256: Sha256 = _sha256 as Sha256;
export { ripemd160 };
