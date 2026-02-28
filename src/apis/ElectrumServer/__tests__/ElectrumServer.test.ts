import { describe, expect, it, vi } from 'vitest';

type MockClient = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  __emit: (event: string, payload: unknown) => void;
};

function makeMockClient(): MockClient {
  const handlers = new Map<string, Array<(x: unknown) => void>>();
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    request: vi.fn(async () => 'ok'),
    subscribe: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (x: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    __emit: (event: string, payload: unknown) => {
      const list = handlers.get(event) ?? [];
      for (const cb of list) cb(payload);
    },
  };
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

  vi.doMock('../../../redux/store', () => ({
    store: {
      getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
    },
  }));

  vi.doMock('../../../redux/selectors/networkSelectors', () => ({
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

  vi.doMock('../../../redux/store', () => ({
    store: {
      getState: vi.fn(() => ({ network: { currentNetwork: 'mainnet' } })),
    },
  }));

  vi.doMock('../../../redux/selectors/networkSelectors', () => ({
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
});
