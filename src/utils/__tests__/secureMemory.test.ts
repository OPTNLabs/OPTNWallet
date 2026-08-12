import { describe, expect, it } from 'vitest';
import { zeroize } from '../secureMemory';

describe('secureMemory.zeroize', () => {
  it('overwrites all bytes with zeros', () => {
    const buffer = new Uint8Array([9, 8, 7, 6]);
    zeroize(buffer);
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0]);
  });

  it('is safe for empty/nullish buffers', () => {
    expect(() => zeroize(new Uint8Array())).not.toThrow();
    expect(() => zeroize(null)).not.toThrow();
    expect(() => zeroize(undefined)).not.toThrow();
  });
});
