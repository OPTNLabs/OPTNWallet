import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPlatformMock, bcmrInstance } = vi.hoisted(() => ({
  getPlatformMock: vi.fn(() => 'web'),
  bcmrInstance: {
    getSnapshot: vi.fn(),
    getCategoryAuthbase: vi.fn(),
    resolveIcon: vi.fn(),
    resolveIdentityRegistry: vi.fn(),
    resolveCategorySpecificRegistry: vi.fn(),
    extractIdentityByCategory: vi.fn(),
  },
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: getPlatformMock,
      isNativePlatform: vi.fn(() => false),
    },
  };
});

vi.mock('../../services/BcmrService', () => ({
  default: vi.fn().mockImplementation(() => bcmrInstance),
}));

import {
  buildSharedTokenCategoriesKey,
  getCachedTokenMetadata,
  isTokenMetadataRefreshDue,
  METADATA_REFRESH_TTL_MS,
  preloadTokenMetadata,
  normalizeSharedTokenCategories,
  resolveTokenMetadata,
} from '../useSharedTokenMetadata';
import type { SharedTokenMetadata } from '../useSharedTokenMetadata';

describe('useSharedTokenMetadata web preload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatformMock.mockReturnValue('web');
    bcmrInstance.getSnapshot.mockResolvedValue({
      name: 'Alpha Token',
      description: '',
      token: {
        category: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        symbol: 'ALPHA',
        decimals: 0,
      },
      is_nft: false,
      uris: {},
      extensions: {},
    });
    bcmrInstance.getCategoryAuthbase.mockResolvedValue(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });

  it('uses cached BCMR data without hitting the refresh path in web runtime', async () => {
    await preloadTokenMetadata([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);

    expect(bcmrInstance.getSnapshot).toHaveBeenCalledWith(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(bcmrInstance.getCategoryAuthbase).not.toHaveBeenCalled();
    expect(bcmrInstance.resolveIcon).not.toHaveBeenCalled();
    expect(bcmrInstance.resolveIdentityRegistry).not.toHaveBeenCalled();
    expect(bcmrInstance.resolveCategorySpecificRegistry).not.toHaveBeenCalled();

    expect(
      getCachedTokenMetadata(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).toMatchObject({
      status: 'ready',
      freshness: 'cached',
      snapshot: {
        token: {
          symbol: 'ALPHA',
        },
      },
    });
  });

  it('fetches live BCMR metadata in web runtime when no cached snapshot exists', async () => {
    const category =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const authbase = category;
    const registry = {
      registryUri: `https://bcmr.example/api/registries/${authbase}/latest`,
      registryHash: 'registry-hash-beta',
      lastFetch: '2026-06-11T00:00:00.000Z',
      registry: {
        identities: {
          [authbase]: {
            '2026-06-11T00:00:00.000Z': {
              name: 'Beta Token',
              description: 'Fetched live from BCMR',
              token: {
                category,
                symbol: 'BETA',
                decimals: 2,
              },
              uris: {
                icon: 'ipfs://beta-icon',
              },
            },
          },
        },
      },
    };

    bcmrInstance.getSnapshot.mockResolvedValueOnce(null);
    bcmrInstance.getCategoryAuthbase.mockResolvedValueOnce(authbase);
    bcmrInstance.resolveIdentityRegistry.mockResolvedValueOnce(registry);
    bcmrInstance.extractIdentityByCategory.mockReturnValueOnce({
      name: 'Beta Token',
      description: 'Fetched live from BCMR',
      token: {
        category,
        symbol: 'BETA',
        decimals: 2,
      },
      uris: {
        icon: 'ipfs://beta-icon',
      },
    });
    bcmrInstance.resolveIcon.mockResolvedValueOnce(
      'https://icons.example/beta.png'
    );

    const result = await resolveTokenMetadata(category);

    expect(bcmrInstance.getSnapshot).toHaveBeenCalledWith(category);
    expect(bcmrInstance.getCategoryAuthbase).toHaveBeenCalledWith(category);
    expect(bcmrInstance.resolveIdentityRegistry).toHaveBeenCalledWith(authbase);
    expect(bcmrInstance.extractIdentityByCategory).toHaveBeenCalledWith(
      category,
      registry.registry
    );
    expect(bcmrInstance.resolveIcon).toHaveBeenCalledWith(
      authbase,
      undefined,
      category
    );
    expect(result).toMatchObject({
      status: 'ready',
      freshness: 'fresh',
      name: 'Beta Token',
      symbol: 'BETA',
      decimals: 2,
      iconUri: 'https://icons.example/beta.png',
      registryUri: registry.registryUri,
      registryHash: registry.registryHash,
      snapshot: {
        name: 'Beta Token',
        token: {
          category,
          symbol: 'BETA',
          decimals: 2,
        },
      },
    });
  });

  it('builds a stable category key from duplicate or reordered input', () => {
    const first = buildSharedTokenCategoriesKey([
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    const second = buildSharedTokenCategoriesKey([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);

    expect(first).toBe(second);
    expect(normalizeSharedTokenCategories([
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ])).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('does not force-refresh recent metadata on every screen mount', () => {
    const now = Date.parse('2026-06-11T00:04:00.000Z');
    const recent: SharedTokenMetadata = {
      status: 'ready' as const,
      freshness: 'cached' as const,
      name: 'Alpha Token',
      symbol: 'ALPHA',
      decimals: 0,
      iconUri: null,
      snapshot: { lastFetch: '2026-06-11T00:00:00.000Z' },
      lastFetch: '2026-06-11T00:00:00.000Z',
      isRefreshing: false,
    };

    expect(isTokenMetadataRefreshDue(recent, now)).toBe(false);
    expect(
      isTokenMetadataRefreshDue(recent, now + METADATA_REFRESH_TTL_MS)
    ).toBe(true);
  });

  it('uses a recent persisted snapshot before considering a native refresh', async () => {
    const category =
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    getPlatformMock.mockReturnValue('android');
    bcmrInstance.getSnapshot.mockResolvedValueOnce({
      name: 'Cached Native Token',
      description: '',
      token: { category, symbol: 'CACHED', decimals: 0 },
      is_nft: false,
      uris: {},
      extensions: {},
      lastFetch: new Date(Date.now() - 1_000).toISOString(),
    });
    bcmrInstance.getCategoryAuthbase.mockResolvedValueOnce(category);
    bcmrInstance.resolveIcon.mockResolvedValueOnce(null);

    await preloadTokenMetadata([category]);

    expect(bcmrInstance.resolveIdentityRegistry).not.toHaveBeenCalled();
  });
});
