import { describe, expect, it } from 'vitest';
import { describeConnectorRequest } from '../requestDescription';

describe('connector request descriptions', () => {
  it('turns a Cauldron BCH-to-token prompt into a concise swap summary', () => {
    expect(
      describeConnectorRequest('Cauldron swap 0.00999962 BCH -> PUSD')
    ).toEqual({
      titleKey: 'txReview.cauldronSwap',
      detail: '0.00999962 BCH → PUSD',
      tokenLabel: 'PUSD',
    });
  });

  it('keeps an unknown prompt as app-provided context', () => {
    expect(describeConnectorRequest('Review this custom action')).toEqual({
      titleKey: 'txReview.transactionRequest',
      detail: 'Review this custom action',
      tokenLabel: null,
    });
  });

  it('does not invent a description when the request has no prompt', () => {
    expect(describeConnectorRequest(undefined)).toEqual({
      titleKey: 'txReview.transactionRequest',
      detail: null,
      tokenLabel: null,
    });
  });
});
