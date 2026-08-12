import { beforeEach, describe, expect, it, vi } from 'vitest';

import WalletDiscoveryService from '../WalletDiscoveryService';
import KeyService from '../KeyService';

const { getWalletXpubsMock, retrieveKeysMock, deriveBchAddressFromHdPublicKeyMock } =
  vi.hoisted(() => ({
    getWalletXpubsMock: vi.fn(),
    retrieveKeysMock: vi.fn(),
    deriveBchAddressFromHdPublicKeyMock: vi.fn((_, __, index) => ({
      address: `addr-${index.toString()}`,
      tokenAddress: `token-${index.toString()}`,
      publicKey: new Uint8Array([1]),
      publicKeyHash: new Uint8Array([2]),
    })),
  }));

vi.mock('../KeyService', () => ({
  default: {
    getWalletXpubs: getWalletXpubsMock,
    retrieveKeys: retrieveKeysMock,
  },
}));

vi.mock('../HdWalletService', () => ({
  deriveBchAddressFromHdPublicKey: deriveBchAddressFromHdPublicKeyMock,
}));

describe('WalletDiscoveryService', () => {
  const mockedKeyService = vi.mocked(KeyService);

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.localStorage?.clear();

    mockedKeyService.getWalletXpubs.mockResolvedValue({
      receive: 'xpub-receive',
      change: 'xpub-change',
      defi: 'xpub-defi',
    } as never);
    mockedKeyService.retrieveKeys.mockResolvedValue([] as never);
  });

  it('probes address batches without creating stored keys', async () => {
    const seenAddresses = new Set<string>();

    const batchHasUsage = async (
      _walletId: number,
      batch: { address: string; addressIndex: number; changeIndex: number }[]
    ) => {
      batch.forEach((entry) => seenAddresses.add(entry.address));
      return batch.some((entry) => entry.addressIndex < 10);
    };

    await WalletDiscoveryService.ensureInitialAddressBatches(
      1,
      'mainnet' as never,
      batchHasUsage
    );

    expect(mockedKeyService.retrieveKeys).toHaveBeenCalledWith(1);
    expect(mockedKeyService.getWalletXpubs).toHaveBeenCalledWith(1, 0);
    expect(deriveBchAddressFromHdPublicKeyMock).toHaveBeenCalled();
    expect(seenAddresses.size).toBeGreaterThan(0);
  });

  it('caches discovery state and skips immediate reruns', async () => {
    const batchHasUsage = vi.fn(async () => false);

    await WalletDiscoveryService.ensureInitialAddressBatches(
      2,
      'mainnet' as never,
      batchHasUsage
    );
    await WalletDiscoveryService.ensureInitialAddressBatches(
      2,
      'mainnet' as never,
      batchHasUsage
    );

    expect(batchHasUsage).toHaveBeenCalled();
    expect(batchHasUsage.mock.calls.length).toBeGreaterThan(0);
  });
});
