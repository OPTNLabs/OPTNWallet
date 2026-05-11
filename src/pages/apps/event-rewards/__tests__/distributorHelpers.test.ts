import { describe, expect, it } from 'vitest';
import {
  describeAmountRule,
  normalizeAddressKey,
  parseRecipientText,
  shortenMiddle,
} from '../distributorHelpers';

describe('distributorHelpers', () => {
  it('parses recipient text from common formats', () => {
    const rows = parseRecipientText(
      '["bitcoincash:qq123", {"address":"bchtest:qp456"}]'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.address).toBe('bitcoincash:qq123');
    expect(rows[1]?.address).toBe('bchtest:qp456');
  });

  it('normalizes display helpers consistently', () => {
    expect(shortenMiddle('abcdef', 2, 2)).toBe('ab...ef');
    expect(normalizeAddressKey('  ABC  ')).toBe('abc');
    expect(describeAmountRule('tiered_balance')).toBe('Balance tiers');
  });
});
