import type { SimpleSendMode } from '../../hooks/simple-send/types';

/** Keep the authorized plan visible while signing and submitting it. */
export function shouldShowSendReview(
  mode: SimpleSendMode,
  hasReview: boolean
): boolean {
  return hasReview && (mode === 'review' || mode === 'sending');
}
