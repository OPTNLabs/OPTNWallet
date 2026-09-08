import { describe, expect, it } from 'vitest';

import { buildCauldronQuoteSafetyBanner } from '../quoteSafety';
import { applySlippage } from '../cauldronHelpers';

describe('cauldron quote safety banner', () => {
  it('calculates a bounded minimum output and rejects invalid rates', () => {
    expect(applySlippage(1_000n, 100n)).toBe(990n);
    expect(applySlippage(1_000n, 10_000n)).toBe(0n);
    expect(() => applySlippage(1_000n, 10_001n)).toThrow(
      'Slippage must be between 0% and 100%.'
    );
  });

  it('returns no banner for a fresh quote with healthy live updates', () => {
    expect(
      buildCauldronQuoteSafetyBanner({
        quote: {
          builtAt: 1_000_000,
          usedCachedPools: false,
          warnings: [],
        },
        liveUpdatesEnabled: true,
        liveUpdatedAt: 999_000,
        nowMs: 1_010_000,
      })
    ).toBeNull();
  });

  it('highlights stale, cached, and risk-bearing quotes', () => {
    const banner = buildCauldronQuoteSafetyBanner({
      quote: {
        builtAt: 1_000_000,
        usedCachedPools: true,
        warnings: ['High slippage is enabled.'],
      },
      liveUpdatesEnabled: false,
      liveUpdatedAt: 1_050_000,
      nowMs: 1_100_000,
    });

    expect(banner?.title).toBe('Quote may be stale');
    expect(banner?.messages).toEqual([
      'Live pool updates are unavailable right now, so this quote should be refreshed before confirming.',
      'This quote used the already-visible pool set because live pool confirmation was rate-limited.',
      'The market changed after this quote was built. Refresh the quote before confirming.',
      'This quote is 100s old. Refresh it before confirming.',
      'High slippage is enabled.',
    ]);
  });
});
