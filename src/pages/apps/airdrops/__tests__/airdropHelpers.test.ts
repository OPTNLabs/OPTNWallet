import { describe, expect, it } from 'vitest';
import {
  describeAmountRule,
  hasAirdropTokenHoldings,
  normalizeAddressKey,
  normalizeTokenHolderBalance,
  parseRecipientText,
  shortenMiddle,
} from '../airdropHelpers';

describe('airdropHelpers', () => {
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

  it('keeps NFT-only categories visible for airdrop selection', () => {
    expect(
      hasAirdropTokenHoldings({
        tokenBalance: '0',
        nftCommitments: ['abcd'],
      })
    ).toBe(true);
    expect(
      hasAirdropTokenHoldings({
        tokenBalance: '12',
        nftCommitments: [],
      })
    ).toBe(true);
    expect(
      hasAirdropTokenHoldings({
        tokenBalance: '0',
        nftCommitments: [],
      })
    ).toBe(false);
  });

  it('treats NFT-only holder rows as present when there is at least one token UTXO', () => {
    expect(
      normalizeTokenHolderBalance({
        ftBalance: '0',
        utxoCount: 3,
      })
    ).toBe(1n);
    expect(
      normalizeTokenHolderBalance({
        ftBalance: '42',
        utxoCount: 3,
      })
    ).toBe(42n);
    expect(
      normalizeTokenHolderBalance({
        ftBalance: '0',
        utxoCount: 0,
      })
    ).toBe(0n);
  });
});
