import { describe, expect, it } from 'vitest';
import type { TransactionOutput, UTXO } from '../../../types/types';
import { summarizeBuilderReview } from '../builderReview';

const input: UTXO = {
  address: 'bchtest:qsource',
  height: 1,
  tx_hash: 'aa'.repeat(32),
  tx_pos: 0,
  value: 100_000,
  token: {
    category: 'bb'.repeat(32),
    amount: 10n,
    nft: { capability: 'minting', commitment: 'abcd' },
  },
};

describe('custom transaction review', () => {
  it('shows whole-transaction fee after change and preserves token accounting', () => {
    const outputs: TransactionOutput[] = [
      {
        recipientAddress: 'bchtest:qrecipient',
        amount: 10_000,
        token: { category: input.token!.category, amount: 4n },
      },
      {
        recipientAddress: 'bchtest:qchange',
        amount: 89_900,
        token: {
          category: input.token!.category,
          amount: 6n,
          nft: input.token!.nft,
        },
      },
    ];
    expect(summarizeBuilderReview([input], outputs)).toEqual({
      feeSats: 100,
      unaccountedTokens: [],
    });
  });

  it('flags missing fungible amount or NFT before confirmation', () => {
    const output: TransactionOutput = {
      recipientAddress: 'bchtest:qrecipient',
      amount: 99_900,
      token: { category: input.token!.category, amount: 9n },
    };
    expect(summarizeBuilderReview([input], [output]).unaccountedTokens).toEqual(
      [input.token!.category]
    );
  });
});
