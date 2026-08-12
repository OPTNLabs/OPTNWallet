import { describe, expect, it } from 'vitest';
import type { BcmrSnapshot, BcmrTokenMetadataState } from '../../types/bcmr';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
  shortTokenCategory,
} from '../tokenPresentation';

function makeMetadata(): BcmrTokenMetadataState {
  const snapshot = {
    name: 'Sample Token',
    description: 'A sample token used in tests.',
    token: {
      category: '0123456789abcdef',
      symbol: 'SMP',
      decimals: 2,
    },
    uris: {
      icon: 'https://example.com/icon.png',
    },
    extensions: {},
  } as BcmrSnapshot;

  return {
    status: 'ready',
    freshness: 'fresh',
    name: 'Sample Token',
    symbol: 'SMP',
    decimals: 2,
    iconUri: 'https://example.com/icon.png',
    snapshot,
    isRefreshing: false,
  };
}

describe('tokenPresentation', () => {
  it('formats atomic token amounts without losing precision', () => {
    expect(formatAtomicTokenAmount(1234500n, 4)).toBe('123.45');
    expect(formatAtomicTokenAmount(5n, 8)).toBe('0.00000005');
    expect(formatAtomicTokenAmount(123n, 0)).toBe('123');
  });

  it('uses BCMR metadata first and hides status once loaded', () => {
    const presentation = resolveTokenPresentation(
      '0123456789abcdef',
      makeMetadata()
    );

    expect(presentation.primaryLabel).toBe('Sample Token');
    expect(presentation.secondaryLabel).toBe('SMP');
    expect(presentation.decimals).toBe(2);
    expect(presentation.iconUri).toBe('https://example.com/icon.png');
    expect(presentation.statusLabel).toBeNull();
    expect(presentation.statusTone).toBeNull();
  });

  it('shows a status while bcmr metadata is still loading', () => {
    const presentation = resolveTokenPresentation(
      '0123456789abcdef',
      {
        ...makeMetadata(),
        status: 'loading',
        freshness: 'refreshing',
        isRefreshing: true,
      }
    );

    expect(presentation.statusLabel).toBe('Refreshing');
    expect(presentation.statusTone).toBe('accent');
  });

  it('falls back to local token data before a shortened category hash', () => {
    const presentation = resolveTokenPresentation(
      '0123456789abcdef',
      null,
      {
        name: 'Local Token',
        symbol: 'LT',
        decimals: 0,
        iconUri: '/local-icon.png',
      }
    );

    expect(presentation.primaryLabel).toBe('Local Token');
    expect(presentation.secondaryLabel).toBe('LT');
    expect(presentation.iconUri).toBe('/local-icon.png');
    expect(presentation.statusLabel).toBeNull();
    expect(presentation.statusTone).toBeNull();
    expect(shortTokenCategory('0123456789abcdef')).toBe('0123...cdef');
  });
});
