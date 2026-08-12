import { describe, expect, it } from 'vitest';

import {
  parseBchInputToSats,
  parseDecimalToAtomic,
  selectExecutableSwapMaxAtomic,
  sanitizeDecimalInput,
} from '../cauldron/amount';

describe('Cauldron amount helpers', () => {
  it('parses atomic decimal input', () => {
    expect(parseDecimalToAtomic('12.34', 2)).toBe(1234n);
    expect(parseDecimalToAtomic('12.340', 2)).toBeNull();
  });

  it('parses BCH input to sats', () => {
    expect(parseBchInputToSats('0.00000001')).toBe(1n);
  });

  it('sanitizes and clamps decimal input while preserving display formatting', () => {
    expect(
      sanitizeDecimalInput('1,2.3x4', 4, 12345n, (value, decimals) =>
        `${value.toString()}.${'0'.repeat(decimals)}`
      )
    ).toBe('1.234');

    expect(
      sanitizeDecimalInput('999.999', 2, 1234n, (value, decimals) =>
        `${value.toString()}.${'0'.repeat(decimals)}`
      )
    ).toBe('1234.00');
  });

  it('selects the smaller of wallet and routable ceilings for swaps', () => {
    expect(
      selectExecutableSwapMaxAtomic({
        walletMaxAtomic: 53_637_870n,
        routableMaxAtomic: 800_320_598_478_920_100n,
      })
    ).toBe(53_637_870n);

    expect(
      selectExecutableSwapMaxAtomic({
        walletMaxAtomic: 1_000n,
        routableMaxAtomic: 900n,
      })
    ).toBe(900n);
  });
});
