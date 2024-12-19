// src/utils/hex.ts

// Function to convert a byte array to hex string
export const hexString = (pkh: Uint8Array): string => {
  return Array.from(pkh, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Function to convert a hex string to byte array
export const hexToUint8Array = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal string');
  }
  const length = hex.length / 2;
  const array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    array[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return array;
};
