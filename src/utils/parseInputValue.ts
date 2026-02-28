// src/utils/parseInputValue.ts
import { hexString } from './hex';

export default function parseInputValue(value: unknown, type: string) {
  switch (type) {
    case 'int':
      return BigInt(value as string | number | bigint | boolean);
    case 'bool':
      return value === 'true';
    case 'string':
      return value;
    case 'bytes':
      return value;
    case 'bytes20':
      if (typeof value === 'string') {
        // Ensure the string is a valid hex string
        return value.startsWith('0x') ? value.slice(2) : value;
      } else if (value instanceof Uint8Array) {
        return hexString(value);
      } else {
        throw new Error(`Unsupported type for bytes20: ${typeof value}`);
      }
    case 'pubkey':
      return value;
    case 'sig':
      return value;
    case 'datasig':
      return value;
    default:
      return value;
  }
}
