import { describe, expect, it } from 'vitest';
import {
  canConfirmParyonAction,
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
});
