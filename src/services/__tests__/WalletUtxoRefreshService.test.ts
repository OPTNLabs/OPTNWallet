import { beforeEach, describe, expect, it, vi } from 'vitest';

const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const primeUTXOCacheMock = vi.fn();

vi.mock('../../state/store', () => ({
  store: { getState: getStateMock },
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
    const { captureActiveWalletSession, fetchActiveWalletUtxos } =
      await import('../WalletUtxoRefreshService');
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

  it('discards a result after closing and reopening the same wallet', async () => {
    const fetchGate = deferred<Record<string, never[]>>();
    fetchAndStoreUTXOsManyMock.mockReturnValue(fetchGate.promise);
    const { captureActiveWalletSession, fetchActiveWalletUtxos } =
      await import('../WalletUtxoRefreshService');
    const session = captureActiveWalletSession(6);

    const refreshPromise = fetchActiveWalletUtxos(session!);
    for (let i = 0; i < 20 && fetchAndStoreUTXOsManyMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    getStateMock.mockReturnValue({
      wallet_id: { currentWalletId: 6, sessionGeneration: 12 },
    });
    fetchGate.resolve({ 'bchtest:qwallet6': [] });

    await expect(refreshPromise).resolves.toBeNull();
    expect(primeUTXOCacheMock).not.toHaveBeenCalled();
  });
});
