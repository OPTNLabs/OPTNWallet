import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipfsFetch, resolveIpfsGatewayUrl } from '../ipfs';
import { getInfraUrlPools, runWithFailover } from '../servers/InfraUrls';

vi.mock('../../redux/store', () => ({
  store: {
    getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
  },
}));

vi.mock('../servers/InfraUrls', () => ({
  getInfraUrlPools: vi.fn(),
  runWithFailover: vi.fn(),
}));

describe('ipfsFetch', () => {
  const mockedGetInfraUrlPools = vi.mocked(getInfraUrlPools);
  const mockedRunWithFailover = vi.mocked(runWithFailover);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetInfraUrlPools.mockReturnValue({
      electrumServers: [],
      chaingraphUrls: [],
      bcmrApiBaseUrls: [],
      ipfsGateways: ['https://gw1.example/ipfs', 'https://gw2.example/ipfs'],
      ipfsUploadRelayBases: [],
    });
  });

  it('fails over between configured IPFS gateways', async () => {
    const okResp = { ok: true, status: 200 } as Response;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('gw1.example')) {
        throw new Error('network down');
      }
      return okResp;
    });
    vi.stubGlobal('fetch', fetchMock);

    mockedRunWithFailover.mockImplementation(async (_poolKey, endpoints, runner) => {
      const errors: string[] = [];
      for (const endpoint of endpoints) {
        try {
          return await runner(endpoint);
        } catch (err) {
          errors.push(String(err));
        }
      }
      throw new Error(errors.join(' | '));
    });

    const resp = await ipfsFetch('ipfs://QmHash/file.json');
    expect(resp).toBe(okResp);
    expect(mockedRunWithFailover).toHaveBeenCalledWith(
      'ipfs:mainnet',
      ['https://gw1.example/ipfs', 'https://gw2.example/ipfs'],
      expect.any(Function)
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes non-IPFS URLs by prepending https', async () => {
    const okResp = { ok: true, status: 200 } as Response;
    const fetchMock = vi.fn(async () => okResp);
    vi.stubGlobal('fetch', fetchMock);

    const resp = await ipfsFetch('example.com/resource.json');
    expect(resp).toBe(okResp);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/resource.json',
      undefined
    );
  });

  it('resolves IPFS URIs to the primary configured gateway URL', () => {
    expect(resolveIpfsGatewayUrl('ipfs://QmHash/file.json')).toBe(
      'https://gw1.example/ipfs/QmHash/file.json'
    );
  });
});
