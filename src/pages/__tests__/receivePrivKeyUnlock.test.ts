import { describe, expect, it } from 'vitest';
import {
  getPrivKeyUnlockToastMessage,
  getRemainingPrivKeyUnlockTaps,
  shouldShowPrivKeyButton,
} from '../receivePrivKeyUnlock';

describe('receivePrivKeyUnlock', () => {
  it('counts down the remaining taps before unlocking', () => {
    expect(getRemainingPrivKeyUnlockTaps(0)).toBe(10);
    expect(getRemainingPrivKeyUnlockTaps(1)).toBe(9);
    expect(getRemainingPrivKeyUnlockTaps(9)).toBe(1);
    expect(getRemainingPrivKeyUnlockTaps(10)).toBe(0);
  });

  it('shows unlock guidance only in the final five taps', () => {
    expect(getPrivKeyUnlockToastMessage(0)).toBeNull();
    expect(getPrivKeyUnlockToastMessage(4)).toBeNull();
    expect(getPrivKeyUnlockToastMessage(5)).toBe(
      'PubKey taps: 5/10. 5 more taps to reveal PrivKey.'
    );
    expect(getPrivKeyUnlockToastMessage(9)).toBe(
      'PubKey taps: 9/10. 1 more tap to reveal PrivKey.'
    );
    expect(getPrivKeyUnlockToastMessage(10)).toBeNull();
  });

  it('keeps the PrivKey tab hidden until the unlock flag flips', () => {
    expect(shouldShowPrivKeyButton(false)).toBe(false);
    expect(shouldShowPrivKeyButton(true)).toBe(true);
  });
});
