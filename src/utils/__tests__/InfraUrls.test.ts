import { describe, expect, it } from 'vitest';

import { getElectrumServers, getInfraUrlPools } from '../servers/InfraUrls';
import { Network } from '../../state/slices/networkSlice';

describe('InfraUrls', () => {
  it('seeds WSS-verified mainnet electrum servers, imaginary.cash first', () => {
    // The list is the Electron Cash server set filtered to those that actually
    // accept a WebSocket connection on 50004 (see InfraUrls.ts). In the test
    // environment (no Tauri global) only the web/WSS list is returned.
    const servers = getElectrumServers(Network.MAINNET);
    expect(servers[0]).toBe('electrum.imaginary.cash');
    expect(servers).toContain('bch.imaginary.cash');
    // The old default explorer.bch.ninja was dropped — it fails WSS with a
    // certificate-hostname mismatch.
    expect(servers).not.toContain('explorer.bch.ninja');
    // Desktop-only TCP-SSL servers must not leak into the web list.
    expect(servers).not.toContain('bch0.kister.net');
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
