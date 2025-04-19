// src/utils/hex.ts

import { binToHex, secp256k1 } from "@bitauth/libauth";

// Function to convert a byte array to hex string
export const hexString = (pkh: Uint8Array): string =>
  Array.from(pkh, (b) => b.toString(16).padStart(2, "0")).join("");

// Function to convert a hex string to byte array
export const hexToUint8Array = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal string");
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
    throw new Error("Failed to derive compressed public key");
  }
  // 2) Filter out the (unlikely) string case
  if (typeof publicKey === "string") {
    throw new Error("Unexpected string result from derivePublicKeyCompressed");
  }

  // At this point `publicKey` is narrowed to `Uint8Array`
  if (hex) {
    return binToHex(publicKey);
  }
  return publicKey;
};
