import { describe, expect, it } from 'vitest';
import {
  canConfirmParyonAction,
  matchesParyonPreview,
  paryonConfirmationLabel,
} from '../paryon/actionConfirmation';

describe('Paryon action confirmation semantics', () => {
  it('requires a writable verified state for live actions', () => {
    expect(canConfirmParyonAction('borrow', true, false)).toBe(false);
    expect(canConfirmParyonAction('stake', true, false)).toBe(false);
    expect(canConfirmParyonAction('borrow', true, true)).toBe(true);
  });

  it('keeps redeem explicitly preview-only', () => {
    expect(canConfirmParyonAction('redeem', true, false)).toBe(true);
    expect(canConfirmParyonAction('redeem', false, true)).toBe(false);
    expect(paryonConfirmationLabel('redeem')).toBe('Finish preview');
    expect(paryonConfirmationLabel('borrow')).toBe('Confirm and broadcast');
    expect(paryonConfirmationLabel('stake')).toBe('Confirm and broadcast');
  });

  it('rejects a confirmation when live preview terms changed', () => {
    const preview = {
      action: 'borrow',
      amountAtomic: 10000n,
      amountLabel: '100.00 PUSD',
      primaryMetricLabel: 'Minimum collateral',
      primaryMetricValue: '0.25 BCH',
      secondaryMetricLabel: 'Collateral entered',
      secondaryMetricValue: '0.30 BCH',
      details: ['Oracle price: $100 / BCH'],
      warnings: [],
      canProceed: true,
      blockedReason: null,
    };
    expect(matchesParyonPreview(preview, { ...preview })).toBe(true);
    expect(
      matchesParyonPreview(preview, {
        ...preview,
        primaryMetricValue: '0.27 BCH',
      })
    ).toBe(false);
  });
});
