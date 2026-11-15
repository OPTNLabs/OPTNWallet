import { describe, expect, it } from 'vitest';

import {
  getBcmrNativeTokenUrls,
  getElectrumServers,
  getInfraUrlPools,
  runWithFailover,
} from '../servers/InfraUrls';
import { Network } from '../../state/slices/networkSlice';

describe('InfraUrls', () => {
  it('includes the verified Selene public mainnet WSS pool', () => {
    // In the test environment (no Tauri global) only the web/WSS list is
    // returned.
    const servers = getElectrumServers(Network.MAINNET);
    expect(servers[0]).toBe('electrum.imaginary.cash:50004');
    expect(servers).toEqual([
      'electrum.imaginary.cash:50004',
      'cashnode.bch.ninja:443',
      'bch.imaginary.cash:50004',
      'electroncash.dk:50004',
      'blackie.c3-soft.com:50004',
      'bch.loping.net:50004',
      'bch.soul-dev.com:50004',
      'fulcrum.criptolayer.net:50004',
      'fulcrum.jettscythe.xyz:50004',
    ]);
    // The old default explorer.bch.ninja was dropped — it fails WSS with a
    // certificate-hostname mismatch.
    expect(servers).not.toContain('explorer.bch.ninja');
    // Desktop-only TCP-SSL servers must not leak into the web list.
    expect(servers).not.toContain('bch0.kister.net');
  });

  it('keeps public BCMR routes available alongside the TokenIndexer route', () => {
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

    expect(
      getBcmrNativeTokenUrls(
        Network.CHIPNET,
        '4a3cac0663c121e976c7ad6783dfadab0d05c0700ef1d2cc75a0579a6ea431f4'
      )
    ).toEqual([
      'https://tokenindex.optnlabs.com/v1/token/4a3cac0663c121e976c7ad6783dfadab0d05c0700ef1d2cc75a0579a6ea431f4',
    ]);
  });

  it('keeps only live Chipnet WSS routes in the browser pool', () => {
    const servers = getInfraUrlPools(Network.CHIPNET).electrumServers;
    expect(servers).toEqual([
      'electrum-chipnet.optnlabs.com:50004',
      'chipnet.bch.ninja:50004',
      'chipnet.imaginary.cash:50004',
      'chipnet.c3-soft.com:64004',
    ]);
  });

  it('remembers the successful public fallback endpoint for the next request', async () => {
    const poolKey = 'test:bcmr-failover-memory';
    const endpoints = ['https://owned.example', 'https://public.example'];
    const calls: string[] = [];

    await runWithFailover(poolKey, endpoints, async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === endpoints[0]) throw new Error('owned endpoint down');
      return endpoint;
    });

    calls.length = 0;
    await runWithFailover(poolKey, endpoints, async (endpoint) => {
      calls.push(endpoint);
      return endpoint;
    });

    expect(calls).toEqual([endpoints[1]]);
  });
});
