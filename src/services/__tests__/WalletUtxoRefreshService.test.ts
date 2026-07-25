import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const primeUTXOCacheMock = vi.fn();
const dispatchMock = vi.fn();

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
}));

vi.mock('../RefreshCoordinator', () => ({
  runWalletUtxoRefresh: vi.fn(
    async (_walletId: number, task: () => Promise<unknown>) => await task()
  ),
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
  });

  it('fetches only addresses owned or tracked by the requested wallet', async () => {
    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );
    const session = captureActiveWalletSession(6);

    const result = await fetchActiveWalletUtxos(session!);

    expect(retrieveKeysMock).toHaveBeenCalledWith(6);
    expect(listTrackedAddressesMock).toHaveBeenCalledWith(6);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(6, [
      'bchtest:qwallet6',
      'bchtest:pwallet6qr',
    ]);
    expect(result).toEqual({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });
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

    const result = await fetchActiveWalletUtxos(
      captureActiveWalletSession(6)!
    );

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

  it('publishes a completed refresh to the active wallet state', async () => {
    const { refreshActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

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
  });
});
