import { describe, expect, it } from 'vitest';

import { getElectrumServers, getInfraUrlPools } from '../servers/InfraUrls';
import { Network } from '../../redux/networkSlice';

describe('InfraUrls', () => {
  it('prefers imaginary.cash electrum servers on mainnet', () => {
    expect(getElectrumServers(Network.MAINNET)).toEqual([
      'electrum.imaginary.cash',
      'bch.imaginary.cash',
      'explorer.bch.ninja',
    ]);
  });

  it('prefers tokenindexer for BCMR and keeps bcmr-indexer as fallback', () => {
    expect(getInfraUrlPools(Network.MAINNET).bcmrNativeBaseUrls).toEqual([
      'https://tokenindex.optnlabs.com/v1',
    ]);

    expect(getInfraUrlPools(Network.MAINNET).bcmrApiBaseUrls).toEqual([
      'https://bcmr.optnlabs.com/api',
      'https://bcmr.paytaca.com/api',
    ]);

    expect(getInfraUrlPools(Network.CHIPNET).bcmrApiBaseUrls).toEqual([
      'https://bcmr.optnlabs.com/api',
      'https://bcmr-chipnet.paytaca.com/api',
    ]);
  });
});
