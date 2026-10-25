import { describe, expect, it } from 'vitest';
import { shouldShowSendReview } from '../reviewVisibility';

describe('send review visibility', () => {
  it('keeps the authorized plan visible while signing and submitting', () => {
    expect(shouldShowSendReview('review', true)).toBe(true);
    expect(shouldShowSendReview('sending', true)).toBe(true);
  });

  it('requires a review and closes after a terminal transition', () => {
    expect(shouldShowSendReview('sending', false)).toBe(false);
    expect(shouldShowSendReview('idle', true)).toBe(false);
    expect(shouldShowSendReview('sent', true)).toBe(false);
    expect(shouldShowSendReview('error', true)).toBe(false);
  });
});
