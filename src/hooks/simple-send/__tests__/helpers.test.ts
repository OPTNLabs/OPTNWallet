import { describe, expect, it } from 'vitest';

import {
  normalizeDecimalInput,
  parseAmountToSats,
  parseDecimalAmountToAtomic,
  resolveTokenDecimalsByCategory,
} from '../helpers';

describe('simple-send decimal helpers', () => {
  it('normalizes decimal input to the requested precision', () => {
    expect(normalizeDecimalInput('0012.34567', 2)).toBe('12.34');
    expect(normalizeDecimalInput('.5', 8)).toBe('0.5');
    expect(normalizeDecimalInput('12.', 8)).toBe('12.');
    expect(normalizeDecimalInput('12.345', 0)).toBe('12');
  });

  it('parses decimal input to atomic units using the requested precision', () => {
    expect(parseDecimalAmountToAtomic('12.34', 2)).toBe(1234n);
    expect(parseDecimalAmountToAtomic('0.00000001', 8)).toBe(1n);
    expect(parseDecimalAmountToAtomic('1.234567891', 8)).toBe(123456789n);
  });

  it('parses BCH amounts to sats using 8 decimal precision', () => {
    expect(parseAmountToSats('1.23456789')).toBe(123456789);
    expect(parseAmountToSats('1.234567891')).toBe(123456789);
  });

  it('prefers a non-zero BCMR decimal precision for token categories', () => {
    expect(
      resolveTokenDecimalsByCategory([
        {
          token: {
            category: 'cat-1',
            BcmrTokenMetadata: {
              token: { decimals: 0 } as never,
            } as never,
          } as never,
        } as never,
        {
          token: {
            category: 'cat-1',
            BcmrTokenMetadata: {
              token: { decimals: 2 } as never,
            } as never,
          } as never,
        } as never,
        {
          token: {
            category: 'cat-2',
            BcmrTokenMetadata: {
              token: { decimals: 8 } as never,
            } as never,
          } as never,
        } as never,
      ])
    ).toEqual({
      'cat-1': 2,
      'cat-2': 8,
    });
  });
});
