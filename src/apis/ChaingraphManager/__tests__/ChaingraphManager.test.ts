import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  queryTotalSupplyFT,
  queryUnspentOutputsByLockingBytecode,
  stripChaingraphHexBytes,
} from '../ChaingraphManager';
import { getInfraUrlPools, runWithFailover } from '../../../utils/servers/InfraUrls';

vi.mock('../../../redux/store', () => ({
  store: {
    getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
  },
}));

vi.mock('../../../utils/servers/InfraUrls', () => ({
  getInfraUrlPools: vi.fn(),
  runWithFailover: vi.fn(),
}));

describe('ChaingraphManager', () => {
  const mockedGetInfraUrlPools = vi.mocked(getInfraUrlPools);
  const mockedRunWithFailover = vi.mocked(runWithFailover);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetInfraUrlPools.mockReturnValue({
      chaingraphUrls: ['https://chaingraph.example/graphql'],
      electrumServers: [],
      bcmrApiBaseUrls: [],
      ipfsGateways: [],
      ipfsUploadRelayBases: [],
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { ok: true } }),
    })));

    mockedRunWithFailover.mockImplementation(async (_poolKey, endpoints, runner) => {
      return runner(endpoints[0]);
    });
  });

  it('queryTotalSupplyFT normalizes token id and issues GraphQL query', async () => {
    const res = await queryTotalSupplyFT('0xABC123');

    expect(res).toEqual({ data: { ok: true } });
    expect(mockedRunWithFailover).toHaveBeenCalledTimes(1);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.query).toContain('\\xabc123');
  });

  it('queryUnspentOutputsByLockingBytecode normalizes lock script and token id', async () => {
    await queryUnspentOutputsByLockingBytecode('\\xDEADbeef', '0xCAFE');

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(body.query).toContain('\\xdeadbeef');
    expect(body.query).toContain('\\xcafe');
  });

  it('stripChaingraphHexBytes strips \\x and 0x prefixes', () => {
    expect(stripChaingraphHexBytes('\\xABCD')).toBe('abcd');
    expect(stripChaingraphHexBytes('0xABCD')).toBe('abcd');
    expect(stripChaingraphHexBytes('abcd')).toBe('abcd');
    expect(stripChaingraphHexBytes(null)).toBe('');
  });
});
