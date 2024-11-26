// src/utils/hex.ts

// Function to convert a byte array to hex string
export const hexString = (pkh: Uint8Array): string => {
  return Array.from(pkh, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
