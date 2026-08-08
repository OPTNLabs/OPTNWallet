import { describe, expect, it, vi } from 'vitest';

type MockClient = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  connection: {
    send: ReturnType<typeof vi.fn>;
  };
  requestId: number;
  requestResolvers: Record<number, (error?: Error, data?: unknown) => void>;
  __emit: (event: string, payload: unknown) => void;
};

function makeMockClient(): MockClient {
  const handlers = new Map<string, Array<(x: unknown) => void>>();
  const mock: MockClient = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    request: vi.fn(async () => 'ok'),
    subscribe: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (x: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    connection: {
      send: vi.fn((message: string) => {
        const parsed = JSON.parse(message) as Array<{ id: number }> | { id: number };
        const responses = Array.isArray(parsed)
          ? parsed.map((item) => ({ id: item.id, result: `batched-${item.id}` }))
          : [{ id: parsed.id, result: `batched-${parsed.id}` }];
        queueMicrotask(() => {
          for (const response of responses) {
            const resolver = mock.requestResolvers[response.id];
            resolver?.(undefined, response.result);
            delete mock.requestResolvers[response.id];
          }
        });
        return true;
      }),
    },
    requestId: 0,
    requestResolvers: {},
    __emit: (event: string, payload: unknown) => {
      const list = handlers.get(event) ?? [];
      for (const cb of list) cb(payload);
    },
  };
  return mock;
}

async function loadServerWithMocks(
  clients: MockClient[],
  servers: string[] = ['wss://electrum.example:50004']
) {
  vi.resetModules();

  const ElectrumClient = vi.fn();
  for (const c of clients) {
    ElectrumClient.mockImplementationOnce(() => c);
  }

  vi.doMock('@electrum-cash/network', () => ({
    ElectrumClient,
  }));

  vi.doMock('@electrum-cash/web-socket', () => ({
    ElectrumWebSocket: vi.fn(),
  }));

  vi.doMock('../../../state/store', () => ({
    store: {
      getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
    },
  }));

  vi.doMock('../../../state/selectors/networkSelectors', () => ({
    selectCurrentNetwork: vi.fn(() => 'mainnet'),
  }));

  vi.doMock('../../../utils/servers/ElectrumServers', () => ({
    getElectrumServers: vi.fn(() => servers),
  }));

  const mod = await import('../ElectrumServer');
  return mod.default();
}

async function loadServerWithMocksAndSpies(
  clients: MockClient[],
  servers: string[]
) {
  vi.resetModules();

  const ElectrumClient = vi.fn();
  for (const c of clients) {
    ElectrumClient.mockImplementationOnce(() => c);
  }

  const ElectrumWebSocket = vi.fn();

  vi.doMock('@electrum-cash/network', () => ({
    ElectrumClient,
  }));

  vi.doMock('@electrum-cash/web-socket', () => ({
    ElectrumWebSocket,
  }));

  vi.doMock('../../../state/store', () => ({
    store: {
      getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
    },
  }));

  vi.doMock('../../../state/selectors/networkSelectors', () => ({
    selectCurrentNetwork: vi.fn(() => 'mainnet'),
  }));

  vi.doMock('../../../utils/servers/ElectrumServers', () => ({
    getElectrumServers: vi.fn(() => servers),
  }));

  const mod = await import('../ElectrumServer');
  return { server: mod.default(), ElectrumWebSocket };
}

describe('ElectrumServer', () => {
  it('request retries after a failed request by reconnecting', async () => {
    const first = makeMockClient();
    const second = makeMockClient();

    first.request.mockRejectedValueOnce(new Error('temporary failure'));
    second.request.mockResolvedValueOnce('retry-ok');

    const server = await loadServerWithMocks([first, second]);
    const res = await server.request('blockchain.headers.get_tip');

    expect(res).toBe('retry-ok');
    expect(first.request).toHaveBeenCalledWith('blockchain.headers.get_tip');
    expect(first.disconnect).toHaveBeenCalledWith(true);
    expect(second.request).toHaveBeenCalledWith('blockchain.headers.get_tip');
  });

  it('requestMany sends one batched payload and resolves responses by id', async () => {
    const client = makeMockClient();
    const server = await loadServerWithMocks([client]);

    const results = await server.requestMany([
      { method: 'server.ping', params: [] },
      { method: 'server.version', params: ['probe', '1.4'] },
    ]);

    expect(client.connection.send).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['batched-1', 'batched-2']);
  });

  it('scales requestMany timeout with batch size (evidence: requestMany(250) @ 12s)', async () => {
    // Live error: `requestMany(250) timed out after 12000ms` with a flat budget.
    // Formula must exceed 12s for N=250 while single calls stay ~12s.
    const { requestManyTimeoutMs } = await import('../ElectrumServer');
    expect(requestManyTimeoutMs(1)).toBe(12_000);
    expect(requestManyTimeoutMs(250)).toBeGreaterThan(12_000);
    expect(requestManyTimeoutMs(250)).toBe(12_000 + 249 * 80);
    expect(requestManyTimeoutMs(10_000)).toBe(90_000); // cap
  });

  it('requestMany rotates servers when every batch entry reports a lost connection', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    first.connection.send.mockImplementationOnce((message: string) => {
      const parsed = JSON.parse(message) as Array<{ id: number }>;
      queueMicrotask(() => {
        for (const { id } of parsed) {
          first.requestResolvers[id]?.(new Error('Connection lost'));
          delete first.requestResolvers[id];
        }
      });
      return true;
    });
    const server = await loadServerWithMocks(
      [first, second],
      ['wss://stale.example:50004', 'wss://healthy.example:50004']
    );

    const results = await server.requestMany([
      { method: 'blockchain.address.listunspent', params: ['bitcoincash:q1'] },
      { method: 'blockchain.address.listunspent', params: ['bitcoincash:q2'] },
    ]);

    expect(results).toEqual(['batched-1', 'batched-2']);
    expect(first.disconnect).toHaveBeenCalledWith(true);
    expect(second.connection.send).toHaveBeenCalledTimes(1);
  });

  it('requestMany retries only transport-failed members on another server', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    first.connection.send.mockImplementationOnce((message: string) => {
      const parsed = JSON.parse(message) as Array<{ id: number }>;
      queueMicrotask(() => {
        first.requestResolvers[parsed[0].id]?.(undefined, ['first-ok']);
        first.requestResolvers[parsed[1].id]?.(new Error('Connection lost'));
      });
      return true;
    });
    const server = await loadServerWithMocks(
      [first, second],
      ['wss://stale.example:50004', 'wss://healthy.example:50004']
    );
    const calls = [
      { method: 'blockchain.scripthash.listunspent', params: ['hash-1'] },
      { method: 'blockchain.scripthash.listunspent', params: ['hash-2'] },
    ];

    const results = await server.requestMany(calls);

    expect(results).toEqual([['first-ok'], 'batched-1']);
    expect(first.disconnect).toHaveBeenCalledWith(true);
    expect(second.connection.send).toHaveBeenCalledTimes(1);
    const retried = JSON.parse(second.connection.send.mock.calls[0][0]) as Array<{
      params: string[];
    }>;
    expect(retried).toHaveLength(1);
    expect(retried[0].params).toEqual(['hash-2']);
  });

  it('requestMany fails closed when every configured server loses the batch', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    for (const client of [first, second]) {
      client.connection.send.mockImplementationOnce((message: string) => {
        const parsed = JSON.parse(message) as Array<{ id: number }>;
        queueMicrotask(() => {
          for (const { id } of parsed) {
            client.requestResolvers[id]?.(new Error('Connection lost'));
          }
        });
        return true;
      });
    }
    const server = await loadServerWithMocks(
      [first, second],
      ['wss://dead-1.example:50004', 'wss://dead-2.example:50004']
    );

    await expect(
      server.requestMany([
        { method: 'blockchain.scripthash.listunspent', params: ['hash-1'] },
      ])
    ).rejects.toThrow(/connection lost/i);
  });

  it('subscribe and unsubscribe manage address subscriptions', async () => {
    const client = makeMockClient();
    const server = await loadServerWithMocks([client]);

    await server.subscribe('blockchain.address.subscribe', ['bitcoincash:q1']);
    await server.unsubscribe('blockchain.address.subscribe', ['bitcoincash:q1']);

    expect(client.subscribe).toHaveBeenCalledWith(
      'blockchain.address.subscribe',
      'bitcoincash:q1'
    );
    expect(client.request).toHaveBeenCalledWith(
      'blockchain.address.unsubscribe',
      'bitcoincash:q1'
    );
  });

  it('onNotification fans out notifications to registered handlers', async () => {
    const client = makeMockClient();
    const server = await loadServerWithMocks([client]);

    const handler = vi.fn();
    const dispose = server.onNotification(handler);

    // Trigger connect + notification wiring
    await server.request('blockchain.headers.get_tip');

    client.__emit('notification', {
      jsonrpc: '2.0',
      method: 'blockchain.headers.subscribe',
      params: [{ height: 123 }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'blockchain.headers.subscribe',
      params: [{ height: 123 }],
    });

    dispose();

    client.__emit('notification', {
      jsonrpc: '2.0',
      method: 'blockchain.headers.subscribe',
      params: [{ height: 124 }],
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('falls back to next server when the first connect attempt fails', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    first.connect.mockRejectedValueOnce(new Error('connect fail 1'));

    const server = await loadServerWithMocks(
      [first, second],
      ['wss://bad.example:50004', 'wss://good.example:50004']
    );

    await expect(server.request('blockchain.headers.get_tip')).resolves.toBe('ok');
    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(second.request).toHaveBeenCalledWith('blockchain.headers.get_tip');
  });

  it('enforces reconnect backoff after all servers fail', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    first.connect.mockRejectedValue(new Error('connect fail 1'));
    second.connect.mockRejectedValue(new Error('connect fail 2'));

    const server = await loadServerWithMocks(
      [first, second],
      ['wss://a.example:50004', 'wss://b.example:50004']
    );

    await expect(server.electrumConnect()).rejects.toThrow(
      'All Electrum servers failed to connect this round'
    );
    await expect(server.electrumConnect()).rejects.toThrow(
      'Electrum reconnect backoff in effect'
    );
  });

  it('resubscribes active subscriptions after reconnect', async () => {
    const first = makeMockClient();
    const second = makeMockClient();

    // First request after initial subscription fails to force reconnect
    first.request.mockRejectedValueOnce(new Error('drop'));
    second.request.mockResolvedValueOnce('recovered');

    const server = await loadServerWithMocks([first, second]);

    await server.subscribe('blockchain.address.subscribe', ['bitcoincash:q1']);
    await expect(server.request('blockchain.headers.get_tip')).resolves.toBe(
      'recovered'
    );

    expect(second.subscribe).toHaveBeenCalledWith(
      'blockchain.address.subscribe',
      'bitcoincash:q1'
    );
  });

  it('reconnect after request failure starts with the next server', async () => {
    const first = makeMockClient();
    const second = makeMockClient();

    first.request.mockRejectedValueOnce(new Error('socket dropped'));
    second.request.mockResolvedValueOnce('recovered');

    const { server, ElectrumWebSocket } = await loadServerWithMocksAndSpies(
      [first, second],
      ['wss://a.example:50004', 'wss://b.example:50004']
    );

    await expect(server.request('blockchain.headers.get_tip')).resolves.toBe(
      'recovered'
    );

    expect(ElectrumWebSocket).toHaveBeenCalledTimes(2);
    expect(ElectrumWebSocket.mock.calls[0][0]).toBe('a.example');
    expect(ElectrumWebSocket.mock.calls[1][0]).toBe('b.example');
  });

  it('parses a bare host:port server entry as an encrypted websocket endpoint', async () => {
    const client = makeMockClient();
    const { server, ElectrumWebSocket } = await loadServerWithMocksAndSpies(
      [client],
      ['fulcrum.example:50004']
    );

    await expect(server.request('server.ping')).resolves.toBe('ok');

    expect(ElectrumWebSocket).toHaveBeenCalledWith(
      'fulcrum.example',
      50004,
      true,
      expect.any(Number)
    );
  });

  it('request keeps the original error if reconnect also fails', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    first.request.mockRejectedValueOnce(new Error('socket dropped'));
    second.connect.mockRejectedValueOnce(new Error('reconnect failed'));

    const server = await loadServerWithMocks(
      [first, second],
      ['wss://a.example:50004', 'wss://b.example:50004']
    );

    await expect(server.request('blockchain.headers.get_tip')).rejects.toThrow(
      'socket dropped'
    );
    expect(second.request).not.toHaveBeenCalled();
  });

  it('skips explorer when it has recently failed and switches to imaginary.cash', async () => {
    const first = makeMockClient();
    const second = makeMockClient();
    const third = makeMockClient();

    first.request.mockRejectedValueOnce(new Error('socket dropped'));
    second.request.mockResolvedValueOnce('recovered');

    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });

    const { server, ElectrumWebSocket } = await loadServerWithMocksAndSpies(
      [first, second, third],
      [
        'wss://explorer.bch.ninja:50004',
        'wss://electrum.imaginary.cash:50004',
        'wss://bch.imaginary.cash:50004',
      ]
    );

    await expect(server.request('blockchain.headers.get_tip')).resolves.toBe(
      'recovered'
    );

    storage.set(
      'optn.electrum.last-healthy-server',
      'wss://explorer.bch.ninja:50004'
    );

    await expect(server.electrumReconnect()).resolves.toBeDefined();

    expect(ElectrumWebSocket).toHaveBeenCalledTimes(3);
    expect(ElectrumWebSocket.mock.calls[2][0]).toBe('electrum.imaginary.cash');
  });
});
