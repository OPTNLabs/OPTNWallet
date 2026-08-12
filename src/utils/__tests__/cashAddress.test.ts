import { describe, expect, it, vi } from 'vitest';
import { toTokenAwareCashAddress } from '../cashAddress';

vi.mock('@bitauth/libauth', () => ({
  decodeCashAddress: vi.fn((address: string) => {
    if (address.includes(':qq')) {
      return {
        prefix: 'bchtest',
        type: 'p2pkh',
        payload: new Uint8Array(20),
      };
    }
    if (address.includes(':pp')) {
      return {
        prefix: 'bitcoincash',
        type: 'p2sh',
        payload: new Uint8Array(20),
      };
    }
    if (address.includes(':zq')) {
      return {
        prefix: 'bchtest',
        type: 'p2pkhWithTokens',
        payload: new Uint8Array(20),
      };
    }
    if (address.includes(':zp')) {
      return {
        prefix: 'bitcoincash',
        type: 'p2shWithTokens',
        payload: new Uint8Array(20),
      };
    }
    return 'invalid';
  }),
  encodeCashAddress: vi.fn(
    ({ prefix, type }: { prefix: string; type: string }) => ({
      address:
        type === 'p2shWithTokens'
          ? `${prefix}:zpconverted0000000000000000000000000000000`
          : `${prefix}:zqconverted0000000000000000000000000000000`,
    })
  ),
}));

describe('toTokenAwareCashAddress', () => {
  it('converts p2pkh cashaddr recipients to token-aware form', () => {
    expect(
      toTokenAwareCashAddress('bchtest:qqdest000000000000000000000000000000000')
    ).toBe('bchtest:zqconverted0000000000000000000000000000000');
  });

  it('converts p2sh cashaddr recipients to token-aware form', () => {
    expect(
      toTokenAwareCashAddress('bitcoincash:ppdest0000000000000000000000000000000')
    ).toBe('bitcoincash:zpconverted0000000000000000000000000000000');
  });

  it('keeps already token-aware addresses unchanged', () => {
    expect(
      toTokenAwareCashAddress('bchtest:zqdest000000000000000000000000000000000')
    ).toBe('bchtest:zqdest000000000000000000000000000000000');
  });

  it('throws for invalid recipients', () => {
    expect(() => toTokenAwareCashAddress('not-an-address')).toThrow(
      'Invalid recipient address: not-an-address'
    );
  });
});
