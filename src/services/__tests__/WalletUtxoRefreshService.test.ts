import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Network } from '../../state/slices/networkSlice';
import {
  cacheWalletUtxoSnapshot,
  clearCachedWalletUtxoSnapshot,
} from '../WalletUtxoSnapshotCache';

const getStateMock = vi.fn();
const retrieveKeysMock = vi.fn();
const bootstrapInitialAddressBatchMock = vi.fn();
const listTrackedAddressesMock = vi.fn();
const fetchAndStoreUTXOsManyMock = vi.fn();
const primeUTXOCacheMock = vi.fn();
const invalidateUTXOCacheMock = vi.fn();
const dispatchMock = vi.fn();
const runWalletUtxoRefreshMock = vi.fn(
  async (_walletId: number, task: () => Promise<unknown>) => await task()
);
const runWalletUtxoRefreshExclusiveMock = vi.fn(
  async (_walletId: number, task: () => Promise<unknown>) => await task()
);
const loadMultisigPolicyMock = vi.fn();
const listMultisigAddressInventoryMock = vi.fn();
const ensureMultisigAddressInventoryMock = vi.fn();

vi.mock('../../state/store', () => ({
  store: { getState: getStateMock, dispatch: dispatchMock },
}));

vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
    bootstrapInitialAddressBatch: bootstrapInitialAddressBatchMock,
  },
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
  runWalletUtxoRefreshExclusive: runWalletUtxoRefreshExclusiveMock,
}));

vi.mock('../multisig/MultisigStorageService', () => ({
  loadMultisigPolicy: loadMultisigPolicyMock,
  listMultisigAddressInventory: listMultisigAddressInventoryMock,
  ensureMultisigAddressInventory: ensureMultisigAddressInventoryMock,
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
    clearCachedWalletUtxoSnapshot();
    getStateMock.mockReturnValue({
      wallet_id: {
        currentWalletId: 6,
        sessionGeneration: 10,
        walletType: 'standard',
      },
    });
    retrieveKeysMock.mockResolvedValue([{ address: 'bchtest:qwallet6' }]);
    bootstrapInitialAddressBatchMock.mockResolvedValue(undefined);
    listTrackedAddressesMock.mockResolvedValue(['bchtest:pwallet6qr']);
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });
    runWalletUtxoRefreshMock.mockImplementation(
      async (_walletId: number, task: () => Promise<unknown>) => await task()
    );
    runWalletUtxoRefreshExclusiveMock.mockImplementation(
      async (_walletId: number, task: () => Promise<unknown>) => await task()
    );
    loadMultisigPolicyMock.mockResolvedValue({
      network: Network.CHIPNET,
    });
    listMultisigAddressInventoryMock.mockResolvedValue([
      {
        address: 'bchtest:qmultisig0',
        tokenAddress: 'bchtest:pMultisig0',
        branch: 0,
        index: 0,
      },
      {
        address: 'bchtest:qmultisig1',
        tokenAddress: 'bchtest:pMultisig1',
        branch: 1,
        index: 0,
      },
    ]);
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

  it('materializes standard wallet keys before a manual UTXO refresh', async () => {
    retrieveKeysMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ address: 'bchtest:qwallet6' }]);

    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await fetchActiveWalletUtxos(captureActiveWalletSession(6)!);

    expect(bootstrapInitialAddressBatchMock).toHaveBeenCalledWith(6, 0, 20);
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(
      6,
      ['bchtest:qwallet6', 'bchtest:pwallet6qr'],
      { discover: true, force: false, onProgress: undefined }
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

  it('preserves cached UTXOs for addresses omitted by a partial refresh', async () => {
    const cachedUtxo = {
      address: 'bchtest:qomitted',
      tx_hash: 'b'.repeat(64),
      tx_pos: 0,
      height: 1,
      value: 250_000,
    };
    cacheWalletUtxoSnapshot(6, {
      'bchtest:qomitted': [cachedUtxo],
    });
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qwallet6': [],
    });

    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await expect(
      fetchActiveWalletUtxos(captureActiveWalletSession(6)!, undefined, {
        discover: false,
      })
    ).resolves.toEqual({
      'bchtest:qomitted': [cachedUtxo],
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });
  });

  it('does not overwrite overlapping cached UTXOs during a narrower refresh', async () => {
    const cachedUtxo = {
      address: 'bchtest:qwallet6',
      tx_hash: 'd'.repeat(64),
      tx_pos: 0,
      height: 1,
      value: 300_000,
    };
    cacheWalletUtxoSnapshot(6, {
      'bchtest:qwallet6': [cachedUtxo],
      'bchtest:qomitted': [],
      'bchtest:qthird': [],
    });
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qwallet6': [],
      'bchtest:pwallet6qr': [],
    });

    const { captureActiveWalletSession, fetchActiveWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await expect(
      fetchActiveWalletUtxos(captureActiveWalletSession(6)!, undefined, {
        discover: false,
      })
    ).resolves.toMatchObject({
      'bchtest:qwallet6': [cachedUtxo],
    });
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

  it('refreshes a route-scoped multisig inventory without requiring the active wallet', async () => {
    fetchAndStoreUTXOsManyMock.mockResolvedValue({
      'bchtest:qmultisig0': [
        {
          address: 'bchtest:qmultisig0',
          tx_hash: 'c'.repeat(64),
          tx_pos: 0,
          height: 0,
          value: 123_000,
        },
      ],
      'bchtest:qmultisig1': [],
    });
    const { refreshMultisigWalletUtxos } = await import(
      '../WalletUtxoRefreshService'
    );

    await expect(refreshMultisigWalletUtxos(42)).resolves.toEqual({
      'bchtest:qmultisig0': expect.any(Array),
      'bchtest:qmultisig1': [],
    });
    expect(runWalletUtxoRefreshExclusiveMock).toHaveBeenCalledWith(
      42,
      expect.any(Function)
    );
    expect(fetchAndStoreUTXOsManyMock).toHaveBeenCalledWith(
      42,
      ['bchtest:qmultisig0', 'bchtest:qmultisig1'],
      {
        discover: false,
        force: true,
        network: Network.CHIPNET,
        chainAuthoritative: true,
      }
    );
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
