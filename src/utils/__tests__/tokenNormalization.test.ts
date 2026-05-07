import { describe, expect, it } from 'vitest';
import { normalizeTokenField } from '../tokenNormalization';

describe('normalizeTokenField', () => {
  it('normalizes Electrum-style token payloads', () => {
    expect(
      normalizeTokenField({
        token_category: 'a'.repeat(64),
        fungible_token_amount: '25',
        nonfungible_token_capability: 'mutable',
        nonfungible_token_commitment: 'abcd',
      })
    ).toEqual({
      category: 'a'.repeat(64),
      amount: 25,
      nft: {
        capability: 'mutable',
        commitment: 'abcd',
      },
    });
  });

  it('normalizes nested token payloads', () => {
    expect(
      normalizeTokenField({
        token_data: {
          token_id: 'b'.repeat(64),
          tokenAmount: 7,
        },
      })
    ).toEqual({
      category: 'b'.repeat(64),
      amount: 7,
      nft: undefined,
    });
  });
});
