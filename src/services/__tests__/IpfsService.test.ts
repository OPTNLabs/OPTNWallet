import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildIpfsGatewayUrl,
  uploadToIpfsRelay,
} from '../IpfsService';

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
});
