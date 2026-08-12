import { describe, expect, it } from 'vitest';

import parseInputValue from '../parseInputValue';

describe('parseInputValue', () => {
  it('normalizes bytes-like inputs to hex strings', () => {
    expect(parseInputValue('0x1234', 'bytes')).toBe('1234');
    expect(parseInputValue('0xabcdef', 'bytes32')).toBe('abcdef');
    expect(parseInputValue(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]), 'bytes20')).toBe(
      'deadbeef'
    );
  });

  it('preserves non-byte values', () => {
    expect(parseInputValue('true', 'bool')).toBe(true);
    expect(parseInputValue('42', 'int')).toBe(42n);
    expect(parseInputValue('hello', 'string')).toBe('hello');
  });
});
