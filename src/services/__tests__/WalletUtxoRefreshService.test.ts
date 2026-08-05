import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const primeUTXOCacheMock = vi.fn();
const invalidateUTXOCacheMock = vi.fn();
const dispatchMock = vi.fn();
const runWalletUtxoRefreshMock = vi.fn(
  async (_walletId: number, task: () => Promise<unknown>) => await task()
);

vi.mock('../../state/store', () => ({
  store: { getState: getStateMock, dispatch: dispatchMock },
}));

vi.mock('../KeyService', () => ({
  default: { retrieveKeys: retrieveKeysMock },
}));

vi.mock('../QuantumrootTrackingService', () => ({
  default: { listTrackedAddresses: listTrackedAddressesMock },
}));

vi.mock('../UTXOService', () => ({
  default: { fetchAndStoreUTXOsMany: fetchAndStoreUTXOsManyMock },
}));

vi.mock('../ElectrumService', () => ({
  primeUTXOCache: primeUTXOCacheMock,
  invalidateUTXOCache: invalidateUTXOCacheMock,
}));

vi.mock('../RefreshCoordinator', () => ({
  runWalletUtxoRefresh: runWalletUtxoRefreshMock,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fetchActiveWalletUtxos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 6, sessionGeneration: 10 },
    });
    retrieveKeysMock.mockResolvedValue([{ address: 'bchtest:qwallet6' }]);
    listTrackedAddressesMock.mockResolvedValue(['bchtest:pwallet6qr']);
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });
    runWalletUtxoRefreshMock.mockImplementation(
      async (_walletId: number, task: () => Promise<unknown>) => await task()
    );
  });

  it('fetches only addresses owned or tracked by the requested wallet', async () => {
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );
    const session = captureActiveWalletSession(6);

    const result = await fetchActiveWalletUtxos(session!);

    expect(retrieveKeysMock).toHaveBeenCalledWith(6);
    expect(listTrackedAddressesMock).toHaveBeenCalledWith(6);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(
      6,
      ['bchtest:qwallet6', 'bchtest:pwallet6qr'],
      { discover: true, force: false, onProgress: undefined }
    );
    expect(result).toEqual({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });
  });

  it('can skip rediscovery for manual Home Sync', async () => {
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await fetchActiveWalletUtxos(captureActiveWalletSession(6)!, undefined, {
      discover: false,
    });

    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(
      6,
      ['bchtest:qwallet6', 'bchtest:pwallet6qr'],
      { discover: false, force: false, onProgress: undefined }
    );
  });

  it('invalidates every address before fetching a fresh wallet snapshot', async () => {
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await fetchActiveWalletUtxos(captureActiveWalletSession(6)!);

    expect(invalidateUTXOCacheMock.mock.calls).toEqual([
      ['bchtest:qwallet6'],
      ['bchtest:pwallet6qr'],
    ]);
    expect(
      invalidateUTXOCacheMock.mock.invocationCallOrder.at(-1)
    ).toBeLessThan(fetchAndStoreUTXOsManyMock.mock.invocationCallOrder[0]);
  });

  it('includes addresses recovered during the same discovery refresh', async () => {
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
      'bchtest:qrecovered': [
        {
          address: 'bchtest:qrecovered',
          tx_hash: 'a'.repeat(64),
          tx_pos: 0,
          height: 1,
          value: 125_000,
        },
      ],
    });
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    const result = await fetchActiveWalletUtxos(captureActiveWalletSession(6)!);

    expect(result).toHaveProperty('bchtest:qrecovered');
    expect(primeUTXOCacheMock).toHaveBeenCalledWith(
      'bchtest:qrecovered',
      expect.any(Array)
    );
  });

  it('discards a result after closing and reopening the same wallet', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValue(fetchGate.promise);
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );
    const session = captureActiveWalletSession(6);

    const refreshPromise = fetchActiveWalletUtxos(session!);
    for (
      let i = 0;
      i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 6, sessionGeneration: 12 },
    });
    fetchGate.resolve({ 'bchtest:qwallet6': [] });

    await expect(refreshPromise).resolves.toBeNull();
    expect(primeUTXOCacheMock).not.toHaveBeenCalled();
  });

  it('returns promptly and never commits when an in-flight refresh is cancelled', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValue(fetchGate.promise);
    const { reconcileActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );
    const controller = new AbortController();

    const refreshPromise = reconcileActiveWalletUtxos(6, controller.signal);
    for (
      let i = 0;
      i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(refreshPromise).resolves.toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();

    fetchGate.resolve({ 'bchtest:qwallet6': [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('publishes a completed refresh to the active wallet state', async () => {
    const { refreshActiveWalletUtxos, subscribeWalletUtxoRefresh } =
      await import('../WalletUtxoRefreshService');
    const listener = vi.fn();
    const unsubscribe = subscribeWalletUtxoRefresh(listener);

    await expect(refreshActiveWalletUtxos(6)).resolves.toBe(true);

    expect(dispatchMock).toHaveBeenCalledWith({
      type: 'utxos/replaceAllUTXOs',
      payload: {
        utxosByAddress: {
          'bchtest:qwallet6': [],
          'bchtest:pwallet6qr': [],
        },
      },
    });
    expect(listener).toHaveBeenCalledWith(6, {
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });

    unsubscribe();
    await refreshActiveWalletUtxos(6);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects a joined older refresh so the caller can schedule a trailing fetch', async () => {
    runWalletUtxoRefreshMock.mockResolvedValue({
      'bchtest:qwallet6': [],
    });
    const { reconcileActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await expect(reconcileActiveWalletUtxos(6)).resolves.toBeNull();

    expect(fetchAndStoreUTXOsManyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('turns a rejected joined refresh into a trailing-refresh signal', async () => {
    runWalletUtxoRefreshMock.mockRejectedValue(
      new Error('older refresh failed')
    );
    const { reconcileActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await expect(reconcileActiveWalletUtxos(6)).resolves.toBeNull();

    expect(fetchAndStoreUTXOsManyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
