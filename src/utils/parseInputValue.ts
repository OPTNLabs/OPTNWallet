// src/utils/parseInputValue.ts
import { hexString } from './hex';

export default function parseInputValue(value: unknown, type: string) {
  const normalizeBytesValue = (input: unknown) => {
    if (typeof input === 'string') {
      return input.startsWith('0x') ? input.slice(2) : input;
    }
    if (input instanceof Uint8Array) {
      return hexString(input);
    }
    throw new Error(`Unsupported type for ${type}: ${typeof input}`);
  };

  switch (type) {
    case 'int':
      return BigInt(value as string | number | bigint | boolean);
    case 'bool':
      return value === 'true';
    case 'string':
      return value;
    case 'bytes':
      return normalizeBytesValue(value);
    case 'bytes20':
    case 'bytes32':
      return normalizeBytesValue(value);
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
