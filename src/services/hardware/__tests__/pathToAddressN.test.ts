import { describe, expect, it } from 'vitest';
import { pathToAddressN } from '../TrezorNativeSession';

describe('pathToAddressN', () => {
  it('encodes hardened BIP44 segments for BCH', () => {
    const n = pathToAddressN("m/44'/145'/0'/0/5");
    expect(n).toHaveLength(5);
    expect(n[0]).toBe((44 + 0x80000000) >>> 0);
    expect(n[1]).toBe((145 + 0x80000000) >>> 0);
    expect(n[2]).toBe((0 + 0x80000000) >>> 0);
    expect(n[3]).toBe(0);
    expect(n[4]).toBe(5);
  });
});
