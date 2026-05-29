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
  getCachedTokenMetadata,
  preloadTokenMetadata,
} from '../useSharedTokenMetadata';

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
});
