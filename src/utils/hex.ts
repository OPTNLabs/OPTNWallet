// src/utils/hex.ts

import {
  // binToHex,
  secp256k1,
  hexToBin,
  binToUtf8,
} from '@bitauth/libauth';

export function latin1ToHex(raw: string): string {
  return Array.from(raw, (ch) =>
    ch.charCodeAt(0).toString(16).padStart(2, '0')
  ).join('');
}

// Function to convert a byte array to hex string
export const hexString = (pkh: Uint8Array): string =>
  Array.from(pkh, (b) => b.toString(16).padStart(2, '0')).join('');

// Function to convert a hex string to byte array
export const hexToUint8Array = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
};

export const getPublicKeyCompressed = (
  privKey: Uint8Array,
  hex = false
): Uint8Array | string => {
  const publicKey = secp256k1.derivePublicKeyCompressed(privKey);

  // 1) Filter out undefined
  if (!publicKey) {
    throw new Error('Failed to derive compressed public key');
  }
  // 2) Filter out the (unlikely) string case
  if (typeof publicKey === 'string') {
    throw new Error('Unexpected string result from derivePublicKeyCompressed');
  }

  // At this point `publicKey` is narrowed to `Uint8Array`
  if (hex) {
    return binToHex(publicKey);
  }
  return publicKey;
};

/*
 From Selene Wallet - https://gitlab.com/selene.cash/selene-wallet/-/blob/main/src/util/hex.ts
*/

// initialize binToHex lookup tables
const LUT_HEX_4B = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
];

const LUT_HEX_8B = new Array(0x100);
for (let n = 0; n < 0x100; n++) {
  LUT_HEX_8B[n] = `${LUT_HEX_4B[(n >>> 4) & 0xf]}${LUT_HEX_4B[n & 0xf]}`;
}

// faster (4x) binToHex implementation: https://archive.is/2v7QZ
// libauth uses slower array conversion method
export function binToHex(buffer) {
  let out = '';
  for (let idx = 0, edx = buffer.length; idx < edx; idx++) {
    out += LUT_HEX_8B[buffer[idx]];
  }
  return out;
}

// re-export libauth hexToBin
export { hexToBin };

// hexToUtf8: attempt to decode a hex string to utf8
export function hexToUtf8(hex: string) {
  return binToUtf8(hexToBin(hex));
}
