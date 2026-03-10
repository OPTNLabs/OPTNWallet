import { describe, expect, it } from 'vitest';
import { normalizeWalletAddressCandidate } from '../helpers';

describe('walletconnect address normalization security', () => {
  const prefix = 'bitcoincash:';

  it('accepts already-prefixed cashaddr', () => {
    expect(
      normalizeWalletAddressCandidate('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', prefix)
    ).toBe('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  });

  it('normalizes CAIP-10 BCH account strings', () => {
    expect(
      normalizeWalletAddressCandidate(
        'bch:bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        prefix
      )
    ).toBe('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  });

  it('rejects unsupported namespace-style values', () => {
    expect(
      normalizeWalletAddressCandidate(
        'ethereum:0x1234',
        prefix
      )
    ).toBeNull();
  });
});
