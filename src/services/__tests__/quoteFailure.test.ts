import { describe, expect, it } from 'vitest';

import { classifyCauldronQuoteFailure } from '../cauldron/quoteFailure';

describe('Cauldron quote failure classification', () => {
  it('classifies minimum routable market failures', () => {
    expect(
      classifyCauldronQuoteFailure(
        'That amount is below the current minimum routable market size.'
      ).kind
    ).toBe('minimum');
  });

  it('classifies market refresh failures', () => {
    expect(
      classifyCauldronQuoteFailure(
        'The visible Cauldron market changed on chain before this quote could be built.'
      ).kind
    ).toBe('market-changed');
  });

  it('classifies unavailable route failures', () => {
    expect(
      classifyCauldronQuoteFailure(
        'No Cauldron quote is currently available for that amount.'
      ).kind
    ).toBe('no-route');
  });

  it('classifies confirmed pool failures', () => {
    expect(
      classifyCauldronQuoteFailure(
        'No executable Cauldron pools are currently confirmed on chain for this token.'
      ).kind
    ).toBe('no-confirmed-pools');
  });

  it('classifies rate limit failures', () => {
    expect(
      classifyCauldronQuoteFailure(
        'Addon "optn.builtin.demo" exceeded rate limit for capability "chain:query" (240/min)'
      ).kind
    ).toBe('rate-limited');
  });
});
