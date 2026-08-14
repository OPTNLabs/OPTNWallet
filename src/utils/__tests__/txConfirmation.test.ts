import { describe, expect, it } from 'vitest';
import { isTxConfirmed, preferHistoryHeight } from '../txConfirmation';

describe('txConfirmation', () => {
  it('treats positive height or confirmations as confirmed', () => {
    expect(isTxConfirmed({ height: 100 })).toBe(true);
    expect(isTxConfirmed({ confirmations: 3 })).toBe(true);
    expect(isTxConfirmed({ height: 0 })).toBe(false);
    expect(isTxConfirmed({ height: -1 })).toBe(false);
    expect(isTxConfirmed({ confirmations: 0, height: 0 })).toBe(false);
  });

  it('never lets height 0 erase a confirmed height', () => {
    expect(preferHistoryHeight(0, 317_704)).toBe(317_704);
    expect(preferHistoryHeight(317_704, 0)).toBe(317_704);
    expect(preferHistoryHeight(10, 20)).toBe(20);
    expect(preferHistoryHeight(0, 0)).toBe(0);
  });
});
