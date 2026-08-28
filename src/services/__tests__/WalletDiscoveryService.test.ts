import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveKeysMock = vi.fn();
const getWalletXpubsMock = vi.fn();
const createKeysMock = vi.fn();
const deriveBchAddressFromHdPublicKeyMock = vi.fn();
const isDesktopPlatformMock = vi.fn(() => true);

let storedDiscoveryState: string | null = null;

vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
    getWalletXpubs: getWalletXpubsMock,
    createKeys: createKeysMock,
  },
}));

vi.mock('../HdWalletService', () => ({
  BCH_STANDARD_BRANCH_INDEX: {
    receive: 0,
    change: 1,
    defi: 7,
    rpa: 3,
  },
  BCH_WALLET_SCAN_BRANCH_NAMES: ['receive', 'change', 'defi'],
  deriveBchAddressFromHdPublicKey: deriveBchAddressFromHdPublicKeyMock,
}));

vi.mock('../../utils/browserStorage', () => ({
  getLocalStorage: vi.fn(() => ({})),
  readStorageItem: vi.fn(() => storedDiscoveryState),
  writeStorageItem: vi.fn((_storage, _key, value: string) => {
    storedDiscoveryState = value;
  }),
}));

vi.mock('../../utils/platform', () => ({
  isDesktopPlatform: isDesktopPlatformMock,
}));

vi.mock('../multisig/MultisigStorageService', () => ({
  loadMultisigPolicy: vi.fn(async () => null),
  ensureMultisigAddressInventory: vi.fn(async () => undefined),
}));

describe('WalletDiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDesktopPlatformMock.mockReturnValue(true);
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
      defi: 'defi-xpub',
      rpa: 'rpa-xpub',
    });
    createKeysMock.mockResolvedValue(undefined);
    deriveBchAddressFromHdPublicKeyMock.mockImplementation(
      (_network, xpub: string, addressIndex: bigint) => ({
        address: `bchtest:${xpub.replace('-xpub', '')}${addressIndex}`,
        tokenAddress: `bchtest:token${addressIndex}`,
        publicKey: new Uint8Array([1]),
        publicKeyHash: new Uint8Array([2]),
      })
    );
  });

  it('limits mobile restore discovery to standard wallet branches', async () => {
    isDesktopPlatformMock.mockReturnValue(false);
    const batchHasUsage = vi.fn(async () => []);
    const { default: WalletDiscoveryService } = await import(
      '../WalletDiscoveryService'
    );

    await WalletDiscoveryService.ensureInitialAddressBatches(
      5,
      'chipnet' as never,
      batchHasUsage
    );

    expect(batchHasUsage.mock.calls[0][1]).toHaveLength(40);
    expect(
      new Set(
        batchHasUsage.mock.calls[0][1].map(
          (candidate: { changeIndex: number }) => candidate.changeIndex
        )
      )
    ).toEqual(new Set([0, 1]));
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

    expect(batchHasUsage.mock.calls[0][1]).toHaveLength(60);
    expect(batchHasUsage.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ addressIndex: 0, changeIndex: 0 }),
      ])
    );
    expect(
      new Set(
        batchHasUsage.mock.calls[0][1].map(
          (candidate: { changeIndex: number }) => candidate.changeIndex
        )
      )
    ).toEqual(new Set([0, 1, 7]));
    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 0, 12);
  });

  it('persists a used Cauldron branch address on branch 7', async () => {
    const batchHasUsage = vi.fn(
      async (
        _walletId: number,
        batch: { address: string; addressIndex: number; changeIndex: number }[]
      ) =>
        batch
          .filter(
            (candidate) =>
              candidate.addressIndex === 5 && candidate.changeIndex === 7
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

    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 7, 5);
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

  it('keeps its forward cursor across empty batches for cross-device Fusion recovery', async () => {
    const batchHasUsage = vi.fn(
      async (
        _walletId: number,
        batch: { address: string; addressIndex: number }[]
      ) =>
        batch
          .filter((candidate) => candidate.addressIndex === 102)
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

    // Four batches are the per-pass budget, so the first pass reaches but does
    // not include index 102. The persisted cursor must allow a later pass to
    // continue instead of restarting at index 0 and stopping at the first gap.
    expect(createKeysMock).not.toHaveBeenCalledWith(5, 0, 0, 102);

    const persisted = JSON.parse(storedDiscoveryState ?? '{}') as Record<
      string,
      { lastDiscoveredAt: number }
    >;
    persisted['5'].lastDiscoveredAt = 0;
    storedDiscoveryState = JSON.stringify(persisted);

    await WalletDiscoveryService.ensureInitialAddressBatches(
      5,
      'chipnet' as never,
      batchHasUsage
    );

    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 0, 102);
    expect(createKeysMock).toHaveBeenCalledWith(5, 0, 1, 102);
  });
});
