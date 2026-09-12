import { beforeEach, describe, expect, it, vi } from 'vitest';

// The router's whole job here is to keep a cross-network address off the wire,
// so the upstream spies double as the assertion: if a bitcoincash: address on
// chipnet reaches any of them, the guard has regressed.
const upstreamRequest = vi.fn();
const upstreamRequestMany = vi.fn();
const upstreamSubscribe = vi.fn();
const upstreamSubscribeMany = vi.fn();
const upstreamEnsureFresh = vi.fn();
const upstreamDisconnect = vi.fn();
const upstreamGetCurrentServer = vi.fn();

vi.mock('../../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(() => ({
    request: upstreamRequest,
    requestMany: upstreamRequestMany,
    subscribe: upstreamSubscribe,
    subscribeMany: upstreamSubscribeMany,
    unsubscribe: vi.fn(),
    ensureFreshConnection: upstreamEnsureFresh,
    electrumDisconnect: upstreamDisconnect,
    getCurrentServer: upstreamGetCurrentServer,
  })),
}));

let currentNetwork = 'chipnet';
let currentWallet = 1;
let backend: { kind: string; target?: string } = { kind: 'auto' };
vi.mock('../../../state/store', () => ({
  store: { getState: vi.fn(() => ({})) },
}));
vi.mock('../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: vi.fn(() => currentNetwork),
}));
vi.mock('../../../state/slices/walletSlice', () => ({
  selectWalletId: vi.fn(() => currentWallet),
}));
// Electrum pool path — never the pinned-node path, so the guard is what's under test.
vi.mock('../backendSelection', () => ({
  getBackend: vi.fn(() => backend),
}));
vi.mock('../Bip37Backend', () => ({
  nodeSync: vi.fn(),
  nodeBroadcast: vi.fn(),
}));
vi.mock('../../../utils/servers/userNodes', () => ({
  parseNodeTarget: vi.fn(),
}));
vi.mock('../../../utils/servers/ElectrumServers', () => ({
  getElectrumServers: vi.fn((network: string) =>
    network === 'mainnet' ? ['mainnet.example.com'] : ['chipnet.example.com']
  ),
}));

const MAINNET_ADDR = 'bitcoincash:qp7upv0ja5plgmzgjxpl6mqams6emhnc0ylkdsj3gn';
const CHIPNET_ADDR = 'bchtest:qq6a228gundm2rywwxka9rxppraplvtjjcywpep3av';

describe('ElectrumServerRouter cross-network address guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentNetwork = 'chipnet';
    currentWallet = 1;
    backend = { kind: 'auto' };
    upstreamRequest.mockResolvedValue([]);
    upstreamRequestMany.mockImplementation(async (calls: unknown[]) =>
      calls.map(() => [])
    );
    upstreamSubscribe.mockResolvedValue(undefined);
    upstreamEnsureFresh.mockResolvedValue(undefined);
    upstreamDisconnect.mockResolvedValue(true);
    upstreamGetCurrentServer.mockReturnValue(null);
  });

  it('does not share an in-flight node scan across wallets', async () => {
    backend = { kind: 'node', target: 'selected-node:48333' };
    const { nodeSync } = await import('../Bip37Backend');
    const { parseNodeTarget } = await import(
      '../../../utils/servers/userNodes'
    );
    vi.mocked(parseNodeTarget).mockReturnValue({
      host: 'selected-node',
      port: 48333,
    });
    const empty = {
      byAddress: new Map(),
      totalSats: 0,
      tipHash: null,
      scannedBlocks: 0,
      watchedAddresses: 0,
    };
    let release!: () => void;
    vi.mocked(nodeSync)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(empty);
          })
      )
      .mockResolvedValue(empty);
    const { default: ElectrumServer, invalidateNodeScan } = await import(
      '../ElectrumServerRouter'
    );
    invalidateNodeScan();
    const first = ElectrumServer().request(
      'blockchain.address.listunspent',
      CHIPNET_ADDR
    );
    await vi.waitFor(() => expect(nodeSync).toHaveBeenCalledTimes(1));
    currentWallet = 2;
    const second = ElectrumServer().request(
      'blockchain.address.listunspent',
      CHIPNET_ADDR
    );
    await vi.waitFor(() => expect(nodeSync).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
    expect(nodeSync).toHaveBeenNthCalledWith(
      1,
      'selected-node',
      48333,
      'chipnet',
      1
    );
    expect(nodeSync).toHaveBeenNthCalledWith(
      2,
      'selected-node',
      48333,
      'chipnet',
      2
    );
    invalidateNodeScan();
  });

  it('never falls back to Electrum for node-mode RPA, candidate inputs or subscriptions', async () => {
    backend = { kind: 'node', target: 'selected-node:48333' };
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    const server = ElectrumServer();
    await server.ensureFreshConnection();
    await expect(server.electrumConnect()).rejects.toThrow(/does not open/);
    await expect(server.electrumReconnect()).rejects.toThrow(/does not open/);
    expect(upstreamEnsureFresh).not.toHaveBeenCalled();
    for (const method of [
      'blockchain.rpa.get_history',
      'blockchain.transaction.get',
      'blockchain.address.get_history',
    ]) {
      await expect(
        server.request(method, 'private-wallet-query')
      ).rejects.toThrow(/fallback is disabled/);
    }
    await expect(
      server.subscribe('blockchain.address.subscribe', [CHIPNET_ADDR])
    ).rejects.toThrow(/does not register/);
    await expect(
      server.subscribeMany('blockchain.address.subscribe', [[CHIPNET_ADDR]])
    ).rejects.toThrow(/does not register/);
    const result = await server.requestMany([
      { method: 'blockchain.transaction.get', params: ['candidate-input'] },
    ]);
    expect(result[0]).toBeInstanceOf(Error);
    expect(upstreamRequest).not.toHaveBeenCalled();
    expect(upstreamRequestMany).not.toHaveBeenCalled();
    expect(upstreamSubscribe).not.toHaveBeenCalled();
    expect(upstreamSubscribeMany).not.toHaveBeenCalled();
  });

  it('rejects a mainnet address on chipnet without hitting the server', async () => {
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await expect(
      ElectrumServer().request('blockchain.address.listunspent', MAINNET_ADDR)
    ).rejects.toThrow(/network guard/);
    expect(upstreamRequest).not.toHaveBeenCalled();
  });

  it('lets a matching address through', async () => {
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await ElectrumServer().request(
      'blockchain.address.listunspent',
      CHIPNET_ADDR
    );
    expect(upstreamRequest).toHaveBeenCalledOnce();
  });

  // The registry case: a bad address that reaches subscribe() is replayed on
  // every reconnect, so it must never be registered in the first place.
  it('never registers a cross-network subscription', async () => {
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await expect(
      ElectrumServer().subscribe('blockchain.address.subscribe', [MAINNET_ADDR])
    ).rejects.toThrow(/network guard/);
    expect(upstreamSubscribe).not.toHaveBeenCalled();
  });

  it('drops only the offender from a batch and keeps results index-aligned', async () => {
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    upstreamRequestMany.mockResolvedValue([['ok-chip']]);

    const results = await ElectrumServer().requestMany([
      { method: 'blockchain.address.listunspent', params: [MAINNET_ADDR] },
      { method: 'blockchain.address.listunspent', params: [CHIPNET_ADDR] },
    ]);

    // Only the valid call is forwarded — one bad entry must not sink the batch.
    expect(upstreamRequestMany).toHaveBeenCalledWith([
      { method: 'blockchain.address.listunspent', params: [CHIPNET_ADDR] },
    ]);
    expect(results[0]).toBeInstanceOf(Error);
    expect(results[1]).toEqual(['ok-chip']);
  });

  it('ignores non-address methods (a txid is not an address)', async () => {
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await ElectrumServer().request(
      'blockchain.transaction.get',
      'c0d0ad1a117fda4e'
    );
    expect(upstreamRequest).toHaveBeenCalledOnce();
  });

  it('applies symmetrically: a chipnet address on mainnet is rejected too', async () => {
    currentNetwork = 'mainnet';
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await expect(
      ElectrumServer().request('blockchain.address.listunspent', CHIPNET_ADDR)
    ).rejects.toThrow(/network guard/);
    expect(upstreamRequest).not.toHaveBeenCalled();
  });

  it('drops a mainnet socket before chipnet listunspent so balance is not permanently 0', async () => {
    // Live host from a prior mainnet wallet; menu lock did not disconnect.
    upstreamGetCurrentServer.mockReturnValue('mainnet.example.com');
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await ElectrumServer().request(
      'blockchain.address.listunspent',
      CHIPNET_ADDR
    );
    expect(upstreamDisconnect).toHaveBeenCalledOnce();
    expect(upstreamRequest).toHaveBeenCalledOnce();
  });

  it('keeps the socket when it already belongs to the current network pool', async () => {
    upstreamGetCurrentServer.mockReturnValue('chipnet.example.com');
    const { default: ElectrumServer } = await import('../ElectrumServerRouter');
    await ElectrumServer().ensureFreshConnection();
    expect(upstreamDisconnect).not.toHaveBeenCalled();
    expect(upstreamEnsureFresh).toHaveBeenCalledOnce();
  });
});
