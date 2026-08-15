import { describe, expect, it } from 'vitest';
import { Network } from '../../../../state/slices/networkSlice';
import {
  getDefaultMerchantStablecoin,
  getMerchantStablecoins,
  isMerchantStablecoin,
} from '../merchantStablecoins';

describe('merchantStablecoins', () => {
  it('returns the expected merchant stablecoins on mainnet', () => {
    const stablecoins = getMerchantStablecoins(Network.MAINNET);
    expect(stablecoins).toEqual([
      {
        tokenId:
          '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
        symbol: 'PUSD',
        name: 'ParyonUSD',
        decimals: 2,
      },
      {
        tokenId:
          'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
        symbol: 'MUSD',
        name: 'Moria USD',
        decimals: 2,
      },
    ]);
    expect(getDefaultMerchantStablecoin(Network.MAINNET)).toEqual(
      stablecoins[0]
    );
  });

  it('returns the chipnet PUSD stablecoin and validates token ids', () => {
    const stablecoins = getMerchantStablecoins(Network.CHIPNET);
    expect(stablecoins).toEqual([
      {
        tokenId:
          'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
        symbol: 'PUSD',
        name: 'ParyonUSD',
        decimals: 2,
      },
    ]);
    expect(isMerchantStablecoin(Network.CHIPNET, stablecoins[0].tokenId)).toBe(
      true
    );
    expect(
      isMerchantStablecoin(
        Network.CHIPNET,
        'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366'
      )
    ).toBe(false);
  });
});
