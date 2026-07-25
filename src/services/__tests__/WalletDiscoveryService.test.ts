import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveKeysMock = vi.fn();
const getWalletXpubsMock = vi.fn();
const createKeysMock = vi.fn();
const deriveBchAddressFromHdPublicKeyMock = vi.fn();

let storedDiscoveryState: string | null = null;

vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
    getWalletXpubs: getWalletXpubsMock,
    createKeys: createKeysMock,
  },
}));

vi.mock('../HdWalletService', () => ({
  deriveBchAddressFromHdPublicKey: deriveBchAddressFromHdPublicKeyMock,
}));

vi.mock('../../utils/browserStorage', () => ({
  getLocalStorage: vi.fn(() => ({})),
  readStorageItem: vi.fn(() => storedDiscoveryState),
  writeStorageItem: vi.fn((_storage, _key, value: string) => {
    storedDiscoveryState = value;
  }),
}));

describe('WalletDiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedDiscoveryState = null;
    retrieveKeysMock.mockResolvedValue([
      {
        address: 'bchtest:receive0',
        accountIndex: 0,
        changeIndex: 0,
        addressIndex: 0,
      },
    ]);
    getWalletXpubsMock.mockResolvedValue({
      receive: 'receive-xpub',
      change: 'change-xpub',
    });
    createKeysMock.mockResolvedValue(undefined);
    deriveBchAddressFromHdPublicKeyMock.mockImplementation(
      (_network, xpub: string, addressIndex: bigint) => ({
        address: `bchtest:${xpub === 'receive-xpub' ? 'receive' : 'change'}${addressIndex}`,
        tokenAddress: `bchtest:token${addressIndex}`,
        publicKey: new Uint8Array([1]),
        publicKeyHash: new Uint8Array([2]),
      })
    );
  });

  it('restores used HD addresses found beyond persisted keys', async () => {
    const batchHasUsage = vi.fn(
      async (
        _walletId: number,
        batch: { address: string; addressIndex: number }[]
      ) =>
        batch
          .filter(
            (candidate) =>
              candidate.addressIndex === 0 || candidate.addressIndex === 12
          )
          .map((candidate) => candidate.address)
    );
    const { default: WalletDiscoveryService } = await import(
      '../WalletDiscoveryService'
    );

    const recovered = await WalletDiscoveryService.ensureInitialAddressBatches(
      5,
      'chipnet' as never,
      batchHasUsage
    );

    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 0, 12);
    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 1, 12);
    expect(recovered).toEqual(
      expect.arrayContaining(['bchtest:receive12', 'bchtest:change12'])
    );
  });

  it('rescans from persisted keys instead of skipping a lost address with a stale cursor', async () => {
    storedDiscoveryState = JSON.stringify({
      5: {
        nextBatchStart: 30,
        consecutiveUnusedBatches: 1,
        lastDiscoveredAt: Date.now(),
        knownKeyCount: 4,
        highestKnownIndex: 12,
      },
    });
    const batchHasUsage = vi.fn(
      async (
        _walletId: number,
        batch: { address: string; addressIndex: number }[]
      ) =>
        batch
          .filter(
            (candidate) =>
              candidate.addressIndex === 0 || candidate.addressIndex === 12
          )
          .map((candidate) => candidate.address)
    );
    const { default: WalletDiscoveryService } = await import(
      '../WalletDiscoveryService'
    );

    await WalletDiscoveryService.ensureInitialAddressBatches(
      5,
      'chipnet' as never,
      batchHasUsage
    );

    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 0, 12);
  });

  it('continues across an unused batch left by failed Fusion rounds', async () => {
    const batchHasUsage = vi.fn(
      async (
        _walletId: number,
        batch: { address: string; addressIndex: number }[]
      ) =>
        batch
          .filter(
            (candidate) =>
              candidate.addressIndex === 0 || candidate.addressIndex === 22
          )
          .map((candidate) => candidate.address)
    );
    const { default: WalletDiscoveryService } = await import(
      '../WalletDiscoveryService'
    );

    await WalletDiscoveryService.ensureInitialAddressBatches(
      5,
      'chipnet' as never,
      batchHasUsage
    );

    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 0, 22);
  });
});
