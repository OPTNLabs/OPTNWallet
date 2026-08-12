import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildIpfsGatewayUrl,
  uploadToIpfsRelay,
  waitForIpfsAvailability,
} from '../IpfsService';

vi.mock('../../redux/store', () => ({
  store: {
    getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
  },
}));

vi.mock('../../utils/servers/InfraUrls', async () => {
  const actual = await vi.importActual('../../utils/servers/InfraUrls');
  return {
    ...(actual as object),
    getInfraUrlPools: vi.fn(() => ({
      electrumServers: [],
      chaingraphUrls: [],
      bcmrApiBaseUrls: [],
      ipfsGateways: ['https://ipfs.optnlabs.com/ipfs', 'https://ipfs.io/ipfs'],
      ipfsUploadRelayBases: [
        'https://upload.optnlabs.com',
        'https://ipfs-api.optnlabs.com',
      ],
    })),
  };
});

describe('IpfsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildIpfsGatewayUrl formats gateway URL', () => {
    expect(buildIpfsGatewayUrl('bafy123')).toBe(
      'https://ipfs.optnlabs.com/ipfs/bafy123'
    );
    expect(buildIpfsGatewayUrl('QmHash', 'https://ipfs.example.com/')).toBe(
      'https://ipfs.example.com/ipfs/QmHash'
    );
  });

  it('uploadToIpfsRelay parses successful response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'upload.bin',
          cid: 'bafycid',
          size: '42',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = new Blob(['hello world'], { type: 'text/plain' });
    const result = await uploadToIpfsRelay(file, {
      filename: 'hello.txt',
      relayBase: 'https://upload.optnlabs.com',
      gatewayBase: 'https://ipfs.optnlabs.com',
    });

    expect(result).toEqual({
      name: 'upload.bin',
      cid: 'bafycid',
      size: 42,
      url: 'https://ipfs.optnlabs.com/ipfs/bafycid',
      gatewayUrl: 'https://ipfs.optnlabs.com/ipfs/bafycid',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe('https://upload.optnlabs.com/v1/ipfs/add');
    expect(init.method).toBe('POST');
    expect(init.body instanceof FormData).toBe(true);
  });

  it('uploadToIpfsRelay fails over to the IPFS API endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Name: 'hello.txt',
            Hash: 'bafyfallback',
            Size: '42',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const file = new Blob(['hello world'], { type: 'text/plain' });
    const result = await uploadToIpfsRelay(file, {
      filename: 'hello.txt',
      gatewayBase: 'https://ipfs.optnlabs.com',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://upload.optnlabs.com/v1/ipfs/add',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://ipfs-api.optnlabs.com/api/v0/add?pin=true',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.cid).toBe('bafyfallback');
  });

  it('uploadToIpfsRelay surfaces HTTP status and response snippet on error', async () => {
    const fetchMock = vi.fn(async () => new Response('relay unavailable', { status: 503, statusText: 'Service Unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new Blob(['x'], { type: 'application/octet-stream' });

    await expect(
      uploadToIpfsRelay(file, { filename: 'x.bin' })
    ).rejects.toThrow(
      'IPFS upload failed: HTTP 503 Service Unavailable. relay unavailable'
    );
  });

  it('waitForIpfsAvailability polls until content is reachable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('not ready', {
          status: 404,
          statusText: 'Not Found',
        })
      )
      .mockResolvedValueOnce(
        new Response('ready', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await waitForIpfsAvailability('ipfs://bafycid', {
      timeoutMs: 2_000,
      pollIntervalMs: 1,
      validateResponse: async (response) => {
        await expect(response.text()).resolves.toBe('ready');
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://ipfs.optnlabs.com/ipfs/bafycid',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://ipfs.io/ipfs/bafycid',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('waitForIpfsAvailability surfaces validator failures after timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('wrong-body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForIpfsAvailability('ipfs://bafycid', {
        timeoutMs: 20,
        pollIntervalMs: 1,
        validateResponse: async (response) => {
          const body = await response.text();
          if (body !== 'expected-body') {
            throw new Error('Body mismatch');
          }
        },
      })
    ).rejects.toThrow('IPFS content was not reachable in time');
  });
});
