// src/utils/hash160.ts

import { ripemd160, sha256 } from '@bitauth/libauth-v3';

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
