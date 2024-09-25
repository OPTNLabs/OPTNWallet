// Function to convert a byte array to hex string
export const hexString = (pkh: Uint8Array) => {
  return Array.from(pkh, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
