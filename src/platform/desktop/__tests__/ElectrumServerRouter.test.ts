import { beforeEach, describe, expect, it, vi } from 'vitest';

// The router's whole job here is to keep a cross-network address off the wire,
// so the upstream spies double as the assertion: if a bitcoincash: address on
// chipnet reaches any of them, the guard has regressed.
const upstreamRequest = vi.fn();
const upstreamRequestMany = vi.fn();
const upstreamSubscribe = vi.fn();
const upstreamEnsureFresh = vi.fn();
const upstreamDisconnect = vi.fn();
const upstreamGetCurrentServer = vi.fn();

vi.mock('../../../apis/ElectrumServer/ElectrumServer', () => ({
  default: vi.fn(() => ({
    request: upstreamRequest,
    requestMany: upstreamRequestMany,
    subscribe: upstreamSubscribe,
    unsubscribe: vi.fn(),
    ensureFreshConnection: upstreamEnsureFresh,
    electrumDisconnect: upstreamDisconnect,
    getCurrentServer: upstreamGetCurrentServer,
  })),
}));

let currentNetwork = 'chipnet';
vi.mock('../../../state/store', () => ({
  store: { getState: vi.fn(() => ({})) },
}));
vi.mock('../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: vi.fn(() => currentNetwork),
}));
vi.mock('../../../state/slices/walletSlice', () => ({
  selectWalletId: vi.fn(() => 1),
}));
// Electrum pool path — never the pinned-node path, so the guard is what's under test.
vi.mock('../backendSelection', () => ({
  getBackend: vi.fn(() => ({ kind: 'auto' })),
}));
vi.mock('../Bip37Backend', () => ({ nodeSync: vi.fn(), nodeBroadcast: vi.fn() }));
vi.mock('../../../utils/servers/userNodes', () => ({ parseNodeTarget: vi.fn() }));
vi.mock('../../../utils/servers/ElectrumServers', () => ({
  getElectrumServers: vi.fn((network: string) =>
    network === 'mainnet'
      ? ['mainnet.example.com']
      : ['chipnet.example.com']
  ),
}));

const MAINNET_ADDR = 'bitcoincash:qp7upv0ja5plgmzgjxpl6mqams6emhnc0ylkdsj3gn';
const CHIPNET_ADDR = 'bchtest:qq6a228gundm2rywwxka9rxppraplvtjjcywpep3av';

describe('ElectrumServerRouter cross-network address guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentNetwork = 'chipnet';
    upstreamRequest.mockResolvedValue([]);
    upstreamRequestMany.mockImplementation(async (calls: unknown[]) => calls.map(() => []));
    upstreamSubscribe.mockResolvedValue(undefined);
    upstreamEnsureFresh.mockResolvedValue(undefined);
    upstreamDisconnect.mockResolvedValue(true);
    upstreamGetCurrentServer.mockReturnValue(null);
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
    await ElectrumServer().request('blockchain.address.listunspent', CHIPNET_ADDR);
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
    await ElectrumServer().request('blockchain.transaction.get', 'c0d0ad1a117fda4e');
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
