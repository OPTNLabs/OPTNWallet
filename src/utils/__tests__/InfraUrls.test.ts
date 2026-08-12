import { describe, expect, it } from 'vitest';

import { getElectrumServers } from '../servers/InfraUrls';
import { Network } from '../../redux/networkSlice';

describe('InfraUrls', () => {
  it('prefers imaginary.cash electrum servers on mainnet', () => {
    expect(getElectrumServers(Network.MAINNET)).toEqual([
      'electrum.imaginary.cash',
      'bch.imaginary.cash',
      'explorer.bch.ninja',
    ]);
  });
});
