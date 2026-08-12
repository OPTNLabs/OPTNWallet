import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  getCreatedWalletPoolsStorageKey,
  getWalletPoolsStorageKey,
  shortTokenId,
} from '../cauldronHelpers';

describe('cauldronHelpers', () => {
  it('keeps the shared token id shortening stable', () => {
    expect(shortTokenId('0123456789abcdef')).toBe('0123...cdef');
  });

  it('formats timestamps consistently', () => {
    const value = formatTimestamp(1);
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('scopes wallet pool storage by wallet id', () => {
    expect(getWalletPoolsStorageKey('mainnet', 7)).toBe(
      'optn.cauldron.wallet-pools:mainnet:7'
    );
    expect(getCreatedWalletPoolsStorageKey('mainnet', 7)).toBe(
      'optn.cauldron.created-wallet-pools:mainnet:7'
    );
  });
});
