import { describe, expect, it } from 'vitest';
import { formatDistributionTotal } from '../airdropReview';

describe('airdrop review amounts', () => {
  it('labels BCH satoshis as BCH', () => {
    expect(formatDistributionTotal(1_000n, { kind: 'bch' })).toBe(
      '0.00001 BCH'
    );
  });

  it('uses the token decimal count and identity', () => {
    expect(
      formatDistributionTotal(123_456n, {
        kind: 'token',
        decimals: 2,
        label: 'TEST',
      })
    ).toBe('1234.56 TEST');
  });
});
